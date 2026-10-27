import Link from "next/link";
import { Badge } from "@/components/ui";
import { formatDate } from "@/lib/utils";

/**
 * Storico delle decisioni di approvazione.
 *
 * Riutilizzato dalla vista "Storico decisioni" di /contents. Non introduce
 * azioni: la decisione è già stata presa e registrata come record Approval.
 */

export type ApprovalHistoryEntry = {
  id: string;
  decision: string;
  note: string | null;
  createdAt: string;
  content: { id: string; title: string | null; type: string };
};

export function ApprovalHistoryRow({
  approval,
}: {
  approval: ApprovalHistoryEntry;
}) {
  const approved = approval.decision === "APPROVED";
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <Badge
          className={
            approved
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }
        >
          {approved ? "Approvato" : "Rifiutato"}
        </Badge>
        <Link
          href={`/contents/${approval.content.id}`}
          className="ml-2 text-sm font-medium text-slate-800 dark:text-slate-200 hover:text-sky-700"
        >
          {approval.content.title ?? "Senza titolo"}
          <span className="ml-1 font-normal text-slate-400">
            ({approval.content.type.toLowerCase()})
          </span>
        </Link>
        {approval.note ? (
          <p className="mt-1 text-xs text-slate-500">{approval.note}</p>
        ) : null}
      </div>
      <div className="shrink-0 text-right text-xs text-slate-400">
        {formatDate(approval.createdAt, "dd/MM/yyyy HH:mm")}
      </div>
    </div>
  );
}

export function ApprovalHistoryList({
  entries,
}: {
  entries: ApprovalHistoryEntry[];
}) {
  return (
    <div className="divide-y divide-slate-100">
      {entries.map((a) => (
        <ApprovalHistoryRow key={a.id} approval={a} />
      ))}
    </div>
  );
}
