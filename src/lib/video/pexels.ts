import { logAIError } from "@/lib/logger";
import { sniffMediaMime } from "@/lib/uploads";
import { isVideoMime } from "@/lib/utils";
import type {
  StockVideo,
  StockVideoProvider,
  StockVideoSearchRequest,
} from "@/lib/video/stock";

/**
 * Fonte video STOCK gratuita: Pexels (https://www.pexels.com/api/).
 *
 * Complementa Magnific per i clip video: Pexels ha un piano gratuito (200
 * richieste/ora, nessun limite di "download/giorno" come Magnific) e restituisce
 * anche video VERTICALI (`orientation=portrait`), perfetti per i reel. Serve
 * `PEXELS_API_KEY` (gratuita, da pexels.com/api).
 *
 * Stesso contratto di Magnific: `searchVideo` non lancia mai, un errore di rete
 * o una chiave assente valgono "nessun risultato", e il montaggio ripiega.
 */

const API_BASE = "https://api.pexels.com";
const SEARCH_ENDPOINT = `${API_BASE}/videos/search`;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_QUERY_LENGTH = 120;

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
  // I file video Pexels vivono su *.pexels.com / videos.pexels.com.
  return host === "pexels.com" || host.endsWith(".pexels.com");
}

interface PexelsVideoFile {
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  link?: string | null;
}

/** Sceglie il file migliore: preferisce verticale (height>width) e qualità HD. */
function pickVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const mp4 = files.filter((f) => !f.file_type || f.file_type === "video/mp4");
  const portrait = mp4.filter((f) => (f.height ?? 0) > (f.width ?? 0));
  const pool = portrait.length > 0 ? portrait : mp4;
  if (pool.length === 0) return null;
  for (const q of ["hd", "uhd", "4k", "sd"]) {
    const match = pool.find((f) => f.quality === q);
    if (match) return match;
  }
  return pool[0];
}

export class PexelsStockVideoProvider implements StockVideoProvider {
  readonly name = "pexels-stock-video";

  private get apiKey(): string {
    return process.env.PEXELS_API_KEY?.trim() ?? "";
  }

  async searchVideo(request: StockVideoSearchRequest): Promise<StockVideo[]> {
    const query = request.query.trim();
    if (!query || !this.apiKey) return [];

    const limit = Math.max(1, Math.min(request.limit ?? 6, 20));
    const params = new URLSearchParams({
      query: query.slice(0, MAX_QUERY_LENGTH),
      per_page: String(limit),
      orientation: "portrait",
    });

    let items: Record<string, unknown>[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
        headers: { Authorization: this.apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = (await res.json()) as { videos?: unknown };
      items = Array.isArray(body?.videos)
        ? (body.videos as Record<string, unknown>[])
        : [];
    } catch (e) {
      logAIError("pexels.search", { reason: "network", query }, e);
      return [];
    }

    const results: StockVideo[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      if (!item || typeof item !== "object") continue;

      const files = Array.isArray(item.video_files)
        ? (item.video_files as PexelsVideoFile[])
        : [];
      const file = pickVideoFile(files);
      if (!file?.link || !isAllowedVideoUrl(file.link)) continue;

      const title =
        typeof item.alt === "string" && item.alt.trim()
          ? item.alt.trim()
          : typeof item.url === "string"
            ? item.url
            : null;

      results.push({
        provider: this.name,
        sourceUrl: file.link,
        alternateUrls: [],
        pageUrl: typeof item.url === "string" ? item.url : null,
        resourceId: typeof item.id === "number" ? item.id : null,
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
      // che ffmpeg riceva un file corrotto).
      const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const sniffed = sniffMediaMime(buffer);
      const mimeType = sniffed ?? (isVideoMime(headerMime) ? headerMime : "");
      if (!mimeType) {
        console.warn(
          `[pexels] risposta non video (${sniffed ?? headerMime ?? "sconosciuto"}) da ${video.sourceUrl}: clip scartata`
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

/** Pexels attivo solo con `PEXELS_API_KEY`, altrimenti nessun provider. */
export function getPexelsVideoProvider(): StockVideoProvider | null {
  return process.env.PEXELS_API_KEY?.trim() ? new PexelsStockVideoProvider() : null;
}
