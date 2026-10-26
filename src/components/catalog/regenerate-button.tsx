"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Wand2 } from "lucide-react";
import { regenerateLocandinaAction } from "@/lib/actions/catalog";

/**
 * Rigenera la locandina della proposta come creatività dell'agenzia
 * (foto curata + logo + sito), leggendo i dati commerciali via OCR.
 */
export function RegenerateLocandinaButton({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            setOk(null);
            const res = await regenerateLocandinaAction(proposalId);
            if (res.ok) {
              setOk("Locandina rigenerata: vedi Contenuti.");
              router.refresh();
            } else {
              setError(res.message ?? "Rigenerazione non riuscita.");
            }
          })
        }
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-sky-500 disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Wand2 className="h-3.5 w-3.5" />
        )}
        {pending ? "Rigenero…" : "Rigenera locandina"}
      </button>
      {ok ? <p className="text-xs text-emerald-600">{ok}</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
