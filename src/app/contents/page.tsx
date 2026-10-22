import Link from "next/link";
import { CalendarClock, ChevronLeft, ChevronRight, ImageOff, Search } from "lucide-react";
import type { ContentStatus } from "@prisma/client";
import {
  listContents,
  countContents,
  countsByStatus,
  type ContentWithRelations,
} from "@/lib/services/content";
import { getApprovalHistory } from "@/lib/services/approvals";
import { STATUS_ORDER } from "@/lib/status";
import {
  Card,
  CardHeader,
  StatusBadge,
  TypeBadge,
  PlatformBadge,
  PlatformBadges,
  MediaThumb,
  MediaPlaceholder,
  EmptyState,
  PageHeader,
  Input,
  Button,
  LinkButton,
} from "@/components/ui";
import { NewContentButton } from "@/components/new-content-button";
import { StatusFilterBar, type ContentsMode } from "@/components/content/status-filter-bar";
import { ReviewDeck, type ReviewDeckItem } from "@/components/content/review-deck";
import { ApprovalHistoryList } from "@/components/content/approval-history";
import { cn, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * /contents è il centro operativo: controlla, approva, programma, pubblica.
 *
 * Tre viste sulla stessa rotta, senza seconde pagine:
 *   - vista=approvals → Review Deck (coda DRAFT, approvazione rapida)
 *   - vista=history   → storico decisioni
 *   - default          → lista o griglia con filtro per stato
 *
 * `?status=DRAFT` viene normalizzato sulla Review Deck: la coda di
 * approvazione ha una sola UI, non due.
 */
const DECK_LIMIT = 24;

/**
 * Elementi per pagina nella lista/griglia.
 *
 * Senza paginazione la rotta caricava fino a 300 contenuti con tutte le
 * relazioni: misurati 4,2 s e 1,5 MB di HTML con 94 contenuti, e la pagina
 * cresceva linearmente con i dati. Con il paging il payload resta costante
 * e la rotta scala.
 */
const PAGE_SIZE = 24;

type SearchParams = Promise<{ status?: string; q?: string; view?: string; page?: string }>;

function excerpt(text: string | null, max = 120): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

function toDeckItem(c: ContentWithRelations): ReviewDeckItem {
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    caption: c.caption,
    hashtags: c.hashtags,
    scheduledDate: c.scheduledDate ? c.scheduledDate.toISOString() : null,
    platforms: c.platforms.map((p) => ({ platform: p.platform })),
    assets: c.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      url: a.url,
      filename: a.filename,
    })),
    slideImages: c.slides
      .map((s) => s.imageUrl)
      .filter((u): u is string => Boolean(u)),
  };
}

