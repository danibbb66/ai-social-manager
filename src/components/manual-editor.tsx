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
  startSec: number;
  endSec: number;
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
  const [videoTitle, setVideoTitle] = useState("");
  const [font, setFont] = useState("bold");
  const [captionColor, setCaptionColor] = useState("#ffffff");
  const [titleColor, setTitleColor] = useState("#ffffff");
  const [titleFont, setTitleFont] = useState("bold");
  const [audioKey, setAudioKey] = useState<string>("");
  const [audios, setAudios] = useState<MediaItem[]>([]);
  const [preview, setPreview] = useState<MediaItem | null>(null);

  // stato POST
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [postTitle, setPostTitle] = useState("");
  const [callout, setCallout] = useState("");
  const [postTitleColor, setPostTitleColor] = useState("#ffffff");
  const [postTitleFont, setPostTitleFont] = useState("bold");
  const [postCalloutColor, setPostCalloutColor] = useState("#ffffff");
  const [postCalloutFont, setPostCalloutFont] = useState("bold");

  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Reset locale quando si (ri)apre con destinazione diversa.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelected([]);
    setVideoTitle("");
    setTitleColor("#ffffff");
    setTitleFont("bold");
    setCaptionColor("#ffffff");
    setFont("bold");
    setAudioKey("");
    setPhotoKey(null);
    setPostTitle("");
    setCallout("");
    setPostTitleColor("#ffffff");
    setPostTitleFont("bold");
    setPostCalloutColor("#ffffff");
    setPostCalloutFont("bold");
    setStatus({ kind: "idle" });
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/curated-media?slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (cancelled) return;
        setPhotos(data.photos ?? []);
        setVideos(data.videos ?? []);
        try {
          const ares = await fetch("/api/audio-tracks");
          const adata = await ares.json();
          if (!cancelled) setAudios(adata.audios ?? []);
        } catch {
          if (!cancelled) setAudios([]);
        }
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
      { key: item.key, name: item.name, url: item.url, startSec: 0, endSec: 3, caption: "" },
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
        title: videoTitle.trim() || null,
        clips: selected.map((c) => ({
          key: c.key,
          startSec: c.startSec,
          endSec: c.endSec,
          caption: c.caption.trim() || null,
        })),
        font,
        captionColor,
        titleColor,
        titleFont,
        audioKey: audioKey || null,
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
        title: postTitle.trim() || null,
        photoKey,
        callout: callout.trim() || null,
        titleColor: postTitleColor,
        titleFont: postTitleFont,
        calloutColor: postCalloutColor,
        calloutFont: postCalloutFont,
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

  const totalSec = selected.reduce((a, c) => a + Math.max(0, c.endSec - c.startSec), 0);

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
          ? "Scegli le clip nell'ordine che vuoi, imposta inizio, fine e scritta per ognuna."
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
            onPreview={(v) => setPreview(v)}
          />
          <div className="flex flex-col gap-3">
            {/* Sezione TITOLO */}
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Titolo
              </p>
              <Field label="Testo del titolo">
                <Input
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                  placeholder="Lascia vuoto per non mostrare nessun titolo"
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Colore titolo">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={titleColor}
                      onChange={(e) => setTitleColor(e.target.value)}
                      className="h-8 w-12 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
                    />
                    <span className="text-xs text-slate-500">{titleColor}</span>
                  </div>
                </Field>
                <Field label="Stile titolo">
                  <Select value={titleFont} onChange={(e) => setTitleFont(e.target.value)}>
                    {FONT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>

            {/* Sezione TESTO (scritte per clip) */}
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Testo sulle clip
              </p>
              <p className="mb-2 text-xs text-slate-400">
                Scrivi il testo di ogni clip nella lista qui sotto; stile e colore valgono per tutte.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Stile testo">
                  <Select value={font} onChange={(e) => setFont(e.target.value)}>
                    {FONT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Colore testo">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={captionColor}
                      onChange={(e) => setCaptionColor(e.target.value)}
                      className="h-8 w-12 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
                    />
                    <span className="text-xs text-slate-500">{captionColor}</span>
                  </div>
                </Field>
              </div>
            </div>

            {audios.length > 0 && (
              <Field label="Audio di sottofondo">
                <Select value={audioKey} onChange={(e) => setAudioKey(e.target.value)}>
                  <option value="">Automatico (a rotazione)</option>
                  <option value="none">Nessuno</option>
                  {audios.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <p className="text-xs text-slate-500">
              Clip scelte nell'ordine del montaggio ({totalSec}s totali). Nota: se una clip
              è più corta dei secondi impostati, il video si accorcia (si usa la sua durata reale).
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
                      <button
                        type="button"
                        onClick={() => setPreview({ key: c.key, url: c.url, name: c.name })}
                        className="relative h-14 w-24 shrink-0 cursor-pointer overflow-hidden rounded-md bg-slate-900"
                        title="Anteprima"
                      >
                        <video
                          src={c.url}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover"
                        />
                        <span className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-sky-600 text-xs font-semibold text-white">
                          {i + 1}
                        </span>
                      </button>
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
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-slate-400">da</span>
                      <Input
                        type="number"
                        min={0}
                        className="w-16"
                        value={c.startSec}
                        onChange={(e) => {
                          const ns = Math.max(0, Math.round(Number(e.target.value) || 0));
                          setClip(i, { startSec: ns, endSec: Math.max(c.endSec, ns + 1) });
                        }}
                      />
                      <span className="text-xs text-slate-400">a</span>
                      <Input
                        type="number"
                        min={c.startSec + 1}
                        className="w-16"
                        value={c.endSec}
                        onChange={(e) => {
                          const ne = Math.round(Number(e.target.value) || 0);
                          setClip(i, { endSec: Math.max(c.startSec + 1, ne) });
                        }}
                      />
                      <span className="text-xs text-slate-400">s</span>
                      <Input
                        className="min-w-[120px] flex-1"
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
          postTitle={postTitle}
          setPostTitle={setPostTitle}
          callout={callout}
          setCallout={setCallout}
          postTitleColor={postTitleColor}
          setPostTitleColor={setPostTitleColor}
          postTitleFont={postTitleFont}
          setPostTitleFont={setPostTitleFont}
          postCalloutColor={postCalloutColor}
          setPostCalloutColor={setPostCalloutColor}
          postCalloutFont={postCalloutFont}
          setPostCalloutFont={setPostCalloutFont}
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

      {preview && (
        <div
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/85 p-4"
          onClick={() => setPreview(null)}
        >
          <video
            src={preview.url}
            controls
            autoPlay
            muted
            playsInline
            className="max-h-[78vh] w-auto max-w-full rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="mt-3 max-w-full truncate text-sm text-white">{preview.name}</p>
          <button
            type="button"
            className="mt-3 rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
            onClick={() => setPreview(null)}
          >
            Chiudi
          </button>
        </div>
      )}
    </Modal>
  );
}

function VideoPicker({
  videos,
  selected,
  addClip,
  onPreview,
}: {
  videos: MediaItem[];
  selected: ClipSelection[];
  addClip: (item: MediaItem) => void;
  onPreview: (item: MediaItem) => void;
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
            <button
              type="button"
              onClick={() => onPreview(v)}
              className="h-16 w-28 shrink-0 overflow-hidden rounded-md bg-slate-900"
              title="Anteprima"
            >
              <video
                src={v.url}
                muted
                playsInline
                preload="metadata"
                className="h-full w-full object-cover"
              />
            </button>
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
  postTitle,
  setPostTitle,
  callout,
  setCallout,
  postTitleColor,
  setPostTitleColor,
  postTitleFont,
  setPostTitleFont,
  postCalloutColor,
  setPostCalloutColor,
  postCalloutFont,
  setPostCalloutFont,
}: {
  photos: MediaItem[];
  photoKey: string | null;
  setPhotoKey: (k: string | null) => void;
  postTitle: string;
  setPostTitle: (v: string) => void;
  callout: string;
  setCallout: (v: string) => void;
  postTitleColor: string;
  setPostTitleColor: (v: string) => void;
  postTitleFont: string;
  setPostTitleFont: (v: string) => void;
  postCalloutColor: string;
  setPostCalloutColor: (v: string) => void;
  postCalloutFont: string;
  setPostCalloutFont: (v: string) => void;
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

      {/* Sezione TITOLO */}
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Titolo
        </p>
        <Field label="Testo del titolo">
          <Input
            value={postTitle}
            onChange={(e) => setPostTitle(e.target.value)}
            placeholder="Lascia vuoto per non mostrare nessun titolo"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Colore titolo">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={postTitleColor}
                onChange={(e) => setPostTitleColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
              />
              <span className="text-xs text-slate-500">{postTitleColor}</span>
            </div>
          </Field>
          <Field label="Stile titolo">
            <Select value={postTitleFont} onChange={(e) => setPostTitleFont(e.target.value)}>
              {FONT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {/* Sezione TESTO */}
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Testo
        </p>
        <Field label="Testo sul post">
          <Textarea
            rows={3}
            placeholder="Es. hotel 4★, mezza pensione, dal … al …, da € …"
            value={callout}
            onChange={(e) => setCallout(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Stile testo">
            <Select value={postCalloutFont} onChange={(e) => setPostCalloutFont(e.target.value)}>
              {FONT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Colore testo">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={postCalloutColor}
                onChange={(e) => setPostCalloutColor(e.target.value)}
                className="h-8 w-12 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
              />
              <span className="text-xs text-slate-500">{postCalloutColor}</span>
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}
