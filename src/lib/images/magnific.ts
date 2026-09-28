import {
  GeneratedImage,
  GenerateImageOptions,
  ImageGenerationUnavailableError,
  ImageProvider,
  ImageUpload,
} from "@/lib/images/provider";
import { saveUploadedFile, sniffMediaMime } from "@/lib/uploads";
import { imageExtensionForMime, isImageMime } from "@/lib/utils";
import { logAIError } from "@/lib/logger";

/** Base URL pubblica e documentata dell'API Magnific. */
const API_BASE = "https://api.magnific.com";
const CREATE_TASK_ENDPOINT = `${API_BASE}/v1/ai/mystic`;

/** Limite massimo di caratteri per il prompt (imposto di sicurezza). */
const MAX_PROMPT_LENGTH = 1000;
/** Limite massimo per il download dell'immagine generata. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Tempo massimo complessivo per la generazione (crea task + polling). */
const GENERATION_TIMEOUT_MS = 120_000;
/** Intervallo tra un tentativo di polling e l'altro. */
const POLL_INTERVAL_MS = 5_000;
/** Timeout per il download dell'immagine. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Formati supportati dall'API Magnific per `aspect_ratio`. */
export const MAGNIFIC_ASPECT_RATIOS = [
  "square_1_1",
  "classic_4_3",
  "traditional_3_4",
  "widescreen_16_9",
  "social_story_9_16",
  "smartphone_horizontal_20_9",
  "smartphone_vertical_9_20",
  "standard_3_2",
  "portrait_2_3",
  "horizontal_2_1",
  "vertical_1_2",
  "social_5_4",
  "social_post_4_5",
] as const;
export const MAGNIFIC_RESOLUTIONS = ["1k", "2k", "4k"] as const;

/**
 * Host ammessi da cui scaricare l'immagine generata.
 * L'URL proviene sempre dalla risposta verificata di Magnific:
 * accettiamo solo i CDN previsti (mai URL arbitrari).
 */
const ALLOWED_CDN_HOSTS = new Set(["cdn-magnific.freepik.com", "ai-statics.freepik.com"]);

/** Errore reale del provider Magnific (riportato all'utente senza esporre la chiave). */
export class MagnificApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MagnificApiError";
  }
}

function getApiKey(): string {
  const key = process.env.MAGNIFIC_API_KEY?.trim();
  if (!key) {
    throw new ImageGenerationUnavailableError(
      "Generatore immagini non configurato: variabile MAGNIFIC_API_KEY mancante."
    );
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Costruisce un messaggio d'errore leggibile da una risposta HTTP non valida. */
function httpErrorMessage(status: number, body: unknown, step: string): string {
  const msg =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
      ? ((body as Record<string, unknown>).message as string)
      : `errore HTTP ${status}`;
  return `Magnific: ${step} non riuscita (${msg}).`;
}

/** Accetta solo URL https il cui host appartiene ai CDN Magnific previsti. */
function isAllowedCdnUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_CDN_HOSTS.has(host)) return true;
  return [...ALLOWED_CDN_HOSTS].some((h) => host.endsWith(`.${h}`));
}

/** Scarica l'immagine da un URL CDN verificato con limite di dimensione e timeout. */
async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new MagnificApiError(`Download immagine fallito (HTTP ${res.status}).`);

    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new MagnificApiError("Immagine generata troppo grande: download annullato.");
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new MagnificApiError("Immagine generata vuota: download annullato.");
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new MagnificApiError("Immagine generata troppo grande: download annullato.");
    }

    const headerMime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const sniffed = sniffMediaMime(buffer);
    if (!sniffed) {
      if (headerMime && headerMime.startsWith("image/")) return { buffer, mimeType: headerMime };
      throw new MagnificApiError("Il file scaricato non è un'immagine valida.");
    }
    return { buffer, mimeType: sniffed };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new MagnificApiError("Timeout durante il download dell'immagine generata.");
    }
    if (e instanceof MagnificApiError) throw e;
    throw new MagnificApiError("Impossibile scaricare l'immagine generata dal CDN Magnific.");
  } finally {
    clearTimeout(timer);
  }
}

