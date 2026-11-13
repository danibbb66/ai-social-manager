"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clapperboard,
  Image as ImageIcon,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, EmptyState, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import {
  createManualPostAction,
  createManualVideoAction,
} from "@/lib/actions/generate";

interface MediaItem {
  key: string;
  url: string;
  name: string;
}

interface ClipSelection {
  key: string;
  name: string;
  url: string;
  durationSec: number;
  caption: string;
}

const FONT_OPTIONS = [
  { value: "bold", label: "Classico (grassetto)" },
  { value: "regular", label: "Leggero" },
  { value: "italic", label: "Elegante (corsivo)" },
  { value: "uppercase", label: "Maiuscolo" },
];

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "slow"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export function ManualEditor({
  open,
  slug,
  name,
  mode,
  onClose,
}: {
  open: boolean;
  slug: string;
  name: string;
  mode: "video" | "post";
  onClose: () => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [videos, setVideos] = useState<MediaItem[]>([]);

  // stato VIDEO
  const [selected, setSelected] = useState<ClipSelection[]>([]);
  const [font, setFont] = useState("bold");

  // stato POST
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [callout, setCallout] = useState("");

  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Reset locale quando si (ri)apre con destinazione diversa.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected([]);
    setPhotoKey(null);
    setCallout("");
    setStatus({ kind: "idle" });
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/curated-media?slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (cancelled) return;
        setPhotos(data.photos ?? []);
        setVideos(data.videos ?? []);
      } catch {
        if (!cancelled) {
          setPhotos([]);
          setVideos([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slug]);

  function addClip(item: MediaItem) {
    setSelected((s) => [
      ...s,
      { key: item.key, name: item.name, url: item.url, durationSec: 3, caption: "" },
    ]);
  }
  function removeClip(i: number) {
    setSelected((s) => s.filter((_, idx) => idx !== i));
  }
  function moveClip(i: number, dir: -1 | 1) {
    setSelected((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      const [el] = copy.splice(i, 1);
      copy.splice(j, 0, el);
      return copy;
    });
  }
  function setClip(i: number, patch: Partial<ClipSelection>) {
    setSelected((s) => s.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  const busy = status.kind === "busy";
  const slow = status.kind === "slow";

  async function runVideo() {
    setStatus({ kind: "busy" });
    const watchdog = setTimeout(() => {
      setStatus((s) =>
        s.kind === "busy"
          ? {
              kind: "slow",
              message:
                "Ancora in elaborazione… (i video possono richiedere 30–60s). Se non compare qui a breve, controlla la sezione Pianificazione: potrebbe essere già pronto.",
            }
          : s
      );
    }, 55000);
    try {
      const res = await createManualVideoAction({
        destination: name,
        clips: selected.map((c) => ({
          key: c.key,
          durationSec: c.durationSec,
          caption: c.caption.trim() || null,
        })),
        font,
      });
      setStatus(
        res.ok ? { kind: "ok", message: res.message } : { kind: "error", message: res.message }
      );
      if (res.ok) router.refresh();
    } catch {
      setStatus({
        kind: "error",
        message:
          "La risposta del server non è arrivata (la generazione potrebbe essere andata a buon fine comunque). Controlla la sezione Pianificazione.",
      });
    } finally {
      clearTimeout(watchdog);
    }
  }

  async function runPost() {
    setStatus({ kind: "busy" });
    const watchdog = setTimeout(() => {
      setStatus((s) =>
        s.kind === "busy"
          ? {
              kind: "slow",
              message:
                "Ancora in elaborazione… Se non compare qui a breve, controlla la sezione Pianificazione.",
            }
          : s
      );
    }, 40000);
    try {
      const res = await createManualPostAction({
        destination: name,
        photoKey,
        callout: callout.trim() || null,
      });
      setStatus(
        res.ok ? { kind: "ok", message: res.message } : { kind: "error", message: res.message }
      );
      if (res.ok) router.refresh();
    } catch {
      setStatus({
        kind: "error",
        message:
          "La risposta del server non è arrivata (la generazione potrebbe essere andata a buon fine comunque). Controlla la sezione Pianificazione.",
      });
    } finally {
      clearTimeout(watchdog);
    }
  }

  const totalSec = selected.reduce((a, c) => a + c.durationSec, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="xl"
      tall
      title={`${mode === "video" ? "Video" : "Post"} manuale — ${name}`}
      description={
        mode === "video"
          ? "Scegli le clip nell'ordine che vuoi, imposta durata e scritta per ognuna."
          : "Scegli la foto e scrivi il testo da stampare sopra il post."
      }
      footer={
        mode === "video" ? (
          <>
            <div className="mr-auto text-xs text-slate-500">
              {selected.length} clip · {totalSec}s
            </div>
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Annulla
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={runVideo}
              disabled={busy || slow || selected.length === 0}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              Genera video
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Annulla
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={runPost}
              disabled={busy || slow || !photoKey}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
              Genera post
            </Button>
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Caricamento media…
        </div>
      ) : mode === "video" ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <VideoPicker
            videos={videos}
            selected={selected}
            addClip={addClip}
          />
          <div className="flex flex-col gap-3">
            <Field label="Stile scritta">
              <Select value={font} onChange={(e) => setFont(e.target.value)}>
                {FONT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <p className="text-xs text-slate-500">
              Clip scelte nell'ordine del montaggio ({totalSec}s totali). Trascina con le
              frecce, imposta secondi e scritta per ciascuna.
            </p>

            {selected.length === 0 ? (
              <EmptyState
                title="Nessuna clip scelta"
                description="Aggiungi le clip dalla lista a sinistra nell'ordine desiderato."
              />
            ) : (
              <div className="flex flex-col gap-2">
                {selected.map((c, i) => (
                  <div
                    key={`${c.key}-${i}`}
                    className="rounded-lg border border-slate-200 p-2 dark:border-slate-800"
                  >
                    <div className="flex items-center gap-2">
                      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-slate-900">
                        <video
                          src={c.url}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover"
                        />
                        <span className="absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-sky-600 text-[10px] font-semibold text-white">
                          {i + 1}
                        </span>
                      </div>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                        {c.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => moveClip(i, -1)}
                        disabled={i === 0}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                        aria-label="Sposta su"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveClip(i, 1)}
                        disabled={i === selected.length - 1}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                        aria-label="Sposta giù"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeClip(i)}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Rimuovi"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <div className="w-24">
                        <Input
                          type="number"
                          min={1}
                          max={30}
                          value={c.durationSec}
                          onChange={(e) =>
                            setClip(i, {
                              durationSec: Math.min(30, Math.max(1, Number(e.target.value) || 1)),
                            })
                          }
                        />
                      </div>
                      <span className="self-center text-xs text-slate-400">sec</span>
                      <Input
                        className="flex-1"
                        placeholder="Scritta su questa clip (opzionale)"
                        value={c.caption}
                        onChange={(e) => setClip(i, { caption: e.target.value })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <PostPicker
          photos={photos}
          photoKey={photoKey}
          setPhotoKey={setPhotoKey}
          callout={callout}
          setCallout={setCallout}
        />
      )}

      {status.kind === "ok" && (
        <p className="mt-3 flex items-start gap-1 text-xs text-emerald-600">
          <Check className="mt-0.5 h-3.5 w-3.5" /> {status.message}
        </p>
      )}
      {status.kind === "slow" && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-600">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          {status.message}
        </p>
      )}
      {status.kind === "error" && (
        <p className="mt-3 flex items-start gap-1 text-xs text-red-600">{status.message}</p>
      )}
    </Modal>
  );
}

function VideoPicker({
  videos,
  selected,
  addClip,
}: {
  videos: MediaItem[];
  selected: ClipSelection[];
  addClip: (item: MediaItem) => void;
}) {
  if (videos.length === 0) {
    return (
      <EmptyState
        title="Nessuna clip"
        description="La cartella video di questa destinazione è vuota. Aggiungi i file e sincronizza."
      />
    );
  }
  const chosen = new Set(selected.map((c) => c.key));
  return (
    <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1">
      {videos.map((v) => {
        const added = chosen.has(v.key);
        return (
          <div
            key={v.key}
            className="flex items-center gap-3 rounded-lg border border-slate-200 p-2 dark:border-slate-800"
          >
            {/* Anteprima reale (frame 0) caricata dal browser direttamente dal bucket R2: nessun costo server. */}
            <video
              src={v.url}
              muted
              playsInline
              preload="metadata"
              className="h-16 w-28 shrink-0 rounded-md bg-slate-900 object-cover"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-slate-700 dark:text-slate-200">
              {v.name}
            </span>
            <Button
              size="sm"
              variant={added ? "secondary" : "primary"}
              disabled={added}
              onClick={() => addClip(v)}
            >
              {added ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {added ? "Aggiunta" : "Aggiungi"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function PostPicker({
  photos,
  photoKey,
  setPhotoKey,
  callout,
  setCallout,
}: {
  photos: MediaItem[];
  photoKey: string | null;
  setPhotoKey: (k: string | null) => void;
  callout: string;
  setCallout: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Scegli la foto">
        {photos.length === 0 ? (
          <EmptyState
            title="Nessuna foto"
            description="La cartella foto di questa destinazione è vuota."
          />
        ) : (
          <div className="grid max-h-[40vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {photos.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPhotoKey(p.key === photoKey ? null : p.key)}
                className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${
                  p.key === photoKey
                    ? "border-sky-500 ring-2 ring-sky-200"
                    : "border-transparent hover:border-slate-300"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                {p.key === photoKey && (
                  <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-white">
                    <Check className="h-3 w-3" />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </Field>

      <Field label="Testo sul post">
        <Textarea
          rows={3}
          placeholder="Es. hotel 4★, mezza pensione, dal … al …, da € …"
          value={callout}
          onChange={(e) => setCallout(e.target.value)}
        />
      </Field>
    </div>
  );
}
