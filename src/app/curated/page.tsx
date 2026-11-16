import { listCuratedDestinations } from "@/lib/curated/media";
import { listKeys, isCloudStorage } from "@/lib/storage";
import { Card, PageHeader, EmptyState } from "@/components/ui";
import {
  CuratedUploader,
  type CuratedDestinationOption,
} from "@/components/curated-uploader";

export const dynamic = "force-dynamic";

export default async function CuratedPage() {
  let destinations: CuratedDestinationOption[] = [];
  try {
    destinations = await listCuratedDestinations();
  } catch (e) {
    console.error("[page:curated] caricamento destinazioni fallito", e);
  }

  let audioCount = 0;
  try {
    const audioKeys = (await listKeys("audio")).filter((k) =>
      /\.(m4a|mp3|wav|aac|ogg)$/i.test(k)
    );
    audioCount = audioKeys.length;
  } catch (e) {
    console.error("[page:curated] conteggio audio fallito", e);
  }

  const cloud = isCloudStorage();

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Carica media"
        description="Aggiungi foto, clip video e audio alle cartelle condivise (Cloudflare R2). Chiunque apra l'app può caricare: i file compaiono subito in Crea video & post."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <CuratedUploader destinations={destinations} />

        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Destinazioni presenti
            </h3>
            {destinations.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Nessuna cartella curata. Carica la prima foto o clip video.
              </p>
            ) : (
              <ul className="space-y-2">
                {destinations.map((d) => (
                  <li
                    key={d.slug}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200">
                      {d.name}
                    </span>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {d.photoCount} foto · {d.videoCount} clip
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Audio
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {audioCount} tracce nella cartella{" "}
              <code className="font-mono">audio/</code>
            </p>
          </Card>

          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Dove finiscono i file
            </h3>
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {cloud
                ? "Salvataggio su Cloudflare R2 (cloud condiviso tra tutti i PC)."
                : "Salvataggio locale nella cartella public/ di questo computer."}
              {" "}I file vengono letti direttamente da qui, quindi sono subito
              usabili senza altri passaggi.
            </p>
          </Card>
        </div>
      </div>

      {cloud ? null : (
        <EmptyState
          title="Modalità locale"
          description="Stai salvando sul disco di questo computer. Su Vercel (cloud) i file andranno automaticamente su R2 e saranno condivisi tra tutti i dispositivi."
        />
      )}
    </div>
  );
}
