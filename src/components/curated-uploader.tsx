"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  UploadCloud,
  CheckCircle2,
  XCircle,
  FolderPlus,
} from "lucide-react";
import { Button, Card, CardHeader } from "@/components/ui";

export type CuratedDestinationOption = {
  slug: string;
  name: string;
  photoCount: number;
  videoCount: number;
};

type Kind = "photos" | "videos" | "audio";

const KIND_META: Record<
  Kind,
  { label: string; accept: string; hint: string }
> = {
  photos: {
    label: "Foto",
    accept: ".jpg,.jpeg,.png,.webp,.avif,.gif",
    hint: "JPG, PNG, WEBP, AVIF, GIF",
  },
  videos: {
    label: "Video",
    accept: ".mp4,.mov,.webm,.m4v,.mkv,.avi",
    hint: "MP4, MOV, WEBM, M4V, MKV, AVI",
  },
  audio: {
    label: "Audio",
    accept: ".m4a,.mp3,.wav,.aac,.ogg",
    hint: "M4A, MP3, WAV, AAC, OGG",
  },
};

const NEW_DEST = "_new_";

type Result = {
  name: string;
  ok: boolean;
  message?: string;
};

/** Slug elementare lato client: solo anteprima, il server convalida davvero. */
function previewSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function CuratedUploader({
  destinations,
}: {
  destinations: CuratedDestinationOption[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<Kind>("videos");
  const [destSlug, setDestSlug] = useState<string>(
    destinations[0]?.slug ?? NEW_DEST
  );
  const [newName, setNewName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);

  const isNew = destSlug === NEW_DEST;
  const needsSlug = kind !== "audio";
  const newSlug = previewSlug(newName);

  function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    setFiles(Array.from(list));
    setResults([]);
  }

  async function uploadOne(file: File): Promise<Result> {
    const slug = !needsSlug ? "" : isNew ? newName : destSlug;

    // 1) Firma: il server decide la chiave e la modalità (direct R2 / proxy locale).
    let sign: {
      ok?: boolean;
      mode?: "direct" | "proxy";
      uploadUrl?: string;
      publicUrl?: string;
      key?: string;
      contentType?: string;
      message?: string;
    };
    try {
      const res = await fetch("/api/curated/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          slug,
          name: file.name,
          type: file.type,
          size: file.size,
        }),
      });
      sign = await res.json();
      if (!res.ok || !sign.ok) {
        return {
          name: file.name,
          ok: false,
          message: sign.message ?? "Preparazione fallita.",
        };
      }
    } catch {
      return { name: file.name, ok: false, message: "Errore di rete." };
    }

    // 2a) Locale: multipart classico verso il server.
    if (sign.mode !== "direct") {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      form.append("slug", slug);
      form.append("key", sign.key ?? "");
      try {
        const res = await fetch("/api/curated/upload", { method: "POST", body: form });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          return {
            name: file.name,
            ok: false,
            message: body?.message ?? "Caricamento fallito.",
          };
        }
        return { name: file.name, ok: true };
      } catch {
        return { name: file.name, ok: false, message: "Errore di rete." };
      }
    }

    // 2b) Cloud: PUT diretto del file su R2.
    try {
      const res = await fetch(sign.uploadUrl!, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": sign.contentType || file.type || "application/octet-stream",
        },
      });
      if (!res.ok) {
        return {
          name: file.name,
          ok: false,
          message: `Caricamento su cloud fallito (HTTP ${res.status}).`,
        };
      }
      return { name: file.name, ok: true };
    } catch {
      return { name: file.name, ok: false, message: "Errore di rete sul cloud." };
    }
  }

  async function doUpload() {
    if (files.length === 0 || busy) return;
    if (needsSlug && isNew && !newSlug) {
      setResults([
        {
          name: "Destinazione",
          ok: false,
          message: "Scrivi un nome per la nuova destinazione.",
        },
      ]);
      return;
    }
    setBusy(true);
    setResults([]);
    const out: Result[] = [];
    for (const file of files) {
      out.push(await uploadOne(file));
      setResults([...out]);
    }
    setBusy(false);
    setFiles([]);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  const canSubmit =
    !busy && files.length > 0 && (kind === "audio" || !isNew || newSlug.length > 0);

  return (
    <Card>
      <CardHeader
        title="Carica media curati"
        description="Aggiungi foto, clip video o audio alle cartelle usate per generare i contenuti. I file compaiono subito in Crea video & post."
      />

      <div className="space-y-4 p-5">
        {/* Categoria */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Tipo
          </label>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KIND_META) as Kind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setFiles([]);
                  setResults([]);
                }}
                className={[
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  kind === k
                    ? "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700",
                ].join(" ")}
              >
                {KIND_META[k].label}
              </button>
            ))}
          </div>
        </div>

        {/* Destinazione */}
        {needsSlug ? (
          <div className="space-y-2 sm:flex sm:items-end sm:gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Destinazione
              </label>
              <select
                value={destSlug}
                onChange={(e) => setDestSlug(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {destinations.map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.name} ({d.photoCount} foto, {d.videoCount} clip)
                  </option>
                ))}
                <option value={NEW_DEST}>➕ Nuova destinazione…</option>
              </select>
            </div>

            {isNew ? (
              <div className="flex-1">
                <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Nome (verrà trasformato in una cartella)
                </label>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  disabled={busy}
                  placeholder="es. Maldive"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
                />
                {newName.trim() ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Cartella: <code className="font-mono">{newSlug}</code>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <FolderPlus className="h-4 w-4" />
            L&apos;audio va nella cartella condivisa <code className="font-mono">audio/</code>, usata
            a rotazione per il sottofondo dei reel.
          </p>
        )}

        {/* Selezione file */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">
            File ({KIND_META[kind].hint})
          </label>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={KIND_META[kind].accept}
            disabled={busy}
            onChange={(e) => onPick(e.target.files)}
            className="block w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-sm text-slate-600 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-sky-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-sky-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          />
        </div>

        {/* Riepilogo selezione */}
        {files.length > 0 ? (
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="truncate">
                {f.name}{" "}
                <span className="text-slate-400">({Math.max(1, Math.round(f.size / 1024))} KB)</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-3">
          <Button onClick={doUpload} disabled={!canSubmit}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Caricamento…
              </>
            ) : (
              <>
                <UploadCloud className="h-4 w-4" />
                Carica {files.length > 0 ? `${files.length} file` : ""}
              </>
            )}
          </Button>
          {files.length > 0 && !busy ? (
            <button
              type="button"
              onClick={() => {
                setFiles([]);
                setResults([]);
                if (inputRef.current) inputRef.current.value = "";
              }}
              className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400"
            >
              Annulla
            </button>
          ) : null}
        </div>

        {/* Esiti */}
        {results.length > 0 ? (
          <ul className="space-y-1.5">
            {results.map((r, i) => (
              <li
                key={`${r.name}-${i}`}
                className={[
                  "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
                  r.ok
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                    : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
                ].join(" ")}
              >
                {r.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 break-words">
                  <span className="font-medium">{r.name}</span>
                  {r.message ? <> — {r.message}</> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
