import { listCuratedDestinations } from "@/lib/curated/media";
import { GenerateStudio } from "@/components/generate";

export const dynamic = "force-dynamic";

export default async function GeneratePage() {
  const destinations = await listCuratedDestinations();
  return <GenerateStudio destinations={destinations} />;
}
