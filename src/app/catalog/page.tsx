import Link from "next/link";
import {
  AlertTriangle,
  BookOpen,
  Database,
  Image as ImageIcon,
  Info,
} from "lucide-react";
import {
  getCatalogStats,
  listCatalogProposals,
  listCatalogSources,
  anomaliesForProposals,
} from "@/lib/services/catalog";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ImportCatalogButton } from "@/components/catalog/import-button";
import {
  CatalogProposalCard,
  type CatalogProposalView,
} from "@/components/catalog/proposal-card";
import { CATALOG_CONFIDENCE_META, CATALOG_STATUS_META } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { CatalogAnomalyCode } from "@/lib/catalog/offerte";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  status?: string;
  confidence?: string;
  anomaly?: string;
  q?: string;
}>;

const STATUS_VALUES = Object.keys(CATALOG_STATUS_META);
const CONFIDENCE_VALUES = Object.keys(CATALOG_CONFIDENCE_META);

function isOneOf(value: string | undefined, allowed: string[]): value is string {
  return !!value && allowed.includes(value);
}

function stat(label: string, value: React.ReactNode, icon: React.ReactNode) {
  return (
    <Card className="flex items-center gap-3 px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        {icon}
      </div>
      <div className="leading-tight">
        <div className="text-lg font-bold text-slate-900">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </Card>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const status = isOneOf(params.status, STATUS_VALUES)
    ? (params.status as never)
    : undefined;
  const confidence = isOneOf(params.confidence, CONFIDENCE_VALUES)
    ? (params.confidence as never)
    : undefined;
  const anomalyFilter = params.anomaly as CatalogAnomalyCode | undefined;
  const query = params.q?.trim() ?? "";

  let stats: Awaited<ReturnType<typeof getCatalogStats>> | null = null;
  let sources: Awaited<ReturnType<typeof listCatalogSources>> = [];
  let proposals: Awaited<ReturnType<typeof listCatalogProposals>> = [];

  try {
    stats = await getCatalogStats();
    sources = await listCatalogSources();
    proposals = await listCatalogProposals({ status, confidence });
  } catch (e) {
    console.error("[page:catalog] caricamento catalogo fallito", e);
  }

  const anomalyMap = anomaliesForProposals(proposals);
  const visible = proposals.filter((proposal) => {
    const list = anomalyMap.get(proposal.id) ?? [];
    if (anomalyFilter && !list.some((a) => a.code === anomalyFilter)) return false;
    if (query) {
      const haystack = `${proposal.name} ${proposal.destination ?? ""}`.toLowerCase();
      if (!haystack.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  const filterLink = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const merged = { status, confidence, anomaly: anomalyFilter, q: query, ...params };
    for (const [key, value] of Object.entries(merged)) {
      if (value) search.set(key, value);
    }
    const qs = search.toString();
    return qs ? `/catalog?${qs}` : "/catalog";
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Catalogo Agenzia"
        description="Le proposte che l'agenzia mostra sul proprio sito pubblico."
        action={<ImportCatalogButton />}
      />

      {/* Avvertenza non negoziabile: questa pagina non è una fonte commerciale. */}
      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-amber-800">
          <strong className="font-semibold">Fonte di presentazione, non commerciale.</strong>{" "}
          Le proposte arrivano dalla pagina pubblica{" "}
          <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px]">
            /offerte/
          </code>{" "}
          e riportano solo ciò che il sito dichiara: nome e locandina ufficiale.
          Prezzi, date, durata, hotel e servizi <strong>non esistono</strong> nella
          fonte e per questo restano vuoti: un campo vuoto è un dato onesto, un
          valore inventato no. Tutto ciò che entra da qui nasce{" "}
          <strong>Da verificare</strong>.
        </p>
      </div>

      {stats ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stat("Proposte in catalogo", stats.proposals, <BookOpen className="h-4 w-4" />)}
          {stat("Locandine ufficiali", stats.images, <ImageIcon className="h-4 w-4" />)}
          {stat("Fonti collegate", stats.sources, <Database className="h-4 w-4" />)}
          {stat(
            "Da verificare",
            stats.byConfidence.UNVERIFIED ?? 0,
            <AlertTriangle className="h-4 w-4" />
          )}
        </div>
      ) : null}

      {/* Filtri stato e confidenza */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-slate-500">Stato:</span>
        <Link
          href={filterLink({ status: undefined })}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            !status
              ? "border-sky-300 bg-sky-50 text-sky-700"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          )}
        >
          Tutti
        </Link>
        {STATUS_VALUES.map((value) => (
          <Link
            key={value}
            href={filterLink({ status: value })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              status === value
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            {CATALOG_STATUS_META[value as keyof typeof CATALOG_STATUS_META].label}
            <span className="ml-1 text-slate-400">
              {stats?.byStatus[value] ?? 0}
            </span>
          </Link>
        ))}

        <span className="ml-3 text-xs font-medium text-slate-500">Affidabilità:</span>
        <Link
          href={filterLink({ confidence: undefined })}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            !confidence
              ? "border-sky-300 bg-sky-50 text-sky-700"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          )}
        >
          Tutte
        </Link>
        {CONFIDENCE_VALUES.map((value) => (
          <Link
            key={value}
            href={filterLink({ confidence: value })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              confidence === value
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            )}
          >
            {
              CATALOG_CONFIDENCE_META[
                value as keyof typeof CATALOG_CONFIDENCE_META
              ].label
            }
            <span className="ml-1 text-slate-400">
              {stats?.byConfidence[value] ?? 0}
            </span>
          </Link>
        ))}
      </div>

      {/* Anomalie rilevate: visibili, mai corrette in automatico */}
      {stats && stats.byAnomaly.length > 0 ? (
        <Card className="mb-4 p-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Anomalie rilevate
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Non vengono corrette automaticamente: restano da revisionare a mano.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {stats.byAnomaly.map((item) => (
              <Link
                key={item.code}
                href={filterLink({
                  anomaly: anomalyFilter === item.code ? undefined : item.code,
                })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  anomalyFilter === item.code
                    ? "border-amber-400 bg-amber-100 text-amber-800"
                    : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100"
                )}
              >
                <AlertTriangle className="h-3 w-3" />
                {item.label}
                <span className="font-bold">{item.count}</span>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Ricerca */}
      <form method="get" action="/catalog" className="mb-4 flex max-w-sm gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        {confidence ? (
          <input type="hidden" name="confidence" value={confidence} />
        ) : null}
        {anomalyFilter ? (
          <input type="hidden" name="anomaly" value={anomalyFilter} />
        ) : null}
        <input
          name="q"
          defaultValue={query}
          placeholder="Cerca per nome o destinazione"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        <button
          type="submit"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          Cerca
        </button>
      </form>

      {visible.length === 0 ? (
        <EmptyState
          title={
            proposals.length === 0
              ? "Catalogo vuoto"
              : "Nessuna proposta corrisponde ai filtri"
          }
          description={
            proposals.length === 0
              ? "Importa le proposte dalla pagina pubblica /offerte/ dell'agenzia. L'import è idempotente: puoi ripeterlo senza creare duplicati."
              : "Modifica i filtri o la ricerca per vedere altre proposte."
          }
          action={<ImportCatalogButton />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((proposal) => (
            <CatalogProposalCard
              key={proposal.id}
              proposal={proposal as unknown as CatalogProposalView}
              anomalies={anomalyMap.get(proposal.id) ?? []}
            />
          ))}
        </div>
      )}

      {sources.length > 0 ? (
        <Card className="mt-6 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Fonti</h2>
          <ul className="mt-2 space-y-1.5">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500"
              >
                <span className="font-medium text-slate-700">{source.domain}</span>
                <span className="font-mono text-[11px]">{source.pageUrl}</span>
                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px]">
                  {source.kind}
                </span>
                <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                  presentazione, non commerciale
                </span>
                <span>
                  ultima lettura:{" "}
                  {source.lastCrawledAt
                    ? source.lastCrawledAt.toLocaleDateString("it-IT")
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
