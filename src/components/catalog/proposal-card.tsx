import Link from "next/link";
import { AlertTriangle, ExternalLink, MinusCircle } from "lucide-react";
import {
  Badge,
  CatalogConfidenceBadge,
  CatalogStatusBadge,
  MediaPlaceholder,
} from "@/components/ui";
import { CATALOG_COMMERCIAL_FIELDS } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { CatalogAnomaly } from "@/lib/catalog/offerte";

import { RegenerateLocandinaButton } from "@/components/catalog/regenerate-button";

export type CatalogProposalView = {
  id: string;
  name: string;
  destination: string | null;
  status: string;
  confidence: string;
  sourceUrl: string;
  sourceOrder: number | null;
  acquiredAt: Date | string;
  sourceUpdatedAt: Date | string | null;
  lastSeenAt: Date | string | null;
  missingSince: Date | string | null;
  images: { id: string; url: string; filename: string; width: number | null; height: number | null }[];
  source: { domain: string; pageUrl: string; authority: string; lastCrawledAt: Date | string | null } | null;
};

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: Date | string | null): string {
  const date = asDate(value);
  return date ? date.toLocaleDateString("it-IT") : "-";
}

export function CatalogProposalCard({
  proposal,
  anomalies,
}: {
  proposal: CatalogProposalView;
  anomalies: CatalogAnomaly[];
}) {
  const image = proposal.images[0];
  const missing = proposal.missingSince !== null;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm",
        missing ? "border-slate-200 opacity-70" : "border-slate-200"
      )}
    >
      <div className="relative flex h-44 items-center justify-center bg-slate-50">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={proposal.name}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        ) : (
          <MediaPlaceholder className="h-full w-full" />
        )}
        {proposal.sourceOrder !== null ? (
          <span className="absolute left-2 top-2 rounded-md bg-white/90 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
            #{proposal.sourceOrder + 1}
          </span>
        ) : null}
        {missing ? (
          <span className="absolute right-2 top-2">
            <Badge className="border-slate-300 bg-slate-100 text-slate-600">
              Non piu sul sito
            </Badge>
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{proposal.name}</h3>
          <p className="text-xs text-slate-500">
            {proposal.destination ?? (
              <span className="text-amber-600">Destinazione non ricavabile</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <CatalogStatusBadge status={proposal.status} />
          <CatalogConfidenceBadge confidence={proposal.confidence} />
        </div>

        {anomalies.length > 0 ? (
          <ul className="space-y-1 rounded-lg bg-amber-50 p-2">
            {anomalies.map((item) => (
              <li key={item.code} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                <span className="text-[11px] leading-snug text-amber-800">
                  <strong className="font-semibold">{item.label}.</strong>{" "}
                  {item.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-auto space-y-1.5 border-t border-slate-100 pt-2">
          <p className="flex items-center gap-1 text-[11px] text-slate-400">
            <MinusCircle className="h-3 w-3" />
            Dati commerciali dalla fonte
          </p>
          <div className="flex flex-wrap gap-1">
            {CATALOG_COMMERCIAL_FIELDS.map((field) => (
              <span
                key={field.field}
                className="rounded border border-dashed border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400"
              >
                {field.label}: -
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-100 pt-2">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span>Acquisita {formatDate(proposal.acquiredAt)}</span>
            <Link
              href={proposal.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sky-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              pagina sorgente
            </Link>
          </div>

          <RegenerateLocandinaButton proposalId={proposal.id} />
        </div>
      </div>
    </div>
  );
}