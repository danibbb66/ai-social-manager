import { logAIError } from "@/lib/logger";
import { sniffMediaMime } from "@/lib/uploads";
import { isImageMime } from "@/lib/utils";
import type {
  StockImage,
  StockProvider,
  StockSearchRequest,
} from "@/lib/images/stock";

/**
 * Libreria stock di FOTOGRAFIE Pixabay (https://pixabay.com/api/docs/).
 *
 * È la fonte foto predefinita per i post: gratuita (100 richieste/minuto, nessun
 * limite di download/giorno), indicizzata in inglese e con chiave già disponibile.
 * Sostituisce Magnific per i visual della destinazione, che invece condivide con
 * il catalogo i crediti limitati (~10 download/giorno) e una volta esauriti
 * risponde 402.
 *
 * Stesso contratto di `MagnificStockProvider`: `searchImage`/`searchImages` non
 * lanciano mai, un errore di rete o una chiave assente valgono "nessun risultato",
 * e il chiamante decide (Media Library, poi nessun DRAFT).
 */

const API_BASE = "https://pixabay.com";
const SEARCH_ENDPOINT = `${API_BASE}/api/`;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_QUERY_LENGTH = 100;

function isAllowedImageUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  // Le foto Pixabay vivono su pixabay.com (webformal/large) e cdn.pixabay.com.
  return host === "pixabay.com" || host.endsWith(".pixabay.com");
}

/**
 * Sceglie l'URL migliore per il download: `largeImageURL` (1280px, il giusto
 * per un output 1080) prima di `webformatURL` (640px, fallback). `imageURL`
 * (l'originale in 4K+) viene evitato per non scaricare file enormi.
 */
function pickImageUrl(hit: Record<string, unknown>): string | null {
  const large = hit.largeImageURL;
  if (typeof large === "string" && large.trim()) return large.trim();
  const web = hit.webformatURL;
  if (typeof web === "string" && web.trim()) return web.trim();
  return null;
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const clean = last.replace(/[^\w.-]+/g, "-").slice(0, 80);
    return clean || fallback;
  } catch {
    return fallback;
  }
}

export class PixabayStockProvider implements StockProvider {
  readonly name = "pixabay-stock";

  private get apiKey(): string {
    return process.env.PIXABAY_API_KEY?.trim() ?? "";
  }

  async searchImage(request: StockSearchRequest): Promise<StockImage | null> {
    const images = await this.searchImages({ ...request, limit: 1 });
    return images[0] ?? null;
  }

  async searchImages(request: StockSearchRequest): Promise<StockImage[]> {
    const query = request.query.trim();
    if (!query || !this.apiKey) return [];

    const limit = Math.max(1, Math.min(request.limit ?? 6, 20));
    // Chiediamo più risultati di quelli che servono: i primi "popular" tornano
    // sempre uguali, e il chiamante può voler scartare duplicati o fuori tema.
    const perPage = Math.max(3, Math.min(limit * 3, 200));
    const params = new URLSearchParams({
      key: this.apiKey,
      q: query.slice(0, MAX_QUERY_LENGTH),
      image_type: "photo",
      safesearch: "true",
      order: "popular",
      page: "1",
      per_page: String(perPage),
    });
    if (request.orientation === "portrait") params.set("orientation", "vertical");
    else if (request.orientation === "landscape") params.set("orientation", "horizontal");
    // "square" non ha un filtro Pixabay: si lascia senza orientamento.

    let hits: Record<string, unknown>[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status !== 429 && res.status !== 402) {
          logAIError("pixabay.stock.search", { status: res.status, query }, new Error("risposta stock non valida"));
        }
        return [];
      }
      const body = (await res.json()) as { hits?: unknown };
      hits = Array.isArray(body?.hits) ? (body.hits as Record<string, unknown>[]) : [];
    } catch (e) {
      logAIError("pixabay.stock.search", { reason: "network", query }, e);
      return [];
    }

    const results: StockImage[] = [];
    const seenSourceUrls = new Set<string>();
    for (const hit of hits) {
      if (results.length >= limit) break;
      if (!hit || typeof hit !== "object") continue;

      const url = pickImageUrl(hit);
      if (!url || !isAllowedImageUrl(url)) continue;

      const resourceId = typeof hit.id === "number" ? hit.id : null;
      const pageUrl = typeof hit.pageURL === "string" ? hit.pageURL : null;
      const title =
        typeof hit.tags === "string" && hit.tags.trim()
          ? hit.tags.trim()
          : typeof hit.pageURL === "string"
            ? hit.pageURL
            : null;

      if (seenSourceUrls.has(url)) continue;
      const downloaded = await this.download(url);
      if (!downloaded) continue;
      seenSourceUrls.add(url);
      results.push({
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType,
        filename: filenameFromUrl(url, `pixabay-${resourceId ?? "immagine"}.jpg`),
        sourceUrl: url,
        pageUrl,
        resourceId,
        title,
        provider: this.name,
      });
    }

    return results;
  }

  private async download(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { Accept: "image/*,*/*;q=0.9" },
      });
      if (!res.ok) return null;

      const declared = Number(res.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return null;

      const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const sniffed = sniffMediaMime(buffer);
      const mimeType = sniffed ?? (isImageMime(headerMime) ? headerMime : "");
      if (!mimeType) {
        console.warn(`[pixabay] risposta non immagine da ${url}: scartata`);
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
export function getPixabayStockProvider(): StockProvider | null {
  return process.env.PIXABAY_API_KEY?.trim() ? new PixabayStockProvider() : null;
}
