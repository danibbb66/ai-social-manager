export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiChatMessage {
  role: AiRole;
  content: string;
  name?: string;
}

export interface AiChatOptions {
  /** Forza il modello a rispondere in JSON valido */
  jsonMode?: boolean;
  /**
   * JSON Schema con cui vincolare la decodifica della risposta.
   * Ha precedenza su `jsonMode`: `format: "json"` da solo garantisce solo
   * JSON sintatticamente valido, non la forma del nostro envelope.
   */
  jsonSchema?: Record<string, unknown>;
  /** Callback chiamato per ogni token di testo ricevuto */
  onToken?: (chunk: string) => void;
  /** Temperatura di generazione */
  temperature?: number;
  /**
   * Context window in token per questa chiamata. Se omesso vale il default del
   * provider (per Ollama `OLLAMA_NUM_CTX`): deve essere più grande del prompt,
   * altrimenti il runtime evetta i token più vecchi, cioè le regole.
   */
  numCtx?: number;
  /** Tetto di token generati per questa chiamata (default del provider) */
  numPredict?: number;
  /**
   * Timeout di inattività per questa chiamata (ms): la richiesta viene
   * abortita se il provider non produce nulla per questo tempo. La
   * configurazione applicativa (OLLAMA_TIMEOUT_MS) ha il minimo di 60s;
   * questo override è un canale esplicito in codice per test e diagnostica.
   */
  idleTimeoutMs?: number;
  /** Tetto totale della richiesta (ms), rete di sicurezza contro stream infiniti. */
  totalTimeoutMs?: number;
}

export interface AiCompletion {
  text: string;
  /**
   * Token di prompt valutati dal provider, quando li espone (Ollama li manda
   * nell'ultimo chunk del stream). Serve a verificare che il prompt entri nel
   * contesto: diagnostica, non usata per decidere nulla.
   */
  promptEvalCount?: number;
  /** Token generati, quando il provider li espone. */
  evalCount?: number;
}

/** Errore quando il provider AI non è raggiungibile o non configurato */
export class AiUnavailableError extends Error {
  constructor(message = "AI non disponibile", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiUnavailableError";
  }
}

/** Errore quando il modello restituisce output non interpretabile */
export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}

/**
 * Astrazione del provider AI.
 * L'app parla solo con questa interfaccia: permette di sostituire Ollama
 * con un provider cloud (OpenAI, Anthropic...) senza toccare il resto del codice.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Verifica che il provider e il modello siano raggiungibili */
  ping(): Promise<AiPingResult>;
  /** Completezza: invia la conversazione e restituisce la risposta */
  chat(
    messages: AiChatMessage[],
    options?: AiChatOptions
  ): Promise<AiCompletion>;
}

export interface AiModelInfo {
  name: string;
  size: number;
  modifiedAt: Date | null;
}

export interface AiPingResult {
  ok: boolean;
  provider: string;
  model: string;
  availableModels: AiModelInfo[];
  message: string;
}