import { logAIError } from "@/lib/logger";
import { sniffMediaMime } from "@/lib/uploads";
import { isVideoMime } from "@/lib/utils";

/**
 * Ricerca di video REALI nella libreria stock (Magnific/Freepik).
 *
 * È la controparte video di `images/stock.ts`: non genera nulla, cerca file
 * video già esistenti nel catalogo stock per parola chiave (la destinazione,
 * es. "Bali") e fornisce i flussi da scaricare. Il montaggio li riutilizza
 * come clip reali: niente fotografie statiche zoomate come prima scelta.
 *
 * Nessun chiamante deve mai vedere un'eccezione: chiave assente, rete giù o
 * risposta malformata valgono "nessun risultato", e il montaggio decide con
 * le clip locali come ripiego. Il provider è la PRIMA fonte interpellata per
 * le clip video — non un'accessorio della Media Library.
 */

const API_BASE = "https://api.magnific.com";
// I video hanno un endpoint DEDICATO, separato da quello delle risorse
// (foto/vector): `GET /v1/videos` per la ricerca e `/v1/videos/{id}/download`
// per il file. L'endpoint `/v1/resources?...content_type=video` NON esiste e
// restituisce foto.
const SEARCH_ENDPOINT = `${API_BASE}/v1/videos`;
const DOWNLOAD_ENDPOINT = `${API_BASE}/v1/videos`;

const MAX_QUERY_LENGTH = 120;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
/** Un clip stock in MP4 raramente serve oltre: tappo anti-abuso. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Host da cui è ammesso scaricare i video stock. I CDN reali di Magnific/
 * Freepik per i video non sono stabili da documentare a priori, quindi la
 * lista è estendibile via `VIDEO_STOCK_ALLOWED_HOSTS` (virgola) senza toccare
 * il codice. Si accettano solo host https non-IP appartenenti a freepik.com o
 * a un dominio esplicitamente autorizzato.
 */