/** Chiede la generazione e attende il completamento, poi scarica la copia locale. */
export async function generateWithMagnific(
  prompt: string,
  options?: GenerateImageOptions
): Promise<GeneratedImage> {
  const apiKey = getApiKey();

  const cleanPrompt = String(prompt ?? "").trim();
  if (!cleanPrompt) throw new MagnificApiError("Prompt vuoto: impossibile generare l'immagine.");
  if (cleanPrompt.length > MAX_PROMPT_LENGTH) {
    throw new MagnificApiError(`Prompt troppo lungo (massimo ${MAX_PROMPT_LENGTH} caratteri).`);
  }

  const resolution = options?.resolution ?? "1k";
  if (!MAGNIFIC_RESOLUTIONS.includes(resolution)) {
    throw new MagnificApiError(`Risoluzione non supportata: ${resolution}.`);
  }
  const aspectRatio = options?.aspectRatio ?? "square_1_1";
  if (!MAGNIFIC_ASPECT_RATIOS.includes(aspectRatio as (typeof MAGNIFIC_ASPECT_RATIOS)[number])) {
    throw new MagnificApiError(`Formato non supportato: ${aspectRatio}.`);
  }

  const headers = {
    "x-magnific-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1) creazione del task
  let createRes: Response;
  try {
    createRes = await fetch(CREATE_TASK_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: cleanPrompt, resolution, aspect_ratio: aspectRatio }),
    });
  } catch (e) {
    logAIError("magnific.createTask", { reason: "network" }, e);
    throw new MagnificApiError("Impossibile contattare il servizio Magnific. Riprova tra poco.");
  }
  const createBody = await parseJson(createRes);
  if (!createRes.ok) throw new MagnificApiError(httpErrorMessage(createRes.status, createBody, "creazione task"));

  const createData = (createBody?.data ?? null) as { task_id?: unknown; status?: unknown } | null;
  const taskId = createData && typeof createData.task_id === "string" ? createData.task_id.trim() : "";
  if (!taskId) throw new MagnificApiError("Risposta Magnific malformata: task_id mancante.");

  // 2) polling fino a COMPLETED / FAILED / timeout
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let completed: { generated?: unknown; error?: unknown } | null = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollRes: Response;
    try {
      pollRes = await fetch(`${CREATE_TASK_ENDPOINT}/${taskId}`, { headers });
    } catch {
      continue; // errore di rete transitorio: riprova finché c'è tempo
    }

    const pollBody = await parseJson(pollRes);
    if (!pollRes.ok) throw new MagnificApiError(httpErrorMessage(pollRes.status, pollBody, "controllo stato task"));

    const data = (pollBody?.data ?? null) as { status?: unknown; generated?: unknown; error?: unknown } | null;
    const status = data && typeof data.status === "string" ? data.status : "";
    if (!status) throw new MagnificApiError("Risposta Magnific malformata: stato del task mancante.");

    if (status === "COMPLETED") {
      completed = data;
      break;
    }
    if (status === "FAILED") {
      const detail = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : "Errore generico del servizio.";
      throw new MagnificApiError(`Generazione fallita: ${detail}`);
    }
    // CREATED / IN_PROGRESS: continua ad attendere
  }

  if (!completed) {
    throw new MagnificApiError("Generazione non completata entro il tempo massimo. Riprova tra poco.");
  }

  // 3) verifica del risultato e del dominio CDN
  const generated = completed.generated;
  if (!Array.isArray(generated) || generated.length === 0) {
    throw new MagnificApiError("Risposta Magnific malformata: nessuna immagine generata.");
  }
  const cdnUrl = typeof generated[0] === "string" ? generated[0].trim() : "";
  if (!cdnUrl || !isAllowedCdnUrl(cdnUrl)) {
    throw new MagnificApiError("URL dell'immagine generata non riconosciuto: download bloccato per sicurezza.");
  }

  // 4) download + salvataggio nella Media Library locale
  const { buffer, mimeType } = await downloadImage(cdnUrl);
  if (!isImageMime(mimeType)) throw new MagnificApiError(`Tipo di file non valido: ${mimeType}.`);

  const saved = await saveUploadedFile({
    buffer,
    originalName: `magnific-${Date.now()}.${imageExtensionForMime(mimeType)}`,
    mimeType,
  });

  return {
    url: saved.url,
    provider: "magnific",
    pathname: saved.pathname,
    mimeType: saved.mimeType,
    size: saved.size,
    sourceUrl: cdnUrl,
  };
}

/**
 * Provider immagini Magnific: genera immagini da testo con il modello Mystic
 * di Magnific (docs.magnific.com), scarica la copia nel filesystem locale e
 * la rende disponibile alla Media Library.
 */
export class MagnificImageProvider implements ImageProvider {
  readonly name = "magnific";
  readonly canGenerate = true;

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    return generateWithMagnific(prompt, options);
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    const saved = await saveUploadedFile({
      buffer: file.buffer,
      originalName: file.originalName,
      mimeType: file.mimeType,
    });
    return { url: saved.url, provider: this.name, pathname: saved.pathname, mimeType: saved.mimeType, size: saved.size };
  }
}
