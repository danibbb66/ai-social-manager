import Link from "next/link";
import { History } from "lucide-react";
import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * Barra dei filtri di /contents: la sola barra di navigazione in alto.
 *
 * I conteggi arrivano GLOBALI da `countsByStatus()` (groupBy lato server):
 * non sono mai calcolati sul dataset già filtrato, quindi "Da approvare 7"
 * significa davvero 7 bozze totali, qualunque filtro sia attivo.
 *
 * Le voci sono derivate da STATUS_ORDER, che esclude REVIEW di proposito:
 * lo stato legacy non può comparire nei filtri. I conteggi di REVIEW, se
 * esistono dati storici, non vengono aggregati da nessuna parte.
 *
 * `active` è la chiave attualmente selezionata ("ALL", uno stato, o
 * "HISTORY"): senza di essa un filtro per stato e "Tutti" risulterebbero
 * entrambi attivi.
 */
const FILTER_LABELS: Record<string, string> = {
  DRAFT: "Da approvare",
  APPROVED: "Approvati",
  SCHEDULED: "Programmati",
  PUBLISHED: "Pubblicati",
  REJECTED: "Rifiutati",
  FAILED: "Falliti",
};

export type ContentsMode = "ALL" | "APPROVALS" | "HISTORY";

export function StatusFilterBar({
  counts,
  mode,
  active,
  linkFor,
}: {
  counts: Record<string, number>;
  mode: ContentsMode;
  active: string;
  linkFor: (patch: Record<string, string>) => string;
}) {
  const filters = [
    { value: "ALL", label: "Tutti", count: null as number | null },
    ...STATUS_ORDER.map((status) => ({
      value: status,
      label: FILTER_LABELS[status] ?? STATUS_META[status].label,
      count: counts[status] ?? 0,
    })),
  ];

  const chipClass = (isActive: boolean) =>
    cn(
      "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
      isActive
        ? "border-sky-300 bg-sky-50 text-sky-700"
        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f) => (
        <Link
          key={f.value}
          href={
            f.value === "DRAFT"
              ? linkFor({ view: "approvals" })
              : f.value === "ALL"
                ? linkFor({})
                : linkFor({ status: f.value })
          }
          aria-current={active === f.value ? "page" : undefined}
          className={chipClass(active === f.value)}
        >
          {f.label}
          {f.count !== null ? (
            <span className="ml-1.5 text-slate-400">{f.count}</span>
          ) : null}
        </Link>
      ))}

      {mode !== "HISTORY" ? (
        <Link
          href={linkFor({ view: "history" })}
          aria-current={active === "HISTORY" ? "page" : undefined}
          className={cn(
            "ml-1 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            active === "HISTORY"
              ? "border-sky-300 bg-sky-50 text-sky-700"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          )}
        >
          <History className="h-3.5 w-3.5" />
          Storico
        </Link>
      ) : null}
    </div>
  );
}
