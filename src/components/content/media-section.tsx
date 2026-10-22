"use client";
function LightboxModal({ src, onClose }: { src: string; onClose: () => void }) {
  const isVideo = /\.(mp4|webm|mov)(\?.*)?$/i.test(src) || src.includes("video");
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative max-w-4xl max-h-[90vh] w-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute -top-10 right-0 text-white font-bold text-xl hover:text-gray-300">✕ Chiudi</button>
        {isVideo ? (
          <video src={src} controls autoPlay className="max-w-full max-h-[85vh] rounded-lg shadow-2xl" />
        ) : (
          <img src={src} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl" />
        )}
      </div>
    </div>
  );
}



import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ImagePlus,
  Link2Off,
  Loader2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { unlinkAssetAction } from "@/lib/actions/media";
import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  CardHeader,
  MediaPlaceholder,
  MediaThumb,
} from "@/components/ui";
import { AssetPicker } from "@/components/content/asset-picker";

type ContentAsset = {
  id: string;
  url: string;
  filename: string;
  kind: string;
};

type LibraryAsset = {
  id: string;
  url: string;
  filename: string;
  kind: string;
  contentId: string | null;
  content: { id: string; title: string | null; status: string } | null;
};

export function ContentMediaSection({
  contentId,
  assets,
  library,
  targetsInstagram,
}: {
  contentId: string;
  assets: ContentAsset[];
  library: LibraryAsset[];
  targetsInstagram: boolean;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Loading pilotato dalla transition: si spegne sempre alla fine, la promise
  // della action non è mai l'unico segnale (niente spinner infinito).
  const [working, startWork] = useTransition();

  const unlink = (assetId: string) => {
    if (
      !window.confirm(
        "Rimuovere questo file dal contenuto?\n\nIl file resterà nella Media Library e potrà essere associato a un altro contenuto."
      )
    ) {
      return;
    }
    setBusyId(assetId);
    setError(null);
    startWork(async () => {
      try {
        const res = await unlinkAssetAction({ contentId, assetId });
        if (!res.ok) setError(res.message ?? "Rimozione non riuscita.");
        // revalidatePath della action aggiorna media-section e contenuto.
      } catch {
        setError("Rimozione non riuscita. Riprova.");
      } finally {
        setBusyId(null);
      }
    });
  };

  /** Azione DISTRUTTIVA: unica che elimina davvero asset e file fisico. */
  const removeAsset = (assetId: string) => {
    if (
      !window.confirm(
        "Eliminare DEFINITIVAMENTE questo file?\n\nVerrà rimosso dal contenuto e cancellato dalla Media Library, insieme al file su disco. Questa azione non è reversibile."
      )
    ) {
      return;
    }
    setBusyId(assetId);
    startWork(async () => {
      try {
        const res = await fetch(`/api/upload?id=${assetId}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.message ?? "Eliminazione non riuscita.");
          return;
        }
        router.refresh();
      } catch {
        setError("Errore durante l'eliminazione del file.");
      } finally {
        setBusyId(null);
      }
    });
  };

  const upload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const form = new FormData();
    form.append("contentId", contentId);
    Array.from(files).forEach((f) => form.append("file", f));
    setUploading(true);
    setError(null);
    startWork(async () => {
      try {
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.message ?? "Upload fallito");
          return;
        }
        router.refresh();
      } catch {
        setError("Errore durante l'upload.");
      } finally {
        setUploading(false);
      }
    });
  };

  const needsMedia = targetsInstagram && assets.length === 0;

  return (
    <Card>
      <CardHeader
        title="Media del contenuto"
        description="Immagini e video usati per la pubblicazione su questo contenuto"
        action={
          <Button size="sm" onClick={() => setPickerOpen(true)} disabled={working}>
            <ImagePlus className="h-4 w-4" />
            Aggiungi media
          </Button>
        }
      />

      <div className="space-y-4 px-5 py-5">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </p>
        ) : null}

        {needsMedia ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-900">
                Instagram richiede un&apos;immagine o un video
              </p>
              <p className="mt-0.5 text-xs text-amber-700">
                Aggiungi almeno un media a questo contenuto prima di
                pubblicare su Instagram.
              </p>
            </div>
            <Button
              size="sm"
              variant="warning"
              onClick={() => setPickerOpen(true)}
              disabled={working}
            >
              <ImagePlus className="h-4 w-4" />
              Aggiungi media
            </Button>
          </div>
        ) : null}

        {assets.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {assets.map((a) => (
              <div
                key={a.id}
                className="group overflow-hidden rounded-lg border border-slate-200"
              >
                <div className="relative aspect-square w-full overflow-hidden bg-slate-100 cursor-pointer hover:opacity-90 transition-opacity" onClick={() => setSelectedUrl(a.url)}>
                  <MediaThumb asset={a} className="h-full w-full" />
                </div>
                <div className="space-y-2 bg-slate-50 p-2">
                  <p className="truncate text-[11px] text-slate-500" title={a.filename}>
                    {a.filename}
                  </p>
                  {/* Due azioni deliberatamente distinte: una non distruttiva
                      (stacca solo l'associazione) e una distruttiva. */}
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => unlink(a.id)}
                      disabled={busyId === a.id || working}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-amber-300 hover:text-amber-700 disabled:pointer-events-none disabled:opacity-50"
                    >
                      {busyId === a.id && working ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Link2Off className="h-3 w-3" />
                      )}
                      Rimuovi dal contenuto
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAsset(a.id)}
                      disabled={busyId === a.id || working}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Elimina file
                    </button>
                  </div>
                  <p className="text-[10px] leading-tight text-slate-400">
                    &quot;Rimuovi dal contenuto&quot; mantiene il file in Media
                    Library. &quot;Elimina file&quot; lo cancella per sempre.
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <MediaPlaceholder
            className="aspect-[3/1] w-full rounded-lg border border-dashed"
            label="Nessun media associato a questo contenuto"
          />
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <label
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs font-medium transition-colors",
              uploading || working
                ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
                : "cursor-pointer border-slate-300 text-slate-600 hover:border-sky-400 hover:text-sky-700"
            )}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {uploading ? "Caricamento…" : "Carica nuovo file"}
            <input
              type="file"
              multiple
              accept="image/*,video/*"
              className="sr-only"
              disabled={uploading || working}
              onChange={(e) => {
                const files = e.target.files;
                // Azzeriamo il valore: senza questo, riselezionare lo stesso
                // file non emette change e il secondo upload non parte mai.
                e.target.value = "";
                upload(files);
              }}
            />
          </label>
          <p className="text-[11px] text-slate-400">
            I file caricati qui vengono associati automaticamente a questo
            contenuto.
          </p>
        </div>
      </div>

      {selectedUrl && <LightboxModal src={selectedUrl} onClose={() => setSelectedUrl(null)} />}
      <AssetPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        contentId={contentId}
        assets={library}
        excludeIds={assets.map((a) => a.id)}
      />
    </Card>
  );
}
