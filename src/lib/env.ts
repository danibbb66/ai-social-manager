export type SocialCredentials = {
  token: string | undefined;
  extra: Record<string, string>;
};

/**
 * Timeout di inattività minimo per le chiamate Ollama (ms).
 *
 * I modelli locali da 8B (qwen3:8b) possono impiegare decine di secondi prima
 * del primo token: caricamento del modello in memoria, valutazione del prompt.
 * Un valore sotto questo tetto produce timeout spuri che sembrano guasti del
 * servizio, quindi non è ammesso nemmeno impostandolo a mano.
 */
export const OLLAMA_MIN_TIMEOUT_MS = 60_000;

/**
 * Timeout di inattività: la richiesta viene abortita se Ollama non produce
 * nulla per questo tempo. Non è un tetto sulla durata totale: una generazione
 * lunga ma viva (i token continuano ad arrivare) prosegue finché lo stream
 * alimenta il watchdog, fino al tetto totale.
 */
const OLLAMA_IDLE_TIMEOUT_MS = Math.max(
  Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000) || 600_000,
  OLLAMA_MIN_TIMEOUT_MS
);

/**
 * Tetto totale della richiesta, indipendente dall'attività: nessuna chiamata
 * può restare appesa per sempre nemmeno se Ollama continua a mandare byte.
 */
const OLLAMA_TOTAL_TIMEOUT_MS = Math.max(
  Number(process.env.OLLAMA_TOTAL_TIMEOUT_MS ?? 1_800_000) || 1_800_000,
  OLLAMA_IDLE_TIMEOUT_MS
);

export const config = {
  aiProvider: process.env.AI_PROVIDER ?? "ollama",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  /** Timeout di inattività (ms), con il minimo di 60s imposto. */
  ollamaTimeoutMs: OLLAMA_IDLE_TIMEOUT_MS,
  /** Tetto totale della richiesta (ms), sempre ≥ del timeout di inattività. */
  ollamaTotalTimeoutMs: OLLAMA_TOTAL_TIMEOUT_MS,
  /**
   * Context window del modello (token), inviato a ogni richiesta come
   * `options.num_ctx`. Il default di Ollama è 4096, troppo stretto per il
   * prompt dell'agente (system prompt + catalogo tool + cronologia ≈ 7.5k
   * token): quando il prompt supera il contesto il runtime evicta i token più
   * vecchi, cioè proprio le regole in testa al system prompt.
   * Attenzione al costo: la KV cache di qwen3:8b è ~144 KiB/token, quindi
   * 16.384 token ≈ 2,25 GiB di memoria video. Se la GPU è piccola, abbassa
   * questo valore o usa un modello più piccolo.
   */
  ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX ?? 16_384) || 16_384,
  /**
   * Tetto di token generati per risposta (`options.num_predict`). Lasciare il
   * default illimitato significa che la generazione può consumare il contesto
   * residuo: l'envelope dell'agente è già piccolo, 900 token bastano.
   */
  ollamaNumPredict: Number(process.env.OLLAMA_NUM_PREDICT ?? 900) || 900,
  imageProvider: process.env.IMAGE_PROVIDER ?? "manual",
  videoProvider: process.env.VIDEO_PROVIDER ?? "ffmpeg",
  /**
   * "Solo media curati": se true, post e video usano ESCLUSIVAMENTE i file
   * selezionati a mano dall'utente in public/curated/{photos,videos}/<slug>/.
   * Pixabay, Pexels e Magnific non vengono MAI interrogati. Una destinazione
   * senza file curati non produce il media (fallimento pulito, non fallback),
   * così siamo sicuri che esca solo materiale approvato.
   */
  curatedMediaOnly: (process.env.CURATED_MEDIA_ONLY ?? "false") === "true",

  instagram: {
    token: process.env.INSTAGRAM_ACCESS_TOKEN,
    accountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
  } as SocialCredentials & { token: string | undefined; accountId: string | undefined },

  facebook: {
    token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
    pageId: process.env.FACEBOOK_PAGE_ID,
  },

  tiktok: {
    token: process.env.TIKTOK_ACCESS_TOKEN,
    openId: process.env.TIKTOK_OPEN_ID,
  },

  /**
   * Base URL pubblica HTTPS dell'app (es. https://example.com).
   * Necessaria per i provider che devono scaricare i media dai loro server
   * (es. Instagram API with Instagram Login). I media salvati localmente hanno
   * infatti un percorso relativo (/uploads/...) non raggiungibile dall'esterno.
   */
  publicBaseUrl: (process.env.PUBLIC_APP_URL ?? "").replace(/\/+$/, ""),
};

export function hasInstagram() {
  return Boolean(config.instagram.token && config.instagram.accountId);
}
export function hasFacebook() {
  return Boolean(config.facebook.token && config.facebook.pageId);
}
export function hasTiktok() {
  return Boolean(config.tiktok.token && config.tiktok.openId);
}

export function platformConfigured(platform: string): boolean {
  switch (platform) {
    case "INSTAGRAM":
      return hasInstagram();
    case "FACEBOOK":
      return hasFacebook();
    case "TIKTOK":
      return hasTiktok();
    default:
      return false;
  }
}

/** Restituisce la base URL pubblica solo se è una URL HTTPS valida e utilizzabile. */
export function publicBaseUrl(): string | null {
  const base = config.publicBaseUrl;
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}