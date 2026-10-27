"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Link2, Link2Off, Trash2, UploadCloud } from "lucide-react";
import { linkAssetAction, unlinkAssetAction } from "@/lib/actions/media";
import { cn } from "@/lib/utils";
import {
  Button,
  Modal,
  Select,
  StatusBadge,
  MediaThumb,
  Badge,
} from "@/components/ui";

export type MediaCardAsset = {
  id: string;
  url: string;
  filename: string;
  kind: string;
  size: number | null;
  mimeType: string | null;
  createdAt: string;
  contentId: string | null;
  content: { id: string; title: string | null; status: string } | null;
};

export type MediaCardContentOption = {
  id: string;
  title: string | null;
  status: string;
};

function formatBytes(size: number | null): string | null {
  if (!size || size <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function AssetCard({
  asset,
  contentOptions,
}: {
  asset: MediaCardAsset;
  contentOptions: MediaCardContentOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [target, setTarget] = useState("");
  // Il loading è pilotato dalla transition: si spegne sempre quando la
  // transition termina, anche se la action non resolve (niente spinner infinito).
  const [busy, startWork] = useTransition();

  const doLink = () => {
    if (!target || busy) return;
    setError(null);
    startWork(async () => {
      try {
        const res = await linkAssetAction({ assetId: asset.id, contentId: target });
        if (!res.ok) {
          setError(res.message ?? "Associazione non riuscita.");
          return;
        }
        setLinkOpen(false);
        setTarget("");
        // revalidatePath della action aggiorna /media e /contents.
      } catch {
        setError("Associazione non riuscita. Riprova.");
      }
    });
  };

  /** Non distruttiva: stacca solo l'associazione, l'asset resta in libreria. */
  const doUnlink = () => {
    const linkedContentId = asset.content?.id;
    if (!linkedContentId) return;
    if (
      !window.confirm(
        "Rimuovere l'associazione con il contenuto?\n\nIl file resta in Media Library e potrà essere associato a un altro contenuto."
      )
    ) {
      return;
    }
    setError(null);
    startWork(async () => {
      try {
        const res = await unlinkAssetAction({
          contentId: linkedContentId,
          assetId: asset.id,
        });
        if (!res.ok) setError(res.message ?? "Rimozione non riuscita.");
        // revalidatePath della action aggiorna /media e /contents.
      } catch {
        setError("Rimozione non riuscita. Riprova.");
      }
    });
  };

  /** Azione DISTRUTTIVA: unica che elimina asset e file fisico. */
  const doDelete = () => {
    if (
      !window.confirm(
        "Eliminare DEFINITIVAMENTE questo file dalla Media Library?\n\nVerrà rimosso anche il file su disco. Questa azione non è reversibile."
      )
    ) {
      return;
    }
    setError(null);
    startWork(async () => {
      try {
        const res = await fetch(`/api/upload?id=${asset.id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.message ?? "Eliminazione non riuscita.");
          return;
        }
        router.refresh();
      } catch {
        setError("Errore durante l'eliminazione.");
      }
    });
  };

  const size = formatBytes(asset.size);

  return (
    <>
      <div className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:border-sky-300 hover:shadow-md">
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          className="relative aspect-square w-full overflow-hidden bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300"
          aria-label={`Dettagli di ${asset.filename}`}
        >
          <MediaThumb asset={asset} className="h-full w-full" />
        </button>

        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200" title={asset.filename}>
            {asset.filename}
          </p>

          <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
            <Badge className="border-slate-200 bg-slate-100 text-slate-600">
              {asset.kind}
            </Badge>
            {size ? <span>{size}</span> : null}
            <span>{formatDate(asset.createdAt)}</span>
          </div>

          <div className="mt-auto border-t border-slate-100 pt-2">
            {asset.content ? (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  Usato in
                </p>
                <Link
                  href={`/contents/${asset.content.id}`}
                  className="block truncate text-xs font-medium text-sky-700 hover:underline"
                >
                  {asset.content.title ?? "Senza titolo"}
                </Link>
                <div className="flex items-center justify-between gap-2">
                  <StatusBadge status={asset.content.status} />
                  <button
                    type="button"
                    onClick={doUnlink}
                    disabled={busy}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-amber-600 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Link2Off className="h-3 w-3" />
                    )}
                    Rimuovi associazione
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">
                  Non associato
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  onClick={() => setLinkOpen(true)}
                  disabled={busy}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Associa a contenuto
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2">
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="text-[11px] font-medium text-slate-500 transition-colors hover:text-sky-700"
          >
            Dettagli
          </button>
          <button
            type="button"
            onClick={doDelete}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-red-600 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            Elimina
          </button>
        </div>
      </div>

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        busy={busy}
        title="Associa a un contenuto"
        description="Il file resta in Media Library e comparirà subito nel contenuto scelto."
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkOpen(false)} disabled={busy}>
              Annulla
            </Button>
            <Button onClick={doLink} disabled={busy || !target} aria-busy={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {busy ? "Associazione in corso…" : "Associa"}
            </Button>
          </>
        }
      >
        <Select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy}
        >
          <option value="">Seleziona un contenuto…</option>
          {contentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? "Senza titolo"} ({c.status})
            </option>
          ))}
        </Select>
      </Modal>

      <Modal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        size="lg"
        title={asset.filename}
        description="Dettagli del file e relazione con i contenuti."
        footer={
          <Button variant="secondary" onClick={() => setDetailOpen(false)}>
            Chiudi
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {asset.kind === "IMAGE" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={asset.url} alt={asset.filename} className="max-h-80 w-full object-contain" />
            ) : (
              <MediaThumb asset={asset} className="aspect-video w-full" />
            )}
          </div>

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-slate-400">Tipo</dt>
              <dd className="font-medium text-slate-700 dark:text-slate-300">{asset.kind}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Dimensione</dt>
              <dd className="font-medium text-slate-700 dark:text-slate-300">{size ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">MIME</dt>
              <dd className="font-medium text-slate-700 dark:text-slate-300">{asset.mimeType ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Caricato il</dt>
              <dd className="font-medium text-slate-700 dark:text-slate-300">{formatDate(asset.createdAt)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-slate-400">URL</dt>
              <dd className="break-all font-mono text-[11px] text-slate-600">{asset.url}</dd>
            </div>
          </dl>

          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-slate-400">
              Contenuto associato
            </p>
            {asset.content ? (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <Link
                  href={`/contents/${asset.content.id}`}
                  onClick={() => setDetailOpen(false)}
                  className="text-sm font-medium text-sky-700 hover:underline"
                >
                  {asset.content.title ?? "Senza titolo"}
                </Link>
                <StatusBadge status={asset.content.status} />
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-500">
                Non associato a nessun contenuto.
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* Ultimo nodo del fragment: a parità di z-index è l'elemento più in
          alto, così il messaggio d'errore resta visibile anche quando fallisce
          un'operazione avviata da un'altra modale (es. "Associa"). */}
      {error ? (
        <Modal
          open
          onClose={() => setError(null)}
          title="Operazione non riuscita"
          footer={
            <Button variant="secondary" onClick={() => setError(null)}>
              Chiudi
            </Button>
          }
        >
          <p className="text-sm text-red-700">{error}</p>
        </Modal>
      ) : null}
    </>
  );
}

export function UploadButton() {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);

  const doUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("file", f));
    setUploading(true);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert(body?.message ?? "Upload fallito");
        return;
      }
      router.refresh();
    } catch {
      alert("Errore durante l'upload.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-dashed px-4 py-2 text-sm font-medium transition-colors",
        uploading
          ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
          : "cursor-pointer border-slate-300 bg-white text-slate-600 hover:border-sky-400 hover:text-sky-700"
      )}
    >
      {uploading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <UploadCloud className="h-4 w-4" />
      )}
      {uploading ? "Caricamento…" : "Carica file"}
      <input
        type="file"
        multiple
        accept="image/*,video/*"
        className="sr-only"
        disabled={uploading}
        onChange={(e) => {
          const files = e.target.files;
          // Azzeriamo il valore: senza questo, riselezionare lo stesso file
          // non emette alcun evento change e il secondo upload non parte mai.
          e.target.value = "";
          void doUpload(files);
        }}
      />
    </label>
  );
}
