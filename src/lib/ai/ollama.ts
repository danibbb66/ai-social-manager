import {
  AiChatOptions,
  AiChatMessage,
  AiCompletion,
  AiModelInfo,
  AiPingResult,
  AiProvider,
  AiUnavailableError,
} from "@/lib/ai/provider";
import { config } from "@/lib/env";
import { logAIError } from "@/lib/logger";

interface OllamaChatRequest {
  model: string;
  messages: { role: string; content: string; name?: string }[];
  stream?: boolean;
  format?: "json" | Record<string, unknown>;
  /**
   * qwen3 è un modello ibrido: con reasoning attivo riversa l'analisi nel
   * campo `thinking` (che l'applicazione non usa) e lascia `content` quasi
   * vuoto, spesso `{}`. Per questo agente ragioniamo senza thinking.
   */
  think?: boolean;
  /**
   * Opzioni passate a llama.cpp. `num_ctx` e `num_predict` hanno default
   * applicativi (`config.ollamaNumCtx` / `config.ollamaNumPredict`): senza un
   * contesto sufficiente il prompt dell'agente verrebbe troncato dal più
   * vecchio, cioè dalle regole in testa al system prompt.
   */
  options?: { temperature?: number; num_ctx?: number; num_predict?: number };
}

/**
 * Envelope unico dell'agente, in JSON Schema per il decoding strutturato.
 *
 * Vincola il nome del tool all'elenco reale e gli argomenti allo schema del
 * singolo tool: il modello non può più inventare `action`, `params`,
 * `response` o chiavi non previste, e `content` non può più collassare su `{}`.
 */
export function buildAgentEnvelopeSchema(
  variants: { name: string; arguments: Record<string, unknown> }[]
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "Testo in italiano per l'utente. Può essere vuoto solo se stai eseguendo un tool.",
      },
      tool_calls: {
        type: "array",
        description:
          "Tool da eseguire. Array vuoto se non devi eseguire operazioni.",
        items: {
          oneOf: variants.map((v) => ({
            type: "object",
            properties: {
              name: { enum: [v.name] },
              arguments: v.arguments,
            },
            required: ["name", "arguments"],
            additionalProperties: false,
          })),
        },
      },
    },
    required: ["message", "tool_calls"],
    additionalProperties: false,
  };
}

interface OllamaTag {
  name: string;
  size?: number;
  modified_at?: string;
}

function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  t.unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(t),
  };
}

/**
 * Perché una richiesta è stata abortita dal watchdog.
 *
 * `idle` = Ollama non ha prodotto nulla per il timeout di inattività (il caso
 * tipico è il primo token che non arriva mai, o uno stream morto a metà).
 * `total` = tetto totale della richiesta superato.
 */
type WatchdogReason = "idle" | "total";

/**
 * Watchdog a doppio orologio per una richiesta streaming.
 *
 * Il vecchio timeout unico abortiva la richiesta a un tempo fisso dal via: con
 * un modello 8B lento a produrre il primo token andava bene, ma una generazione
 * lunga e vena veniva tagliata a metà anche se i token continuavano ad arrivare.
 * Qui l'orologio di inattività viene riarato a ogni pacchetto ricevuto
 * (`touch()`), quindi la generazione prosegue finché Ollama produce; il tetto
 * totale resta come rete di sicurezza contro stream infiniti.
 */
class StreamWatchdog {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly idleMsValue: number;
  private readonly totalMsValue: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private abortReason: WatchdogReason | null = null;

  constructor(idleMs: number, totalMs: number) {
    this.idleMsValue = idleMs;
    this.totalMsValue = totalMs;
    this.totalTimer = this.armTimer(totalMs, "total");
    this.idleTimer = this.armTimer(idleMs, "idle");
    this.signal = this.controller.signal;
  }

  private armTimer(ms: number, reason: WatchdogReason) {
    const timer = setTimeout(() => this.abort(reason), ms);
    // Il timer non deve tenere vivo il processo solo per sé.
    timer.unref?.();
    return timer;
  }

  private abort(reason: WatchdogReason) {
    // Il primo motivo vince: dopo l'abort i timer residui non contano.
    if (this.abortReason) return;
    this.abortReason = reason;
    this.controller.abort();
  }

  /** Un pacchetto è arrivato: il modello è vivo, si riarma l'inattività. */
  touch() {
    if (this.abortReason) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = this.armTimer(this.idleMs, "idle");
  }

