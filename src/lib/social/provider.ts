import type { Content, Platform } from "@prisma/client";

export interface PublishResult {
  ok: boolean;
  message: string;
  externalId?: string;
}

export interface PublishPayload {
  /** caption/testo da pubblicare */
  caption?: string | null;
  hashtags?: string | null;
  /** URL assoluti (o relativi) dei supporti da postare */
  mediaUrls: string[];
  videoUrl?: string | null;
  contentType: "POST" | "CAROUSEL" | "VIDEO";
}

/**
 * Astrazione dei provider social.
 * Le implementazioni reali usano SOLO le API ufficiali (Graph API, TikTok API).
 * Se le credenziali non sono configurate, publish() non tenta nulla e
 * restituisce ok:false con un messaggio chiaro.
 */
export interface SocialProvider {
  readonly platform: Platform;
  readonly isConfigured: boolean;
  /** Motivi della mancata configurazione (utile per l'UI) */
  missingConfig(): string[];
  publish(payload: PublishPayload, content: Content): Promise<PublishResult>;
}