import { bucketUsage } from "@/lib/storage";

/**
 * Spazio occupato nel bucket R2, con cache breve.
 *
 * L'elenco completo del bucket costa qualche chiamata: la dashboard non deve
 * farlo a ogni caricamento pagina. La cache in memoria dura 5 minuti per
 * istanza — abbastanza per non pesare e per vedere comunque l'andamento.
 *
 * Il limite gratuito Cloudflare R2 è 10 GB: configurabile con
 * `R2_STORAGE_LIMIT_GB` se un giorno cambia piano.
 */

export interface StorageUsage {
  files: number;
  usedBytes: number;
  limitBytes: number;
  /** Percentuale usata (0-100, arrotondata). */
  percent: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; value: StorageUsage | null } | null = null;

function limitBytesFromEnv(): number {
  const gb = Number(process.env.R2_STORAGE_LIMIT_GB ?? "10");
  const safe = Number.isFinite(gb) && gb > 0 ? gb : 10;
  return Math.round(safe * 1024 * 1024 * 1024);
}

export async function getStorageUsage(): Promise<StorageUsage | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let value: StorageUsage | null = null;
  try {
    const usage = await bucketUsage();
    if (usage) {
      const limitBytes = limitBytesFromEnv();
      value = {
        files: usage.files,
        usedBytes: usage.bytes,
        limitBytes,
        percent: Math.min(100, Math.round((usage.bytes / limitBytes) * 100)),
      };
    }
  } catch {
    // Bucket non raggiungibile: la dashboard mostra semplicemente il riquadro
    // "non disponibile" invece di rompersi.
    value = null;
  }

  cache = { at: Date.now(), value };
  return value;
}
