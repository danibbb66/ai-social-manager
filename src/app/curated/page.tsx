import { listCuratedDestinations } from "@/lib/curated/media";
import { listKeys, isCloudStorage } from "@/lib/storage";
import { Card, PageHeader, EmptyState } from "@/components/ui";
import {
  CuratedUploader,
  type CuratedDestinationOption,
} from "@/components/curated-uploader";
import {
  CuratedManager,
  type CuratedDest,
  type CuratedFile,
} from "@/components/curated-manager";

export const dynamic = "force-dynamic";

/** Estrae `<file>` dalla chiave `curated/<kind>/<slug>/<file>`. */
function basename(key: string): string {
  return key.split("/").pop() ?? key;
}

export default async function CuratedPage() {
  let destinations: CuratedDestinationOption[] = [];
  try {
    destinations = await listCuratedDestinations();
  } catch (e) {
    console.error("[page:curated] caricamento destinazioni fallito", e);
  }

  // Chiavi dei media per la lista/eliminazione, raggruppate per slug.
  const photoBySlug = new Map<string, CuratedFile[]>();
  const videoBySlug = new Map<string, CuratedFile[]>();
  let audios: CuratedFile[] = [];

  try {
    const [photoKeys, videoKeys, audioKeys] = await Promise.all([
      listKeys("curated/photos"),
      listKeys("curated/videos"),
      listKeys("audio"),
    ]);
    for (const k of photoKeys) {
      // curated/photos/<slug>/<file>
      const parts = k.split("/");
      if (parts.length < 4) continue;
      const slug = parts[2];
      (photoBySlug.get(slug) ?? photoBySlug.set(slug, []).get(slug)!).push({
        key: k,
        name: basename(k),
      });
    }
    for (const k of videoKeys) {
      const parts = k.split("/");
      if (parts.length < 4) continue;
      const slug = parts[2];
      (videoBySlug.get(slug) ?? videoBySlug.set(slug, []).get(slug)!).push({
        key: k,
        name: basename(k),
      });
    }
    audios = audioKeys
      .filter((k) => /\.(m4a|mp3|wav|aac|ogg)$/i.test(k))
      .map((k) => ({ key: k, name: basename(k) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error("[page:curated] elenco file fallito", e);
  }

  const managed: CuratedDest[] = destinations.map((d) => ({
    slug: d.slug,
    name: d.name,
    photos: (photoBySlug.get(d.slug) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    videos: (videoBySlug.get(d.slug) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const cloud = isCloudStorage();

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Clip & foto"
        description="Aggiungi foto, clip video e audio alle cartelle usate da Crea video & post. Chiunque apra l'app può caricare e gestire i file."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <CuratedUploader destinations={destinations} />

          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              File caricati
            </h2>
            <CuratedManager destinations={managed} audios={audios} />
          </div>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Dove finiscono i file
            </h3>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {cloud
                ? "Salvataggio su Cloudflare R2 (cloud condiviso tra tutti i PC): ogni caricamento è subito visibile ovunque."
                : "Salvataggio locale nella cartella public/ di questo computer."}
            </p>
          </Card>

          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Foto / clip usate
            </h3>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Ogni media viene usato una sola volta nella generazione. Eliminando
              un file qui lo rimuovi anche dalla disponibilità per i prossimi
              contenuti.
            </p>
          </Card>
        </div>
      </div>

      {cloud ? null : (
        <EmptyState
          title="Modalità locale"
          description="Stai salvando sul disco di questo computer. Su Vercel (cloud) i file andranno su R2 e saranno condivisi tra tutti i dispositivi."
        />
      )}
    </div>
  );
}
