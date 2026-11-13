import { listKeys } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Elenco delle tracce audio disponibili per il sottofondo dei reel (chiave
 * `audio/` nel bucket R2 / `public/audio` in locale). L'editor manuale le
 * mostra in un menu a tendina per scegliere una traccia specifica invece della
 * rotazione automatica.
 */
export async function GET() {
  try {
    const keys = (await listKeys("audio"))
      .filter((k) => /\.(m4a|mp3|wav|aac|ogg)$/i.test(k))
      .sort();
    const audios = keys.map((key) => ({
      key,
      name: key.split("/").pop() ?? key,
    }));
    return Response.json({ audios });
  } catch {
    return Response.json({ audios: [] });
  }
}
