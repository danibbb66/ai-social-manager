import { listKeys } from "@/lib/storage";

/**
 * Lettura delle cartelle "curate" (media selezionati a mano dall'utente).
 *
 * L'utente riempie `public/curated/photos/<slug>/` con le foto approvate e
 * `public/curated/videos/<slug>/` con le clip video approvate, una cartella per
 * destinazione. In cloud gli stessi file vivono in R2 sotto le chiavi
 * `curated/<kind>/<slug>/…`.
 *
 * Questo modulo restituisce SEMPRE le CHIAVI di storage (percorsi relativi a
 * `public/`), non i percorsi assoluti del disco: i chiamanti le passano a
 * `materialize`/`readFileBuffer`, che funzionano sia in locale sia in cloud.
 *
 * Una cartella vuota o assente NON è un errore: si restituisce `[]` e il
 * chiamante ricade sul provider stock (Pixabay/Pexels). Nessun file viene mai
 * scaricato o creato qui: solo lettura di ciò che l'utente ha già messo.
 */

/** Estensioni immagine accettate nella cartella foto. */
const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|avif|gif)$/i;

/** Estensioni video accettate nella cartella clip. */
const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v)$/i;

/** Convalida di sicurezza dello slug: solo lettere, cifre e underscore. */
function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9_]+$/.test(slug);
}

/** Chiavi delle foto curate di una destinazione (o `[]`). */
export async function listCuratedPhotos(slug: string | null): Promise<string[]> {
  if (!slug || !isSafeSlug(slug)) return [];
  const keys = await listKeys(`curated/photos/${slug}`);
  return keys.filter((k) => PHOTO_EXTENSIONS.test(k));
}

/** Chiavi delle clip video curate di una destinazione (o `[]`). */
export async function listCuratedVideos(slug: string | null): Promise<string[]> {
  if (!slug || !isSafeSlug(slug)) return [];
  const keys = await listKeys(`curated/videos/${slug}`);
  return keys.filter((k) => VIDEO_EXTENSIONS.test(k));
}

/** Etichetta leggibile da mostrare all'utente per uno slug di cartella. */
const DESTINATION_DISPLAY: Record<string, string> = {
  mare_italia: "Mare Italia",
  corfu: "Corfù",
};

export function curatedDestinationName(slug: string): string {
  if (DESTINATION_DISPLAY[slug]) return DESTINATION_DISPLAY[slug];
  return slug
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export interface CuratedDestination {
  slug: string;
  name: string;
  photoCount: number;
  videoCount: number;
}

/**
 * Le destinazioni curate (con almeno una cartella foto o video): è l'unione
 * delle chiavi realmente presenti sotto `curated/photos` e `curated/videos`.
 * È la fonte di verità per mostrare i pulsanti "Crea video"/"Crea post", senza
 * dipendere dalla base di conoscenza né dai nomi scritti a mano.
 */
export async function listCuratedDestinations(): Promise<CuratedDestination[]> {
  const slugs = new Set<string>();
  for (const kind of ["photos", "videos"]) {
    const keys = await listKeys(`curated/${kind}`);
    for (const k of keys) {
      // formato chiave: curated/<kind>/<slug>/<file>
      const parts = k.split("/");
      if (parts.length >= 4 && isSafeSlug(parts[2])) slugs.add(parts[2]);
    }
  }

  const out: CuratedDestination[] = [];
  for (const slug of slugs) {
    const [photos, videos] = await Promise.all([
      listCuratedPhotos(slug),
      listCuratedVideos(slug),
    ]);
    out.push({
      slug,
      name: curatedDestinationName(slug),
      photoCount: photos.length,
      videoCount: videos.length,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "it"));
}