export default async function ContentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const rawStatus = params.status ?? "ALL";
  const q = (params.q ?? "").trim();
  const rawView = params.view;

  // Paging: valore non numerico, negativo o assente => prima pagina.
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  // Una sola UI per la coda: ?status=DRAFT e ?view=approvals sono la stessa vista.
  const isDeck = rawView === "approvals" || rawStatus === "DRAFT";
  const isHistory = rawView === "history" && !isDeck;
  const mode: ContentsMode = isDeck ? "APPROVALS" : isHistory ? "HISTORY" : "ALL";
  const view = rawView === "list" ? "list" : "grid";

  // Il filtro di stato della lista esclude DRAFT (è il deck) e REVIEW (legacy).
  const listStatus: ContentStatus | null =
    !isDeck &&
    !isHistory &&
    rawStatus !== "DRAFT" &&
    STATUS_ORDER.includes(rawStatus as ContentStatus)
      ? (rawStatus as ContentStatus)
      : null;

  // Ogni vista carica solo ciò che le serve. I conteggi sono GLOBALI e non
  // dipendono dal filtro attivo: una groupBy, niente conteggi sul dataset filtrato.
  const noContents: ContentWithRelations[] = [];
  const noHistory: Awaited<ReturnType<typeof getApprovalHistory>> = [];
  const noCounts = {} as Record<ContentStatus, number>;

  const isList = !isDeck && !isHistory;
  /** Filtri della lista: identici per il conteggio e per i dati. */
  const listFilters = {
    status: listStatus ?? undefined,
    search: q || undefined,
  };

  const [counts, deck, history, total] = await Promise.all([
    countsByStatus().catch(() => noCounts),
    isDeck
      ? listContents({ status: "DRAFT", limit: DECK_LIMIT }).catch(() => noContents)
      : Promise.resolve(noContents),
    isHistory ? getApprovalHistory(30).catch(() => noHistory) : Promise.resolve(noHistory),
    isList ? countContents(listFilters).catch(() => 0) : Promise.resolve(0),
  ]);

  // La pagina richiesta viene limitata all'ultima pagina esistente: un ?page=99
  // mostrerà l'ultima pagina invece di una pagina vuota.
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const contents = isList
    ? await listContents({ ...listFilters, limit: PAGE_SIZE, offset }).catch(() => noContents)
    : noContents;

  const pendingCount = counts.DRAFT ?? 0;

  // Chiave attualmente selezionata nella barra filtri: senza questo, un
  // filtro per stato e "Tutti" risulterebbero entrambi attivi.
  const activeFilter = isDeck ? "DRAFT" : isHistory ? "HISTORY" : listStatus ?? "ALL";

  /** Costruisce l'URL della vista corrente: il patch definisce tutto. */
  const linkFor = (patch: Record<string, string>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
    }
    if (q) sp.set("q", q);
    // Cambio di filtro o di vista = nuova ricerca: si torna alla pagina 1.
    const qs = sp.toString();
    return qs ? `/contents?${qs}` : "/contents";
  };

  /**
   * URL della pagina `n` mantenendo i filtri correnti.
   *
   * Diversamente da `linkFor`, che resetta il paging, qui il contesto (stato
   * e ricerca) va conservato: cambiare pagina non è cambiare filtro.
   */
  const pageFor = (n: number) => {
    const sp = new URLSearchParams();
    if (listStatus) sp.set("status", listStatus);
    if (q) sp.set("q", q);
    if (view === "list") sp.set("view", "list");
    if (n > 1) sp.set("page", String(n));
    const qs = sp.toString();
    return qs ? `/contents?${qs}` : "/contents";
  };

  /**
   * Controlli di paging.
   *
   * Link puri: nessun form aggiuntivo (la ricerca resta l'unico form della
   * pagina) e nessuno stato client, quindi la rotta resta interamente
   * renderizzata lato server e funziona anche senza JavaScript.
   */
  const pager = totalPages > 1 ? (
    <nav
      aria-label="Pagine contenuti"
      className="mt-6 flex flex-wrap items-center justify-between gap-3"
    >
      {currentPage > 1 ? (
        <LinkButton href={pageFor(currentPage - 1)} variant="secondary" size="sm">
          <ChevronLeft className="h-4 w-4" />
          Precedente
        </LinkButton>
      ) : (
        <span />
      )}

      <p aria-live="polite" className="text-xs text-slate-500">
        Pagina {currentPage} di {totalPages} · {total} contenut{total === 1 ? "o" : "i"}
      </p>

      {currentPage < totalPages ? (
        <LinkButton href={pageFor(currentPage + 1)} variant="secondary" size="sm">
          Successiva
          <ChevronRight className="h-4 w-4" />
        </LinkButton>
      ) : (
        <span />
      )}
    </nav>
  ) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Contenuti"
        description="Gestisci, approva e programma i contenuti."
        action={<NewContentButton />}
      />

      <div className="mb-4 space-y-3">
        <StatusFilterBar
          counts={counts}
          mode={mode}
          active={activeFilter}
          linkFor={linkFor}
        />

        <div className="flex flex-wrap items-center gap-2">
          <form className="flex min-w-0 flex-1 gap-2" action="">
            <Input
              name="q"
              defaultValue={q}
              placeholder="Cerca per titolo, testo o hashtag…"
              className="max-w-sm"
              aria-label="Cerca contenuti"
            />
            {/* La ricerca non deve perdere il contesto della vista corrente. */}
            {listStatus ? <input type="hidden" name="status" value={listStatus} /> : null}
            {isDeck ? <input type="hidden" name="view" value="approvals" /> : null}
            {isHistory ? <input type="hidden" name="view" value="history" /> : null}
            {view === "list" && !isDeck && !isHistory ? (
              <input type="hidden" name="view" value="list" />
            ) : null}
            <Button type="submit" variant="secondary" size="md">
              <Search className="h-4 w-4" />
              Cerca
            </Button>
          </form>

          {isDeck || isHistory ? null : (
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
              {(["list", "grid"] as const).map((v) => (
                <Link
                  key={v}
                  href={linkFor({ view: v, status: listStatus ?? "" })}
                  aria-current={view === v ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                    view === v
                      ? "bg-sky-50 text-sky-700"
                      : "text-slate-500 hover:bg-slate-50"
                  )}
                >
                  {v === "grid" ? "Griglia" : "Lista"}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {isDeck ? (
        <ReviewDeck
          items={deck.map(toDeckItem)}
          totalPending={pendingCount}
          historyHref={linkFor({ view: "history" })}
          allHref="/contents"
        />
      ) : isHistory ? (
        <div className="mx-auto max-w-3xl">
          <Card className="overflow-hidden">
            <CardHeader
              title="Storico decisioni"
              description="Ultime approvazioni e rifiuti registrati sui contenuti"
              action={
                <LinkButton
                  href={linkFor({ view: "approvals" })}
                  variant="secondary"
                  size="sm"
                >
                  Torna a Da approvare
                </LinkButton>
              }
            />
            {history.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Nessuna decisione registrata"
                  description="Le approvazioni e i rifiuti compariranno qui."
                />
              </div>
            ) : (
              <ApprovalHistoryList
                entries={history.map((a) => ({
                  id: a.id,
                  decision: a.decision,
                  note: a.note,
                  createdAt: a.createdAt.toISOString(),
                  content: a.content,
                }))}
              />
            )}
          </Card>
        </div>
      ) : contents.length === 0 ? (
        <EmptyState
          title="Nessun contenuto trovato"
          description={
            q
              ? "Nessun risultato per la ricerca corrente."
              : "Crea il primo contenuto con il pulsante qui sopra."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <NewContentButton label="Crea il primo contenuto" />
            </div>
          }
        />
      ) : view === "grid" ? (
        <>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {contents.map((c) => {
            const first = c.assets[0];
            const preview = excerpt(c.caption, 110);
            return (
              <Link
                key={c.id}
                href={`/contents/${c.id}`}
                className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
                  {first ? (
                    <MediaThumb asset={first} className="h-full w-full" />
                  ) : (
                    <MediaPlaceholder className="h-full w-full" />
                  )}
                  {c.assets.length > 1 ? (
                    <span className="absolute bottom-2 right-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-white">
                      +{c.assets.length - 1}
                    </span>
                  ) : null}
                  {c.assets.length === 0 ? (
                    <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      <ImageOff className="h-3 w-3" />
                      Senza media
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="line-clamp-2 text-sm font-semibold text-slate-900 group-hover:text-sky-700">
                      {c.title ?? "Senza titolo"}
                    </h2>
                    <StatusBadge status={c.status} className="shrink-0" />
                  </div>

                  {preview ? (
                    <p className="line-clamp-2 text-xs text-slate-500">{preview}</p>
                  ) : (
                    <p className="line-clamp-2 text-xs italic text-slate-400">
                      Nessun testo
                    </p>
                  )}

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <TypeBadge type={c.type} />
                    {c.platforms.length === 0 ? (
                      <span className="text-[11px] text-slate-400">
                        Nessuna piattaforma
                      </span>
                    ) : (
                      c.platforms.slice(0, 3).map((p) => (
                        <PlatformBadge key={p.id} platform={p.platform} />
                      ))
                    )}
                  </div>

                  <div className="flex items-center gap-1 border-t border-slate-100 pt-2 text-[11px] text-slate-400">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {c.status === "PUBLISHED"
                      ? "Pubblicato"
                      : c.scheduledDate
                        ? `Programmato ${formatDate(c.scheduledDate, "dd/MM/yyyy")}`
                        : "Non programmato"}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
        {pager}
        </>
      ) : (
        <>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Contenuto</th>
                  <th className="px-3 py-3 font-medium">Media</th>
                  <th className="px-3 py-3 font-medium">Tipo</th>
                  <th className="px-3 py-3 font-medium">Stato</th>
                  <th className="px-3 py-3 font-medium">Piattaforme</th>
                  <th className="px-3 py-3 font-medium">Programmazione</th>
                  <th className="px-5 py-3 font-medium">Aggiornato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {contents.map((c) => {
                  const first = c.assets[0];
                  return (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <Link
                          href={`/contents/${c.id}`}
                          className="block font-medium text-slate-800 hover:text-sky-700"
                        >
                          <span className="block max-w-56 truncate">
                            {c.title ?? "Senza titolo"}
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        {first ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                            <MediaThumb
                              asset={first}
                              className="h-8 w-8 rounded"
                            />
                            {c.assets.length > 1 ? `+${c.assets.length - 1}` : null}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-600">Senza media</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <TypeBadge type={c.type} />
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="px-3 py-3">
                        <PlatformBadges platforms={c.platforms} />
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-500">
                        {c.scheduledDate ? formatDate(c.scheduledDate) : "—"}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400">
                        {formatDate(c.updatedAt, "dd/MM/yyyy")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        {pager}
        </>
      )}
    </div>
  );
}
