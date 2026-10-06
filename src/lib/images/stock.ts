import { logAIError } from "@/lib/logger";
import { sniffMediaMime } from "@/lib/uploads";
import { isImageMime } from "@/lib/utils";

/**
 * Ricerca di immagini REALI nella libreria stock (Magnific/Freepik).
 *
 * È l'altra metà di `magnific.ts`: quello genera un'immagine da un prompt,
 * qui non viene generato nulla. Si cerca un file già esistente nel catalogo
 * stock per parola chiave (la destinazione del post) e se ne scarica una copia,
 * così il visual di un contenuto è una fotografia reale e non l'output di un
 * modello.
 *
 * Nessun chiamante deve mai vedere un'eccezione: un errore di rete, una chiave
 * assente o una risposta malformata valgono "nessun risultato", e il chiamante
 * decide cosa fare (qui sotto: cercare nella Media Library, poi rifiutare il
 * DRAFT). Un post non deve mai restare senza visual, ma nemmeno nascerne uno
 * con un immagine che non esiste.
 */

const API_BASE = "https://api.magnific.com";
const SEARCH_ENDPOINT = `${API_BASE}/v1/resources`;
const DOWNLOAD_ENDPOINT = `${API_BASE}/v1/resources`;

/** Limite massimo di caratteri inviati come termine di ricerca. */
const MAX_QUERY_LENGTH = 120;
/** Limite massimo per il download dell'immagine stock. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Host da cui è ammesso scaricare lo stock.
 * Sono i CDN dichiarati nelle risposte Magnific/Freepik: nessun URL arbitrario
 * proveniente da una risposta non verificata entra nel processo.
 */
const ALLOWED_STOCK_HOSTS = ["img.freepik.com", "downloadscdn7.freepik.com", "freepik.com"];

function isAllowedStockUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_STOCK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export type StockOrientation = "landscape" | "portrait" | "square";

export interface StockSearchRequest {
  /** Parola chiave: la destinazione o l'argomento del post. */
  query: string;
  orientation?: StockOrientation;
  /** Quanti risultati valutare (default 6). */
  limit?: number;
}

/** Un'immagine stock scaricata in memoria, pronta per essere messa a terra. */
export interface StockImage {
  buffer: Buffer;
  mimeType: string;
  /** Nome file suggerito dalla fonte, ripulito. */
  filename: string;
  /** URL da cui è stato scaricato il file. */
  sourceUrl: string;
  /** Pagina pubblica del resource, per l'audit e la tracciabilità. */
  pageUrl: string | null;
  resourceId: number | null;
  title: string | null;
  /** Nome del provider che ha fornito il file (es. "magnific-stock"). */
  provider: string;
}

export interface StockProvider {
  readonly name: string;
  /**
   * Cerca nella libreria stock. Restituisce `null` quando non c'è nessuna
   * immagine utilizzabile: mai un'eccezione, mai un'immagine finta.
   */
  searchImage(request: StockSearchRequest): Promise<StockImage | null>;
}

async function parseJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Legge il primo valore stringa non vuoto tra le chiavi indicate. */
function firstString(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Scarica un file immagine con limite di dimensione e timeout. */
async function downloadStockImage(
  url: string,
  apiKey: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "x-magnific-api-key": apiKey, Accept: "image/*,*/*" },
    });
    if (!res.ok) return null;

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return null;

    const sniffed = sniffMediaMime(buffer);
    const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mimeType = sniffed ?? (isImageMime(headerMime) ? headerMime : "");
    if (!mimeType) return null;
    return { buffer, mimeType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Libreria stock Magnific (`GET /v1/resources` + download del resource).
 *
 * La ricerca esclude esplicitamente le immagini generate da AI
 * (`filters[ai-generated][excluded]=1`): il visual di un post deve essere una
 * fotografia reale, quindi nemmeno la fonte stock può introdurre contenuti
 * generativi per porte dietro.
 */
export class MagnificStockProvider implements StockProvider {
  readonly name = "magnific-stock";

  private get apiKey(): string {
    return process.env.MAGNIFIC_API_KEY?.trim() ?? "";
  }

  async searchImage(request: StockSearchRequest): Promise<StockImage | null> {
    const query = request.query.trim();
    if (!query || !this.apiKey) return null;

    const params = new URLSearchParams();
    params.set("term", query.slice(0, MAX_QUERY_LENGTH));
    params.set("order", "relevance");
    params.set("limit", String(Math.max(1, Math.min(request.limit ?? 6, 20))));
    params.set("filters[content_type][photo]", "1");
    params.set("filters[ai-generated][excluded]", "1");
    if (request.orientation) {
      params.set(`filters[orientation][${request.orientation}]`, "1");
    }

    const headers = {
      "x-magnific-api-key": this.apiKey,
      Accept: "application/json",
    };

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
        logAIError("stock.search", { status: res.status, query }, new Error("risposta stock non valida"));
        return null;
      }
      const body = await parseJson(res);
      const data = body?.data;
      items = Array.isArray(data) ? data : [];
    } catch (e) {
      logAIError("stock.search", { reason: "network", query }, e);
      return null;
    }

    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const image =
        record.image && typeof record.image === "object" && !Array.isArray(record.image)
          ? (record.image as Record<string, unknown>)
          : null;
      const source =
        image && image.source && typeof image.source === "object"
          ? (image.source as Record<string, unknown>)
          : null;

      const resourceId = typeof record.id === "number" ? record.id : null;
      const previewUrl = firstString(source, ["url"]);
      const pageUrl = firstString(record, ["url"]) || null;
      const title = firstString(record, ["title"]) || null;

      // 1. Il download ufficiale del resource: è quello che la licenza attende.
      // 2. In subordine, la preview dichiarata dalla stessa risposta.
      const candidates: string[] = [];
      if (resourceId !== null) {
        const official = await this.officialDownloadUrl(resourceId, headers);
        if (official) candidates.push(official);
      }
      if (previewUrl) candidates.push(previewUrl);

      for (const candidate of candidates) {
        if (!isAllowedStockUrl(candidate)) continue;
        const downloaded = await downloadStockImage(candidate, this.apiKey);
        if (!downloaded) continue;
        return {
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
          filename: filenameFromUrl(candidate, `stock-${resourceId ?? "immagine"}.jpg`),
          sourceUrl: candidate,
          pageUrl,
          resourceId,
          title,
          provider: this.name,
        };
      }
    }

    return null;
  }

  /**
   * URL CDN restituito dall'endpoint di download del resource.
   *
   * L'endpoint stesso non è la fonte del file: risponde con un JSON che punta
   * a un CDN, ed è solo quell'URL a essere scaricato (dopo la verifica host).
   */
  private async officialDownloadUrl(
    resourceId: number,
    headers: Record<string, string>
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${DOWNLOAD_ENDPOINT}/${resourceId}/download?image_size=2000px`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = await parseJson(res);
      const data =
        body?.data && typeof body.data === "object" && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : null;
      return firstString(data, ["url"]) || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Provider di comodo che non trova mai nulla (nessuna chiave configurata). */
export class NullStockProvider implements StockProvider {
  readonly name = "stock-disabled";
  async searchImage(): Promise<StockImage | null> {
    return null;
  }
}
