"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { importOfferteAction } from "@/lib/actions/catalog";

type Report = {
  cards: number;
  created: number;
  updated: number;
  unchanged: number;
  imagesCreated: number;
  missing: number;
  anomalies: number;
};

/**
 * Rilettura del catalogo dal sito pubblico.
 *
 * Mostra il riepilogo dell'ultima esecuzione: quante card sono state lette,
 * quante sono nuove, quante erano già presenti e quante non compaiono più.
 */
export function ImportCatalogButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await importOfferteAction();
            if (res.ok) {
              setReport(res.report);
              router.refresh();
            } else {
              setReport(null);
              setError(res.message ?? "Import non riuscito.");
            }
          })
        }
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {pending ? "Import…" : "Importa dal sito"}
      </Button>

      {report ? (
        <p className="text-right text-xs text-slate-500">
          {report.cards} card lette · {report.created} nuove ·{" "}
          {report.updated} aggiornate · {report.unchanged} invariate ·{" "}
          {report.missing} non più sul sito
        </p>
      ) : null}

      {error ? (
        <p className="max-w-xs text-right text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
