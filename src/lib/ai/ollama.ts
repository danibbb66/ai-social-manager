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

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
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

    const timeoutMs = config.ollamaTimeoutMs;
    const t = timeoutSignal(timeoutMs);

    let res: Response;
    try {
      res = await this.requestRaw("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        if (t.signal.aborted) {
          throw new AiUnavailableError(
            `Ollama non ha risposto entro ${Math.round(timeoutMs / 1000)}s (timeout). Riprova: la generazione locale può essere lenta.`
          );
        }
        throw e;
      }
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

      let receivedAnyContent = false;
      // Contatori dell'ultimo chunk `done`: diagnostica sul contesto.
      let promptEvalCount: number | undefined;
      let evalCount: number | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
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
        if (isAbortError(e)) {
          throw new AiUnavailableError(
            `Ollama ha impiegato troppo tempo a generare la risposta (timeout ${Math.round(timeoutMs / 1000)}s). Riprova la richiesta.`
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