  get reason(): WatchdogReason | null {
    return this.abortReason;
  }

  get idleMs(): number {
    return this.idleMsValue;
  }

  get totalMs(): number {
    return this.totalMsValue;
  }

  clear() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.idleTimer = null;
    this.totalTimer = null;
  }
}

function isAbortError(e: unknown): boolean {
  // Niente `instanceof Error`: in Node il fetch di undici rifiuta con una
  // DOMException ("AbortError"), che NON è un instanceof Error. Sbagliare qui
  // trasformava un timeout in un falso "connessione interrotta".
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  readonly baseUrl: string;
  readonly model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl ?? config.ollamaBaseUrl).replace(/\/+$/, "");
    this.model = model ?? config.ollamaModel;
  }

  private async requestRaw(
    path: string,
    init?: RequestInit
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new AiUnavailableError(
        `Ollama non raggiungibile su ${this.baseUrl}. Avvia il servizio con "ollama serve".`,
        { cause: e }
      );
    }
  }

  async ping(): Promise<AiPingResult> {
    let res: Response;
    const t = timeoutSignal(4000);
    try {
      res = await this.requestRaw("/api/tags", {
        signal: t.signal,
      });
    } catch {
      t.clear();
      return {
        ok: false,
        provider: this.name,
        model: this.model,
        availableModels: [],
        message: "Ollama non raggiungibile",
      };
    }
    t.clear();

    if (!res.ok) {
      return {
        ok: false,
        provider: this.name,
        model: this.model,
        availableModels: [],
        message: `Risposta Ollama non valida (${res.status})`,
      };
    }

    const data = (await res.json()) as { models: OllamaTag[] };
    const availableModels: AiModelInfo[] = (data.models ?? []).map((m) => ({
      name: m.name,
      size: m.size ?? 0,
      modifiedAt: m.modified_at ? new Date(m.modified_at) : null,
    }));
    const installed = availableModels.some(
      (m) => m.name === this.model || m.name.startsWith(`${this.model}:`)
    );

    return {
      ok: installed,
      provider: this.name,
      model: this.model,
      availableModels,
      message: installed
        ? `${this.model} disponibile`
        : `${this.model} NON installato. Esegui: ollama pull ${this.model}`,
    };
  }

  /**
   * Messaggio per l'utente in caso di timeout, distinto per causa.
   *
   * La frase non contiene URL né porte (li maschera già il livello dei
   * messaggi), ma dice cosa è successo davvero: primo token mai arrivato,
   * stream morto a metà, o tetto totale superato. Sono tre guasti diversi che
   * si sistemano in modi diversi.
   */
  private timeoutMessage(
    reason: WatchdogReason | null,
    idleMs: number,
    totalMs: number,
    charsProduced: number | null
  ): string {
    const idleS = Math.round(idleMs / 1000);
    const totalS = Math.round(totalMs / 1000);
    if (reason === "total") {
      return `La richiesta a Ollama ha superato il tetto totale di ${totalS}s ed è stata interrotta. Riprova la richiesta.`;
    }
    if (charsProduced !== null && charsProduced > 0) {
      return `Ollama ha smesso di produrre testo per ${idleS}s durante la generazione (timeout di inattività). Riprova la richiesta.`;
    }
    return `Ollama non ha prodotto il primo token entro ${idleS}s (timeout di inattività). Il modello ${this.model} può metterci a caricarsi: riprova, e verifica che sia in memoria con "ollama ps".`;
  }

  async chat(
    messages: AiChatMessage[],
    options?: AiChatOptions
  ): Promise<AiCompletion> {
    const body: OllamaChatRequest = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      })),
      stream: true,
      think: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_ctx: options?.numCtx ?? config.ollamaNumCtx,
        num_predict: options?.numPredict ?? config.ollamaNumPredict,
      },
    };
    if (options?.jsonSchema) body.format = options.jsonSchema;
    else if (options?.jsonMode) body.format = "json";

    // Timeout di inattività (riarmato a ogni pacchetto) + tetto totale.
    // La configurazione applicativa ha il minimo di 60s imposto in env.ts:
    // un modello 8B può impiegare decine di secondi prima del primo token.
    // L'override per chiamata è un canale esplicito in codice (test,
    // diagnostica): chi lo usa dichiara ciò che sta facendo.
    const idleMs = options?.idleTimeoutMs ?? config.ollamaTimeoutMs;
    const totalMs = Math.max(
      options?.totalTimeoutMs ?? config.ollamaTotalTimeoutMs,
      idleMs
    );
    const t = new StreamWatchdog(idleMs, totalMs);
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;

    let res: Response;
    try {
      res = await this.requestRaw("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      if (t.signal.aborted) {
        logAIError("ollama.timeout", {
          model: this.model,
          phase: "connect",
          idleMs,
          totalMs,
          elapsedMs: Date.now() - startedAt,
          firstToken: false,
        }, e);
        throw new AiUnavailableError(this.timeoutMessage(t.reason, idleMs, totalMs, null));
      }
      if (e instanceof AiUnavailableError) throw e;
      throw new AiUnavailableError("Errore di rete verso Ollama", { cause: e });
    }

    try {
      if (!res.ok) {
        if (res.status === 404) {
          throw new AiUnavailableError(
            `Modello "${this.model}" non trovato su Ollama. Esegui: ollama pull ${this.model}`
          );
        }
        const text = await res.text().catch(() => "");
        throw new AiUnavailableError(
          `Ollama ha risposto con errore ${res.status}: ${text.slice(0, 300)}`
        );
      }

      if (!res.body) {
        throw new AiUnavailableError("Ollama non ha restituito uno stream.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      // Ogni pacchetto ricevuto riarma il watchdog: una generazione lunga ma
      // viva non viene mai tagliata dal timeout di inattività.
      let receivedAnyContent = false;
      // Contatori dell'ultimo chunk `done`: diagnostica sul contesto.
      let promptEvalCount: number | undefined;
      let evalCount: number | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          t.touch();
          if (firstTokenAt === null) firstTokenAt = Date.now();
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const payload = line.trim();
            if (!payload.startsWith("{")) continue;
            let json: unknown;
            try {
              json = JSON.parse(payload);
            } catch {
              continue;
            }
            if (!json || typeof json !== "object") continue;
            const final = json as {
              done?: unknown;
              prompt_eval_count?: unknown;
              eval_count?: unknown;
            };
            if (typeof final.prompt_eval_count === "number") {
              promptEvalCount = final.prompt_eval_count;
            }
            if (typeof final.eval_count === "number") evalCount = final.eval_count;
            if (final.done === true) continue;
            const msg = (json as { message?: unknown }).message;
            if (!msg || typeof msg !== "object") continue;
            // `thinking` (qwen3) è disabilitato via think:false: se arrivasse
            // comunque non va mescolato al testo della risposta.
            const chunk = String((msg as { content?: unknown }).content ?? "");
            if (!chunk) continue;
            receivedAnyContent = true;
            fullText += chunk;
            options?.onToken?.(chunk);
          }
        }
      } catch (e) {
        if (isAbortError(e) || t.signal.aborted) {
          // Diagnostica strutturata: fase, tempo al primo token, caratteri
          // prodotti. È la differenza fra "Ollama non risponde" e "lo stream è
          // morto a metà generazione", che si diagnosticano in modo diverso.
          logAIError("ollama.timeout", {
            model: this.model,
            phase: "stream",
            reason: t.reason,
            idleMs,
            totalMs,
            ttftMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
            elapsedMs: Date.now() - startedAt,
            chars: fullText.length,
          }, e);
          throw new AiUnavailableError(
            this.timeoutMessage(t.reason, idleMs, totalMs, fullText.length)
          );
        }
        // Connessione interrotta durante lo streaming: errore comprensibile.
        throw new AiUnavailableError(
          `La connessione con Ollama si è interrotta durante la generazione. Riprova la richiesta.`,
          { cause: e }
        );
      } finally {
        t.clear();
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const payload = buffer.trim();
        if (payload.startsWith("{")) {
          try {
            const json = JSON.parse(payload) as { message?: { content?: unknown } };
            const chunk = String(json?.message?.content ?? "");
            if (chunk) {
              receivedAnyContent = true;
              fullText += chunk;
            }
          } catch {
            // riga finale incompleta: si ignora
          }
        }
      }

      if (!receivedAnyContent) {
        throw new AiUnavailableError(
          "Ollama ha restituito una risposta vuota. Riprova la richiesta."
        );
      }

      return { text: fullText.trim(), promptEvalCount, evalCount };
    } finally {
      t.clear();
    }
  }
}