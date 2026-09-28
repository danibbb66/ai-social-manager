export type SocialCredentials = {
  token: string | undefined;
  extra: Record<string, string>;
};

export const config = {
  aiProvider: process.env.AI_PROVIDER ?? "ollama",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 600_000) || 600_000,
  imageProvider: process.env.IMAGE_PROVIDER ?? "manual",
  videoProvider: process.env.VIDEO_PROVIDER ?? "ffmpeg",

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