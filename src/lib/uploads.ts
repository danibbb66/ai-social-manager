import fs from "node:fs/promises";
import path from "node:path";
import { uniqueFilename, isImageMime, isVideoMime } from "@/lib/utils";

export interface SavedFile {
  url: string;
  pathname: string;
  mimeType: string;
  size: number;
}

/** kind persistito su ContentAsset per i file caricati dall'utente. */
export type UploadKind = "IMAGE" | "VIDEO";

/** Formato caricato ma non riconoscibile come immagine né come video. */
export class UnsupportedMediaTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}

/**
 * Brand ISO-BMFF (byte 8-12) dei formati che sono immagini pur avendo un
 * box 'ftyp' identico a quello di MP4 e QuickTime. Senza questa distinzione
 * una AVIF/HEIC verrebbe classificata come video.
 */
const ISOBMFF_IMAGE_BRANDS = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "mif1",
  "msf1",
]);

/** Brand ISO-BMFF dei formati video. Gli altri restano non riconosciuti. */
const ISOBMFF_VIDEO_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp71",
  "dash",
  "avc1",
  "mmp4",
  "f4v ",
  "M4V ",
  "M4A ",
  "qt  ",
]);

/**
 * Rileva il MIME type REALE di un buffer leggendo i magic bytes.
 *
 * Non si fida del MIME dichiarato dal client né del nome del file: un
 * "video.jpg" contenente bytes MP4 viene riconosciuto come video.
 * Restituisce null quando il formato non ha una firma riconosciuta, così il
 * chiamante può decidere con un proprio fallback.
 */
export function sniffMediaMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // --- Immagini ---
  // JPEG: SOI + inizio di un marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // PNG: firma a 8 byte
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF87a / GIF89a
  const gif = buffer.slice(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  // WebP: contenitore RIFF con formato WEBP
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // --- Video ---
  // WebM / Matroska: intestazione EBML
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "video/webm";
  }
  // MP4 / QuickTime: box 'ftyp' all'offset 4, brand all'offset 8
  if (buffer.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.slice(8, 12).toString("ascii");
    if (ISOBMFF_IMAGE_BRANDS.has(brand)) return "image/avif";
    if (!ISOBMFF_VIDEO_BRANDS.has(brand)) return null;
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }

  return null;
}

/**
 * Determina il kind (IMAGE/VIDEO) e il MIME type di un file caricato.
 *
 * I magic bytes hanno la precedenza: se il contenuto è riconoscibile, il
 * risultato dipende solo dai byte reali. Il MIME dichiarato dal client viene
 * usato soltanto come ripiego per i formati senza firma nota (ad esempio
 * .mov non standard), evitando di rompere caricamenti oggi funzionanti.
 * In ogni altro caso il file viene rifiutato.
 */
export function detectUploadKind(buffer: Buffer, declaredMime?: string): {
  mimeType: string;
  kind: UploadKind;
} {
  const sniffed = sniffMediaMime(buffer);
  const mime = (sniffed ?? declaredMime ?? "").split(";")[0].trim().toLowerCase();

  if (isImageMime(mime)) return { mimeType: mime, kind: "IMAGE" };
  if (isVideoMime(mime)) return { mimeType: mime, kind: "VIDEO" };

  const seen = sniffed ?? mime ?? "";
  throw new UnsupportedMediaTypeError(
    `Tipo di file non supportato${seen ? ` (${seen})` : ""}: carica un'immagine ` +
      `(JPEG, PNG, GIF, WebP, AVIF) o un video (MP4, MOV, WebM).`
  );
}

/** Salva un file caricato nella cartella pubblica dedicata (immagini/video/altro) */
export async function saveUploadedFile(input: {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}): Promise<SavedFile> {
  const mime = input.mimeType || "application/octet-stream";
  const sub = isImageMime(mime)
    ? "images"
    : isVideoMime(mime)
      ? "videos"
      : "files";
  const dir = path.join(process.cwd(), "public", "uploads", sub);
  await fs.mkdir(dir, { recursive: true });
  const filename = uniqueFilename(input.originalName);
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, input.buffer);
  return {
    url: `/uploads/${sub}/${filename}`,
    pathname: filepath,
    mimeType: mime,
    size: input.buffer.length,
  };
}

/**
 * Il file dietro un URL di upload esiste ancora su disco?
 *
 * Serve a distinguere una riga `ContentAsset` ancora valida da una che punta a
 * un file sparito: riusare la seconda produrrebbe un contenuto con immagine
 * rotta, che è peggio di rifare il download.
 */
export async function uploadedFileExists(url: string): Promise<boolean> {
  const match = url.match(/^\/uploads\/([a-z]+)\/([^/]+)$/);
  if (!match) return false;
  const [, sub, name] = match;
  if (sub === ".." || name === ".." || !name) return false;
  try {
    await fs.access(path.join(process.cwd(), "public", "uploads", sub, name));
    return true;
  } catch {
    return false;
  }
}

/** Elimina un file dagli upload (il percorso deve essere sotto /uploads) */
export async function deleteUploadedFile(url: string): Promise<boolean> {
  const match = url.match(/^\/uploads\/([a-z]+)\/([^/]+)$/);
  if (!match) return false;
  const [, sub, name] = match;
  if (sub === ".." || name === ".." || !name) return false;
  const filepath = path.join(process.cwd(), "public", "uploads", sub, name);
  try {
    await fs.access(filepath);
    await fs.unlink(filepath);
    return true;
  } catch {
    return false;
  }
}