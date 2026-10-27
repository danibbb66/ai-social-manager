"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clapperboard,
  Image as ImageIcon,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { Button, Card, Badge, Textarea, EmptyState } from "@/components/ui";
import { createVideoAction, createPostAction } from "@/lib/actions/generate";
import type { CuratedDestination } from "@/lib/curated/media";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export function GenerateStudio({
  destinations,
}: {
  destinations: CuratedDestination[];
}) {
  const [query, setQuery] = useState("");
  const [openPost, setOpenPost] = useState<string | null>(null);
  const [callouts, setCallouts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, Status>>({});
  const router = useRouter();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter(
      (d) => d.name.toLowerCase().includes(q) || d.slug.includes(q)
    );
  }, [query, destinations]);

  function setStatus(slug: string, status: Status) {
    setStates((s) => ({ ...s, [slug]: status }));
  }

  async function runVideo(d: CuratedDestination) {
    setStatus(d.slug, { kind: "busy" });
    const res = await createVideoAction({ destination: d.name });
    setStatus(
      d.slug,
      res.ok ? { kind: "ok", message: res.message } : { kind: "error", message: res.message }
    );
    router.refresh();
  }

  async function runPost(d: CuratedDestination) {
    setStatus(d.slug, { kind: "busy" });
    const res = await createPostAction({
      destination: d.name,
      callout: callouts[d.slug]?.trim() || null,
    });
    setStatus(
      d.slug,
      res.ok ? { kind: "ok", message: res.message } : { kind: "error", message: res.message }
    );
    if (res.ok) setOpenPost(null);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
            <Sparkles className="h-5 w-5 text-sky-600" />
            Crea video e post
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Scegli una destinazione e genera il video o il post direttamente, senza
            passare dalla chat. Ogni risultato resta in stato DRAFT.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca destinazione…"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
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
          {filtered.map((d) => {
            const s = states[d.slug];
            const isOpen = openPost === d.slug;
            return (
              <Card key={d.slug} className="flex flex-col gap-3 p-4">
                <div>
                  <div className="text-base font-semibold text-slate-900">
                    {d.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge className="bg-sky-50 text-sky-600 border-sky-200">
                      <ImageIcon className="mr-1 h-3 w-3" />
                      {d.remainingPhotoCount} foto
                    </Badge>
                    <Badge className="bg-violet-50 text-violet-600 border-violet-200">
                      <Clapperboard className="mr-1 h-3 w-3" />
                      {d.remainingVideoCount} clip
                    </Badge>
                  </div>
                </div>

                <div className="mt-auto flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={d.remainingVideoCount === 0 ? "secondary" : "primary"}
                      disabled={s?.kind === "busy" || d.remainingVideoCount === 0}
                      title={
                        d.remainingVideoCount === 0
                          ? "Clip già usate: ricarica la cartella public/curated/videos con nuovi video"
                          : "Genera il video"
                      }
                      onClick={() => runVideo(d)}
                      className={
                        d.remainingVideoCount === 0 ? "flex-1 border-dashed text-slate-400" : "flex-1"
                      }
                    >
                      {s?.kind === "busy" && openPost !== d.slug ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Clapperboard className="h-4 w-4" />
                      )}
                      {d.remainingVideoCount === 0 ? "Esaurito" : "Video"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={s?.kind === "busy" || d.remainingPhotoCount === 0}
                      title={
                        d.remainingPhotoCount === 0
                          ? "Foto già usate: ricarica la cartella public/curated/photos con nuove foto"
                          : "Genera il post"
                      }
                      onClick={() => setOpenPost(isOpen ? null : d.slug)}
                      className={
                        d.remainingPhotoCount === 0 ? "flex-1 border-dashed text-slate-400" : "flex-1"
                      }
                    >
                      <ImageIcon className="h-4 w-4" />
                      {d.remainingPhotoCount === 0 ? "Esaurito" : "Post"}
                    </Button>
                  </div>

                  {isOpen && (
                    <div className="flex flex-col gap-2 border-t border-slate-100 pt-2">
                      <Textarea
                        autoFocus
                        rows={3}
                        placeholder="Testo opzionale da stampare nel post (es. hotel 4★, mezza pensione, da € 1299)"
                        value={callouts[d.slug] ?? ""}
                        onChange={(e) =>
                          setCallouts((c) => ({ ...c, [d.slug]: e.target.value }))
                        }
                      />
                      <Button
                        size="sm"
                        variant="success"
                        disabled={s?.kind === "busy"}
                        onClick={() => runPost(d)}
                      >
                        {s?.kind === "busy" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Genera post
                      </Button>
                    </div>
                  )}

                  {s?.kind === "ok" && (
                    <p className="flex items-start gap-1 text-xs text-emerald-600">
                      {s.message}
                    </p>
                  )}
                  {s?.kind === "error" && (
                    <p className="flex items-start gap-1 text-xs text-red-600">
                      {s.message}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
