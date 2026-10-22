import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { it } from "date-fns/locale";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(d: Date | string | null | undefined, fmt = "dd/MM/yyyy HH:mm") {
  if (!d) return "—";
  const date = typeof d === "string" ? parseISO(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, fmt, { locale: it });
}

export function formatDay(d: Date | string | null | undefined, fmt = "EEEE d MMMM yyyy") {
  if (!d) return "—";
  const date = typeof d === "string" ? parseISO(d) : d;
  return format(date, fmt, { locale: it });
}

export function timeAgo(d: Date | string | null | undefined) {
  if (!d) return "—";
  const date = typeof d === "string" ? parseISO(d) : d;
  return formatDistanceToNow(date, { addSuffix: true, locale: it });
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[àáâäã]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôöõ]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function uniqueFilename(original: string) {
  const ext = original.includes(".") ? original.slice(original.lastIndexOf(".")) : "";
  const base = original.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}-${stamp}${rand}${ext.toLowerCase()}`.replace(/--+/g, "-");
}

export function isImageMime(mime: string | undefined) {
  if (!mime) return false;
  return mime.startsWith("image/");
}

/**
 * Estensione del file per un MIME immagine.
 *
 * Vive in utils perché due moduli ne hanno bisogno (il provider Magnific e il
 * downloader delle immagini del catalogo) e il fallback `png` deve essere
 * identico: un'estensione diversa per lo stesso MIME produrrebbe due nomi
 * diversi per lo stesso formato.
 */
export function imageExtensionForMime(mime: string | undefined): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}

export function isVideoMime(mime: string | undefined) {
  if (!mime) return false;
  return mime.startsWith("video/");
}

/**
 * MIME type dei formati video riconoscibili dall'estensione.
 *
 * Serve quando un file video non ha una firma riconoscibile nei magic bytes
 * (alcuni MOV/MKV prodotti da exporter non standard): l'estensione dichiarata
 * nel nome diventa l'ultimo indizio prima di rifiutare il file.
 */
export const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** MIME video dedotto dall'estensione del nome file, o null. */
export function mimeFromFilename(filename: string | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  return VIDEO_MIME_BY_EXTENSION[ext] ?? null;
}

/** Estensione canonica per un MIME video, o null. */
export function videoExtensionForMime(mime: string | undefined): string | null {
  switch (mime) {
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    case "video/x-matroska":
      return "mkv";
    case "video/x-msvideo":
      return "avi";
    default:
      return null;
  }
}

/**
 * Kind di ContentAsset dedotto dal MIME reale del file.
 *
 * Usato ovunque un asset venga creato senza kind esplicito: un video non deve
 * finire nel database come IMAGE solo perché il chiamante non ha valorizzato
 * il campo.
 */
export function assetKindFromMime(mime: string | null | undefined): "IMAGE" | "VIDEO" | "FILE" {
  if (isImageMime(mime ?? undefined)) return "IMAGE";
  if (isVideoMime(mime ?? undefined)) return "VIDEO";
  return "FILE";
}

export function truncate(s: string, max = 80) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}