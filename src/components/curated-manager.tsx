"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";

export type CuratedFile = { key: string; name: string };
export type CuratedDest = {
  slug: string;
  name: string;
  photos: CuratedFile[];
  videos: CuratedFile[];
};

function FileRow({
  file,
  onDelete,
  busy,
}: {
  file: CuratedFile;
  onDelete: (key: string) => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
      <span className="min-w-0 truncate font-mono text-xs text-slate-600 dark:text-slate-300">
        {file.name}
      </span>
      <button
        type="button"
        onClick={() => onDelete(file.key)}
        disabled={busy}
        aria-label={`Elimina ${file.name}`}
        className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function CuratedManager({
  destinations,
  audios,
}: {
  destinations: CuratedDest[];
  audios: CuratedFile[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function doDelete(key: string, name: string) {
    if (busyKey) return;
    if (!window.confirm(`Eliminare "${name}"?\n\nIl file verrà rimosso dal cloud (R2) e non sarà più usabile.`)) {
      return;
    }
    setBusyKey(key);
    try {
      const res = await fetch("/api/curated/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        window.alert(body?.message ?? "Eliminazione non riuscita.");
      } else {
        router.refresh();
      }
    } catch {
      window.alert("Errore di rete durante l'eliminazione.");
    } finally {
      setBusyKey(null);
    }
  }

  const totalFiles =
    destinations.reduce((a, d) => a + d.photos.length + d.videos.length, 0) +
    audios.length;

  if (totalFiles === 0) {
    return (
      <EmptyState
        title="Nessun file"
        description="Carica le prime clip o foto; compariranno qui per essere gestite."
      />
    );
  }

  return (
    <div className="space-y-3">
      {destinations.map((d) => {
        const expanded = open === d.slug;
        const count = d.photos.length + d.videos.length;
        return (
          <Card key={d.slug} className="overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : d.slug)}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                {expanded ? (
                  <ChevronDown className="h-4 w-4 text-slate-400" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                )}
                {d.name}
              </span>
              <span className="text-xs text-slate-500">
                {d.photos.length} foto · {d.videos.length} clip
              </span>
            </button>
            {expanded ? (
              <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                {count === 0 ? (
                  <p className="px-1 py-2 text-xs text-slate-400">Cartella vuota.</p>
                ) : (
                  <div className="space-y-2">
                    {d.videos.length > 0 ? (
                      <div>
                        <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          Clip video
                        </p>
                        <ul>
                          {d.videos.map((f) => (
                            <FileRow
                              key={f.key}
                              file={f}
                              busy={busyKey === f.key}
                              onDelete={(k) => doDelete(k, f.name)}
                            />
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {d.photos.length > 0 ? (
                      <div>
                        <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          Foto
                        </p>
                        <ul>
                          {d.photos.map((f) => (
                            <FileRow
                              key={f.key}
                              file={f}
                              busy={busyKey === f.key}
                              onDelete={(k) => doDelete(k, f.name)}
                            />
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </Card>
        );
      })}

      {audios.length > 0 ? (
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => setOpen(open === "__audio__" ? null : "__audio__")}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
          >
            <span className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
              {open === "__audio__" ? (
                <ChevronDown className="h-4 w-4 text-slate-400" />
              ) : (
                <ChevronRight className="h-4 w-4 text-slate-400" />
              )}
              Audio
            </span>
            <span className="text-xs text-slate-500">{audios.length} tracce</span>
          </button>
          {open === "__audio__" ? (
            <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
              <ul>
                {audios.map((f) => (
                  <FileRow
                    key={f.key}
                    file={f}
                    busy={busyKey === f.key}
                    onDelete={(k) => doDelete(k, f.name)}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
