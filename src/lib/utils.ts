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

export function truncate(s: string, max = 80) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max).trimEnd() + "…" : s;
}