"use client";

import { useMemo, useState } from "react";
import { Clapperboard, Image as ImageIcon, Search, Sparkles } from "lucide-react";
import { Button, Card, Badge, EmptyState } from "@/components/ui";
import { ManualEditor } from "@/components/manual-editor";
import type { CuratedDestination } from "@/lib/curated/media";

type ManualTarget = { slug: string; name: string; mode: "video" | "post" } | null;

export function GenerateStudio({
  destinations,
}: {
  destinations: CuratedDestination[];
}) {
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState<ManualTarget>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter(
      (d) => d.name.toLowerCase().includes(q) || d.slug.includes(q)
    );
  }, [query, destinations]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900 dark:text-slate-100">
            <Sparkles className="h-5 w-5 text-sky-600" />
            Crea video e post
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Apri l&apos;editor: per i video scegli clip, ordine, durata e scritte; per i
            post scegli la foto e il testo da stampare sopra.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca destinazione…"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 dark:text-slate-200 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Nessuna destinazione"
          description={
            query
              ? "Nessuna destinazione corrisponde alla ricerca. Aggiungi foto o clip in public/curated per vederla qui."
              : "Non è ancora presente nessuna destinazione curata. Aggiungi foto in public/curated/photos/<destinazione> e clip in public/curated/videos/<destinazione>."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((d) => (
            <Card key={d.slug} className="flex flex-col gap-3 p-4">
              <div>
                <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {d.name}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge className="bg-sky-50 text-sky-600 border-sky-200">
                    <ImageIcon className="mr-1 h-3 w-3" />
                    {d.photoCount} foto
                  </Badge>
                  <Badge className="bg-violet-50 text-violet-600 border-violet-200">
                    <Clapperboard className="mr-1 h-3 w-3" />
                    {d.videoCount} clip
                  </Badge>
                </div>
              </div>

              <div className="mt-auto flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  className="flex-1"
                  onClick={() => setManual({ slug: d.slug, name: d.name, mode: "video" })}
                >
                  <Clapperboard className="h-4 w-4" />
                  Video
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setManual({ slug: d.slug, name: d.name, mode: "post" })}
                >
                  <ImageIcon className="h-4 w-4" />
                  Post
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ManualEditor
        open={manual !== null}
        slug={manual?.slug ?? ""}
        name={manual?.name ?? ""}
        mode={manual?.mode ?? "video"}
        onClose={() => setManual(null)}
      />
    </div>
  );
}
