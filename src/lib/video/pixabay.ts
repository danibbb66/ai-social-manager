import { logAIError } from "@/lib/logger";
import { sniffMediaMime } from "@/lib/uploads";
import { isVideoMime } from "@/lib/utils";
import type {
  StockVideo,
  StockVideoProvider,
  StockVideoSearchRequest,
} from "@/lib/video/stock";

/**
 * Fonte video STOCK gratuita: Pixabay (https://pixabay.com/api/docs/).
 *
 * Complementa Magnific e Pexels per i clip video: Pixabay ha un piano gratuito
 * (100 richieste/minuto, nessun limite di "download/giorno" come Magnific) e
 * non sospende l'emissione delle chiavi. Serve `PIXABAY_API_KEY` (gratuita, la
 * chiave appare sulla pagina della documentazione API una volta fatto login).
 *
 * Stesso contratto dei provider gemelli: `searchVideo` non lancia mai, una
 * chiave assente o un errore di rete valgono "nessun risultato", e il
 * montaggio ripiega sulle fonti successive.
 *
 * Pixabay NON ha un filtro `orientation` per i video: i verticali vengono
 * preferiti lato client (height > width) quando disponibili, altrimenti si
 * usano i landscape (che il montaggio ritaglia comunque a 1080x1920).
 */

const API_BASE = "https://pixabay.com";
const SEARCH_ENDPOINT = `${API_BASE}/api/videos/`;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_QUERY_LENGTH = 100;

function isAllowedVideoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  // I file video Pixabay vivono su cdn.pixabay.com (e *.pixabay.com).
  return host === "pixabay.com" || host.endsWith(".pixabay.com");
}

interface PixabayRendition {
  url?: string | null;
  width?: number;
  height?: number;
  size?: number;
}

type PixabayRenditions = Record<string, PixabayRendition | undefined>;

/** Ordine di preferenza delle qualità: "medium" (1080p, sempre presente) pesa
 *  meno di "large" (4K) ed è sufficiente per un reel verticale 1080x1920. */
const RENDITION_PREFERENCE = ["medium", "large", "small", "tiny"];

/**
 * Sceglie l'URL del rendering migliore: preferisce verticale (height > width)
 * e, a parità, la qualità più bilanciata per il download.
 */
function pickVideoUrl(videos: PixabayRenditions): { url: string; width: number; height: number } | null {
  const entries: { url: string; width: number; height: number; order: number }[] = [];
  for (const key of Object.keys(videos)) {
    const r = videos[key];
    if (!r?.url || !isAllowedVideoUrl(r.url)) continue;
    const order = RENDITION_PREFERENCE.indexOf(key);
    entries.push({
      url: r.url,
      width: r.width ?? 0,
      height: r.height ?? 0,
      order: order === -1 ? RENDITION_PREFERENCE.length : order,
    });
  }
  if (entries.length === 0) return null;

  const portrait = entries.filter((e) => e.height > e.width);
  const pool = portrait.length > 0 ? portrait : entries;
  pool.sort((a, b) => a.order - b.order);
  return { url: pool[0].url, width: pool[0].width, height: pool[0].height };
}

export class PixabayStockVideoProvider implements StockVideoProvider {
  readonly name = "pixabay-stock-video";

  private get apiKey(): string {
    return process.env.PIXABAY_API_KEY?.trim() ?? "";
  }

  async searchVideo(request: StockVideoSearchRequest): Promise<StockVideo[]> {
    const query = request.query.trim();
    if (!query || !this.apiKey) return [];

    const limit = Math.max(1, Math.min(request.limit ?? 6, 20));
    // Si chiedono più risultati del necessario per avere margine nel filtrare
    // i verticali lato client (Pixabay non filtra per orientamento).
    const perPage = Math.max(3, Math.min(limit * 4, 200));
    const params = new URLSearchParams({
      key: this.apiKey,
      q: query.slice(0, MAX_QUERY_LENGTH),
      video_type: "film", // solo riprese reali, niente animazioni/generative
      safesearch: "true",
      order: "popular",
      page: "1",
      per_page: String(perPage),
    });

    let items: Record<string, unknown>[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = (await res.json()) as { hits?: unknown };
      items = Array.isArray(body?.hits)
        ? (body.hits as Record<string, unknown>[])
        : [];
    } catch (e) {
      logAIError("pixabay.search", { reason: "network", query }, e);
      return [];
    }

    const results: StockVideo[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      if (!item || typeof item !== "object") continue;

      const videos = (item.videos && typeof item.videos === "object"
        ? item.videos
        : {}) as PixabayRenditions;
      const picked = pickVideoUrl(videos);
      if (!picked) continue;

      const id = typeof item.id === "number" ? item.id : null;
      const title =
        typeof item.tags === "string" && item.tags.trim()
          ? item.tags.trim()
          : typeof item.pageURL === "string"
            ? item.pageURL
            : null;

      results.push({
        provider: this.name,
        sourceUrl: picked.url,
        alternateUrls: [],
        pageUrl: typeof item.pageURL === "string" ? item.pageURL : null,
        resourceId: id,
        title,
      });
    }
    return results;
  }

  async downloadVideo(video: StockVideo): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!isAllowedVideoUrl(video.sourceUrl)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(video.sourceUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: { Accept: "video/*,*/*;q=0.9" },
      });
      if (!res.ok) return null;

      const declared = Number(res.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return null;

      // Deve essere davvero un video (HTML/JSON/immagini vanno scartati prima
      // che ffmpeg riceva un file corrotto "moov atom not found").
      const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const sniffed = sniffMediaMime(buffer);
      const mimeType = sniffed ?? (isVideoMime(headerMime) ? headerMime : "");
      if (!mimeType) {
        console.warn(
          `[pixabay] risposta non video (${sniffed ?? headerMime ?? "sconosciuto"}) da ${video.sourceUrl}: clip scartata`
        );
        return null;
      }
      return { buffer, mimeType };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pixabay attivo solo con `PIXABAY_API_KEY`, altrimenti nessun provider. */
export function getPixabayVideoProvider(): StockVideoProvider | null {
  return process.env.PIXABAY_API_KEY?.trim() ? new PixabayStockVideoProvider() : null;
}
