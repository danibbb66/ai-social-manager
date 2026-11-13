import { NextRequest } from "next/server";
import { listCuratedPhotos, listCuratedVideos } from "@/lib/curated/media";
import { publicUrlFor } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Elenco dei media curati di una destinazione per l'editor manuale: chiave di
 * storage (usata per la generazione) + URL pubblico (per mostrare l'anteprima
 * foto in UI). Espone TUTTE le clip/foto, non solo quelle "non usate": in
 * modalità manuale l'utente può riusare esplicitamente un media già usato.
 */
export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get("slug") ?? "").trim();
  if (!/^[a-z0-9_]+$/.test(slug)) {
    return Response.json({ photos: [], videos: [] });
  }

  const [photos, videos] = await Promise.all([
    listCuratedPhotos(slug),
    listCuratedVideos(slug),
  ]);

  const toItem = (key: string) => ({
    key,
    url: publicUrlFor(key),
    name: key.split("/").pop() ?? key,
  });

  return Response.json({
    photos: photos.map(toItem),
    videos: videos.map(toItem),
  });
}
