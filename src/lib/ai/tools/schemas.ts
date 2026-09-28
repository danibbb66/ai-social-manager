import { z } from "zod";

export const VALID_PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK"] as const;
const PlatformEnum = z.enum(VALID_PLATFORMS);

/**
 * Normalizza il parametro "platforms" in un array di stringhe valide.
 * Il modello può inviare per errore una singola stringa ("INSTAGRAM")
 * o una stringa separata da virgole: viene convertita in array.
 */
function toPlatformArray(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .split(/[\s,;]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  }
  return value;
}

export const platformsField = z
  .preprocess(
    toPlatformArray,
    z.array(PlatformEnum).min(0)
  )
  .describe('SEMPRE un array di stringhe, es. ["INSTAGRAM"]. Mai una singola stringa, mai una virgola.');

/** Normalizza "hashtags" in una stringa separata da spazi (accetta anche un array). */
function toHashtagString(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(String).join(" ");
  return value;
}

export const hashtagsField = z
  .preprocess(toHashtagString, z.string())
  .describe('SEMPRE una stringa separata da spazi, es. "#parigi #weekend #viaggio".');