import { NextRequest } from "next/server";
import {
  listCuratedPhotos,
  listCuratedVideos,
  usedCuratedPhotoKeys,
  usedCuratedVideoKeys,
} from "@/lib/curated/media";
import { publicUrlFor } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Elenco dei media curati di una destinazione per l'editor manuale: chiave di
 * storage (usata per la generazione) + URL pubblico (per mostrare l'anteprima
 * foto in UI).
 *
 * Di default espone SOLO i media ancora disponibili (non usati da nessun
 * contenuto): ogni foto/clip può essere impiegata una sola volta, quindi il
 * flusso "Crea" non deve poter generare contenuti "cloni". In modalità edit
 * (`?includeUsed=1`) i media già usati vengono inclusi, così l'utente può
 * rigenerare un contenuto ripartendo dalle stesse clip/foto.
 */
export async function GET(req: NextRequest) {
  const slug = (req.nextUrl.searchParams.get("slug") ?? "").trim();
  const includeUsed = (req.nextUrl.searchParams.get("includeUsed") ?? "") === "1";
  if (!/^[a-z0-9_]+$/.test(slug)) {
    return Response.json({ photos: [], videos: [] });
  }

  const [photos, videos, usedPhotos, usedVideos] = await Promise.all([
    listCuratedPhotos(slug),
    listCuratedVideos(slug),
    usedCuratedPhotoKeys(),
    usedCuratedVideoKeys(),
  ]);

  const toItem = (key: string) => ({
    key,
    url: publicUrlFor(key),
    name: key.split("/").pop() ?? key,
  });

  return Response.json({
    photos: (includeUsed ? photos : photos.filter((k) => !usedPhotos.has(k))).map(toItem),
    videos: (includeUsed ? videos : videos.filter((k) => !usedVideos.has(k))).map(toItem),
  });
}
