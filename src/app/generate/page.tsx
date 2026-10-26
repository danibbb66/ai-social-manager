import { listCuratedDestinations } from "@/lib/curated/media";
import { GenerateStudio } from "@/components/generate";

export const dynamic = "force-dynamic";

// La generazione video su Vercel (download clip da R2 + ffmpeg + upload output)
// supera il limite di default di 10s del piano Hobby: senza questo valore la
// Server Action viene troncata a metà con un errore generico.
export const maxDuration = 60;

export default async function GeneratePage() {
  const destinations = await listCuratedDestinations();
  return <GenerateStudio destinations={destinations} />;
}
