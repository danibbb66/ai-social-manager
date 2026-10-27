"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Loader2, Link2, Search } from "lucide-react";
import { linkAssetAction } from "@/lib/actions/media";
import { Button, Input, Modal, MediaThumb, StatusBadge } from "@/components/ui";

type PickableAsset = {
  id: string;
  url: string;
  filename: string;
  kind: string;
  contentId: string | null;
  content: { id: string; title: string | null; status: string } | null;
};

export function AssetPicker({
  open,
  onClose,
  contentId,
  assets,
  excludeIds,
}: {
  open: boolean;
  onClose: () => void;
  contentId: string;
  assets: PickableAsset[];
  excludeIds: string[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Il loading è pilotato dalla transition: si spegne sempre quando la
  // transition termina, anche se la action non resolve (non resta mai appesa).
  const [saving, startSave] = useTransition();

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return assets
      .filter((a) => !excluded.has(a.id))
      .filter((a) => !term || a.filename.toLowerCase().includes(term));
  }, [assets, excluded, q]);

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const confirm = () => {
    if (selected.length === 0 || saving) return;
    setError(null);
    startSave(async () => {
      try {
        for (const assetId of selected) {
          const res = await linkAssetAction({ assetId, contentId });
          if (!res.ok) {
            setError(res.message ?? "Associazione non riuscita.");
            return;
          }
        }
        setSelected([]);
        // La action esegue già revalidatePath su /media, /contents e
        // /contents/{id}: non serve un refresh aggiuntivo in competizione.
        onClose();
      } catch {
        setError("Associazione non riuscita. Riprova.");
      }
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={saving}
      size="lg"
      title="Aggiungi media dalla libreria"
      description="Seleziona uno o più file già presenti nella Media Library. Non vengono copiati: viene salvata solo l'associazione al contenuto."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Annulla
          </Button>
          <Button
            onClick={confirm}
            disabled={saving || selected.length === 0}
            aria-busy={saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
            {saving
              ? "Associazione in corso…"
              : selected.length > 0
                ? `Associa ${selected.length} file`
                : "Seleziona un file"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cerca per nome file…"
            className="pl-9"
          />
        </div>

        {error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            Nessun file disponibile. Carica un file dalla Media Library per
            associarlo.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {visible.map((a) => {
              const isSelected = selected.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggle(a.id)}
                  className={`group overflow-hidden rounded-lg border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                    isSelected
                      ? "border-sky-400 ring-2 ring-sky-200"
                      : "border-slate-200 hover:border-sky-300"
                  }`}
                >
                  <div className="relative aspect-square w-full overflow-hidden bg-slate-100">
                    <MediaThumb asset={a} className="h-full w-full" />
                    {isSelected ? (
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-sky-600 p-1 text-white">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1 bg-white p-2">
                    <p className="truncate text-[11px] font-medium text-slate-700 dark:text-slate-300">
                      {a.filename}
                    </p>
                    {a.content ? (
                      <div className="space-y-1">
                        <p className="truncate text-[10px] text-slate-500">
                          Già in: {a.content.title ?? "Senza titolo"}
                        </p>
                        <StatusBadge status={a.content.status} />
                      </div>
                    ) : (
                      <p className="text-[10px] text-slate-400">Non associato</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