const DEFAULT_ALLOWED_HOSTS = [
  "freepik.com",
  "magnific.com",
  // CDN di consegna dei video Magnific/Freepik (videvo.net per i file MOV/MP4,
  // cdnpk.net per preview/thumbnails): i sottodomini cambiano, il suffisso no.
  "videvo.net",
  "cdnpk.net",
];
function allowedHosts(): string[] {
  const extra = (process.env.VIDEO_STOCK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

function isAllowedVideoUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  // Nessun IP: chiude loopback/link-local in un colpo.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return allowedHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export interface StockVideoSearchRequest {
  /** Parola chiave: la destinazione o l'argomento del video. */
  query: string;
  /** Quanti video valutare (default 6). */
  limit?: number;
}

/** Un video stock remoto: l'URL (o i candidati) da cui scaricare la clip. */
export interface StockVideo {
  provider: string;
  sourceUrl: string;
  alternateUrls: string[];
  pageUrl: string | null;
  resourceId: number | null;
  title: string | null;
}

export interface StockVideoProvider {
  readonly name: string;
  /**
   * Cerca video nel catalogo stock. Restituisce una lista (possibilmente
   * vuota): mai un'eccezione, mai un file finto.
   */
  searchVideo(request: StockVideoSearchRequest): Promise<StockVideo[]>;
  /** Scarica il video e restituisce i byte + il MIME reale, o `null`. */
  downloadVideo(video: StockVideo): Promise<{ buffer: Buffer; mimeType: string } | null>;
}

async function parseJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Il CDN ufficiale del video, se l'endpoint di download risponde con un JSON. */
async function officialDownloadUrl(
  resourceId: number,
  headers: Record<string, string>
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${DOWNLOAD_ENDPOINT}/${resourceId}/download`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 402/403 = il piano Magnific dell'account non include (o ha esaurito)
      // i crediti per scaricare i video stock. Non è un errore di rete: va in
      // log chiaro così l'operatore sa subito cosa manca. Le foto restano
      // disponibili e il montaggio ripiega su di esse.
      if (res.status === 402 || res.status === 403) {
        const msg = await res.text().catch(() => "");
        console.warn(
          `[stock-video] download video bloccato dal piano Magnific (HTTP ${res.status}): ${msg.slice(0, 120)}`
        );
      }
      return null;
    }
    const body = await parseJson(res);
    const data = asObj(body?.data);
    return firstString(data, ["url"]) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ricerca video Magnific (`GET /v1/videos`).
 *
 * La lista restituisce i metadati del video (id, nome, durata, anteprime); il
 * FILE reale si ottiene solo da `/v1/videos/{id}/download`. Escludiamo i video
 * generati da AI: un reel deve mostrare luoghi/riprese reali.
 */
export class MagnificStockVideoProvider implements StockVideoProvider {
  readonly name = "magnific-stock-video";

  private get apiKey(): string {
    return process.env.MAGNIFIC_API_KEY?.trim() ?? "";
  }

  async searchVideo(request: StockVideoSearchRequest): Promise<StockVideo[]> {
    const query = request.query.trim();
    if (!query || !this.apiKey) return [];

    const limit = Math.max(1, Math.min(request.limit ?? 6, 20));
    const params = new URLSearchParams();
    params.set("term", query.slice(0, MAX_QUERY_LENGTH));
    params.set("order", "relevance");
    params.set("page", "1");
    params.set("per_page", String(limit));

    const headers = { "x-magnific-api-key": this.apiKey, Accept: "application/json" };

    let items: unknown[] = [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logAIError("stock-video.search", { status: res.status, query }, new Error("risposta stock video non valida"));
        return [];
      }
      const body = await parseJson(res);
      const data = body?.data;
      items = Array.isArray(data) ? data : [];
    } catch (e) {
      logAIError("stock-video.search", { reason: "network", query }, e);
      return [];
    }

    const results: StockVideo[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      const record = asObj(item);
      if (!record) continue;

      // Un reel deve mostrare riprese reali, non output generativi.
      if (record.is_ai_generated === true) continue;

      const resourceId = typeof record.id === "number" ? record.id : null;
      if (resourceId === null) continue;
      const title = firstString(record, ["name", "title"]);
      const pageUrl = firstString(record, ["url"]) || null;

      // Il FILE non è nella lista: si ottiene solo da `/v1/videos/{id}/download`.
      const official = await officialDownloadUrl(resourceId, headers);
      if (!official || !isAllowedVideoUrl(official)) continue;

      results.push({
        provider: this.name,
        sourceUrl: official,
        alternateUrls: [],
        pageUrl,
        resourceId,
        title,
      });
    }
    return results;
  }

  async downloadVideo(video: StockVideo): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const candidates = [video.sourceUrl, ...video.alternateUrls].filter(isAllowedVideoUrl);
    for (const url of candidates) {
      const downloaded = await this.downloadOnce(url);
      if (downloaded) return downloaded;
    }
    return null;
  }

  private async downloadOnce(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "x-magnific-api-key": this.apiKey,
          Accept: "video/*,*/*;q=0.9",
        },
      });
      if (!res.ok) return null;

      const declared = Number(res.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return null;

      // Il contenuto DEVE essere un video: HTML/JSON/JPEG vengono scartati QUI,
      // prima che ffmpeg riceva un .mp4 corrotto ("moov atom not found") e la
      // generazione vada in loop di errori. La firma ha la precedenza, ma i
      // .mov senza box `ftyp` ricadono sul Content-Type reale dichiarato.
      const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const sniffed = sniffMediaMime(buffer);
      const mimeType = sniffed ?? (isVideoMime(headerMime) ? headerMime : "");
      if (!mimeType) {
        console.warn(
          `[stock-video] risposta non video (${sniffed ?? headerMime ?? "sconosciuto"}) da ${url}: clip scartata`
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

/** Provider di comodo che non trova mai nulla (nessuna chiave configurata). */
export class NullStockVideoProvider implements StockVideoProvider {
  readonly name = "stock-video-disabled";
  async searchVideo(): Promise<StockVideo[]> {
    return [];
  }
  async downloadVideo(): Promise<{ buffer: Buffer; mimeType: string } | null> {
    return null;
  }
}

let stockVideoOverride: StockVideoProvider | null = null;

/** Iniezione di un provider di stock video alternativo (test). */
export function setStockVideoProvider(provider: StockVideoProvider | null): void {
  stockVideoOverride = provider;
}

/** Factory del provider di stock video (override dei test, poi configurazione).
 *
 *  Magnific per i VIDEO è DISATTIVATO di default: i crediti (condivisi con le
 *  FOTO del catalogo, ~10 download/giorno) si esauriscono in fretta e il
 *  download risponde 402 "Insufficient credits" spammando i log. Per i video
 *  si usano solo i provider gratuiti (Pixabay/Pexels). Si riattiva solo con
 *  `VIDEO_USE_MAGNIFIC=true` (le FOTO del catalogo restano su Magnific e non
 *  sono toccate da questo flag). */
export function getStockVideoProvider(): StockVideoProvider {
  if (stockVideoOverride) return stockVideoOverride;
  if (process.env.VIDEO_USE_MAGNIFIC !== "true") return new NullStockVideoProvider();
  const key = process.env.MAGNIFIC_API_KEY?.trim();
  if (!key) return new NullStockVideoProvider();
  return new MagnificStockVideoProvider();
}
