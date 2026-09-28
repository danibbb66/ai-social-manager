import Link from "next/link";
import { listAssets } from "@/lib/services/media";
import { listContents } from "@/lib/services/content";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { AssetCard, UploadButton } from "@/components/media-tools";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ kind?: string }>;

export default async function MediaPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const kind = params.kind ?? "ALL";

  let assets: Awaited<ReturnType<typeof listAssets>> = [];
  let contents: Awaited<ReturnType<typeof listContents>> = [];
  try {
    assets = await listAssets(
      kind === "ALL" ? {} : { kind: kind as never }
    );
  } catch (e) {
    console.error("[page:media] caricamento asset fallito", e);
  }
  try {
    contents = await listContents();
  } catch (e) {
    console.error("[page:media] caricamento contenuti fallito", e);
  }

  const contentOptions = contents.map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
  }));

  const filters = [
    { value: "ALL", label: "Tutti" },
    { value: "IMAGE", label: "Immagini" },
    { value: "VIDEO", label: "Video" },
    { value: "AUDIO", label: "Audio" },
    { value: "FILE", label: "File" },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Media"
        description="Libreria di immagini e video pronti per i contenuti."
        action={<UploadButton />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <Link
            key={f.value}
            href={f.value === "ALL" ? "/media" : `/media?kind=${f.value}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              kind === f.value
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {assets.length === 0 ? (
        <EmptyState
          title="Nessun file"
          description="Carica immagini o video che potrai allegare ai contenuti."
          action={<UploadButton />}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={JSON.parse(JSON.stringify(a))}
              contentOptions={contentOptions}
            />
          ))}
        </div>
      )}

      <Card className="mt-6 p-4">
        <p className="text-xs text-slate-500">
          I file vengono salvati in{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            /public/uploads
          </code>{" "}
          e sono serviti staticamente. Da questa libreria puoi associare un
          file a un contenuto con <strong>Associa a contenuto</strong>; dalla
          pagina di un contenuto puoi anche caricare file già collegati.
        </p>
      </Card>
    </div>
  );
}
