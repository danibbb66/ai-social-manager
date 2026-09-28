/**
 * Accesso in sola lettura al Catalogo Agenzia per l'AI.
 *
 * Separato da `services/catalog.ts`, che è la zona di scrittura/import: qui
 * nessuna funzione modifica il catalogo. L'AI riceve un DTO controllato, mai
 * HTML grezzo e mai una riga del database: i campi commerciali sono esposti
 * solo se davvero valorizzati, così il modello non può confondere "non
 * valorizzato" con "da recuperare".
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { textMatchesQuery } from "@/lib/catalog/text";
import {
  anomaliesForProposals,
  catalogProposalInclude,
} from "@/lib/services/catalog";
import type { CatalogAnomaly, CatalogAnomalyCode } from "@/lib/catalog/offerte";

/**
 * Anomalie che rendono il dato inaffidabile per la copy.
 *
 * - `MISSING_TITLE` / `PLACEHOLDER_TITLE`: il nome non è un dato dell'agenzia.
 * - `TITLE_IMAGE_MISMATCH`: immagine e titolo descrivono cose diverse.
 * - `NOT_ON_SITE`: la card non è più sulla pagina.
 *
 * `DESTINATION_MISSING` e `SHARED_IMAGE` restano fuori: sono informazioni
 * utili, ma non rendono il nome inutilizzabile.
 */
export const BLOCKING_ANOMALY_CODES: readonly CatalogAnomalyCode[] = [
  "MISSING_TITLE",
  "PLACEHOLDER_TITLE",
  "TITLE_IMAGE_MISMATCH",
  "NOT_ON_SITE",
];

const COMMERCIAL_FIELDS = [
  "periodStart",
  "periodEnd",
  "departureCities",
  "durationNights",
  "priceFrom",
  "priceTo",
  "currency",
  "priceNote",
  "included",
  "excluded",
] as const;

export type CommercialField = (typeof COMMERCIAL_FIELDS)[number];

/**
 * Campi commerciali con il loro tipo reale.
 *
 * Le date viaggiano come ISO string perché il DTO attraversa il confine del
 * modello; gli importi restano numeri, ed è per questo che il tipo qui è
 * esplicito: un DTO "qualsiasi stringa o numero" renderebbe impossibile
 * controllare in compilazione che la copy non tratti una data come un prezzo.
 */
export interface CatalogCommercialDto {
  periodStart: string | null;
  periodEnd: string | null;
  departureCities: string | null;
  durationNights: number | null;
  priceFrom: number | null;
  priceTo: number | null;
  currency: string | null;
  priceNote: string | null;
  included: string | null;
  excluded: string | null;
}

/** Limite di proposte restituite al modello: contenuto del turno, non un elenco. */
const MAX_RESULTS = 8;

const aiProposalInclude = {
  ...catalogProposalInclude,
  // Solo l'ultimo utilizzo: serve alla strategia "non già usata recentemente"
  // senza caricare lo storico dei contenuti.
  contents: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
} satisfies Prisma.CatalogProposalInclude;

type AiProposal = Prisma.CatalogProposalGetPayload<{ include: typeof aiProposalInclude }>;

export interface CatalogProposalDto {
  id: string;
  name: string;
  destination: string | null;
  status: string;
  confidence: string;
  /** Pagina della card: da dove arriva questa proposta. */
  sourceUrl: string;
  sourceType: string;
  source: {
    domain: string;
    pageUrl: string;
    kind: string;
    authority: string;
  };
  commercial: CatalogCommercialDto;
  /** Solo i campi davvero valorizzati: il resto va trattato come assente. */
  commercialFieldsPresent: CommercialField[];
  /**
   * Immagine ufficiale della proposta, con l'id della riga `CatalogImage`.
   *
   * L'id serve alla provenienza: quando la copia locale viene materializzata,
   * l'asset deve poter risalire all'immagine esatta del catalogo, non solo
   * all'URL (che può cambiare tra un'importazione e l'altra).
   */
  officialImage: { id: string; url: string; filename: string } | null;
  anomalies: { code: CatalogAnomalyCode; label: string; detail: string }[];
  /** Si può scrivere copy su questa proposta? */
  usable: boolean;
  unusableReason: string | null;
  /** Ultimo contenuto creato da questa proposta, se esiste. */
  lastUsedAt: string | null;
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function commercialFieldsPresent(proposal: {
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  departureCities?: string | null;
  durationNights?: number | null;
  priceFrom?: number | null;
  priceTo?: number | null;
  currency?: string | null;
  priceNote?: string | null;
  included?: string | null;
  excluded?: string | null;
}): CommercialField[] {
  return COMMERCIAL_FIELDS.filter((field) => isFilled(proposal[field]));
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!isFilled(value)) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** DTO derivato da una riga del catalogo: funzione pura, testabile da sola. */
export function toCatalogProposalDto(
  proposal: AiProposal,
  anomalies: CatalogAnomaly[] = []
): CatalogProposalDto {
  const present = commercialFieldsPresent(proposal);
  const image = proposal.images[0] ?? null;
  const blocking = anomalies.filter((a) => BLOCKING_ANOMALY_CODES.includes(a.code));

  const notOnSite = proposal.missingSince !== null;
  const reasons: string[] = [];
  if (proposal.status !== "ACTIVE") reasons.push(`stato ${proposal.status}`);
  if (notOnSite) reasons.push("non è più sulla pagina del sito");
  for (const anomaly of blocking) {
    if (anomaly.code !== "NOT_ON_SITE") reasons.push(anomaly.detail);
  }

  return {
    id: proposal.id,
    name: proposal.name,
    destination: proposal.destination,
    status: proposal.status,
    confidence: proposal.confidence,
    sourceUrl: proposal.sourceUrl,
    sourceType: proposal.sourceType,
    source: {
      domain: proposal.source.domain,
      pageUrl: proposal.source.pageUrl,
      kind: proposal.source.kind,
      authority: proposal.source.authority,
    },
    commercial: {
      periodStart: isoOrNull(proposal.periodStart),
      periodEnd: isoOrNull(proposal.periodEnd),
      departureCities: proposal.departureCities ?? null,
      durationNights: proposal.durationNights ?? null,
      priceFrom: proposal.priceFrom ?? null,
      priceTo: proposal.priceTo ?? null,
      currency: proposal.currency ?? null,
      priceNote: proposal.priceNote ?? null,
      included: proposal.included ?? null,
      excluded: proposal.excluded ?? null,
    },
    commercialFieldsPresent: present,
    officialImage: image ? { id: image.id, url: image.url, filename: image.filename } : null,
    anomalies: anomalies.map((a) => ({ code: a.code, label: a.label, detail: a.detail })),
    usable: reasons.length === 0,
    unusableReason: reasons.length ? reasons.join("; ") : null,
    lastUsedAt: proposal.contents[0]?.createdAt.toISOString() ?? null,
  };
}

/**
 * Proposte ACTIVE e ancora presenti sul sito.
 *
 * Il catalogo dell'agenzia è una lista di poche decine di card: le anomalie
 * (in particolare `SHARED_IMAGE`) si calcolano sul lotto completo, altrimenti
 * un'immagine condivisa risulterebbe "unica" solo per casualità della pagina.
 */
export async function listActiveProposals(): Promise<AiProposal[]> {
  return prisma.catalogProposal.findMany({
    where: { status: "ACTIVE", missingSince: null },
    include: aiProposalInclude,
    orderBy: [{ sourceOrder: "asc" }, { acquiredAt: "asc" }, { id: "asc" }],
  });
}

/** DTO di tutte le proposte ACTIVE, con anomalie ricalcolate. */
export async function activeProposalDtos(): Promise<CatalogProposalDto[]> {
  const proposals = await listActiveProposals();
  const anomalies = anomaliesForProposals(proposals);
  return proposals.map((p) => toCatalogProposalDto(p, anomalies.get(p.id) ?? []));
}

/**
 * Strategia di selezione, deterministica e documentata.
 *
 * Nell'ordine:
 * 1. solo proposte utilizzabili (ACTIVE, presenti, senza anomalie bloccanti);
 * 2. con immagine ufficiale disponibile, perché un DRAFT senza visual non è
 *    promuovibile adesso;
 * 3. mai usate prima, a parità di catalogo: evita di riproporre sempre la stessa
 *    locandina;
 * 4. a parità di uso, ordine stabile della fonte (sourceOrder, acquiredAt, id).
 *
 * Se tutte le candidate sono già state usate si riparte dalla stessa ordine
 * stabile: la selezione resta deterministica, semplicemente ciclica.
 */
function compareCandidates(a: CatalogProposalDto, b: CatalogProposalDto): number {
  if (a.usable !== b.usable) return a.usable ? -1 : 1;
  if (Boolean(a.officialImage) !== Boolean(b.officialImage)) {
    return a.officialImage ? -1 : 1;
  }
  const aUsed = a.lastUsedAt !== null;
  const bUsed = b.lastUsedAt !== null;
  if (aUsed !== bUsed) return aUsed ? 1 : -1;
  if (aUsed && bUsed && a.lastUsedAt !== b.lastUsedAt) {
    // meno usata di recente prima: ordine cronologico crescente
    return a.lastUsedAt! < b.lastUsedAt! ? -1 : 1;
  }
  return 0;
}

export interface CatalogSearchResult {
  total: number;
  query: string | null;
  proposals: CatalogProposalDto[];
}

/** Ricerca per testo/destinazione. Nessuna query = elenco dei candidati. */
export async function searchCatalogForAi(input?: {
  query?: string | null;
  limit?: number;
}): Promise<CatalogSearchResult> {
  const query = input?.query?.trim() || null;
  const all = await activeProposalDtos();
  const ordered = sortByPromotionFit(all);
  const matched = filterByQuery(ordered, query);

  const limit = Math.min(Math.max(input?.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
  return { total: matched.length, query, proposals: matched.slice(0, limit) };
}

export async function getCatalogProposalForAi(id: string): Promise<CatalogProposalDto | null> {
  const all = await activeProposalDtos();
  return all.find((p) => p.id === id) ?? null;
}

/** Proposta promuovibile, con immagine e non ancora usata. */
export function promotable(dto: CatalogProposalDto): boolean {
  return dto.usable && dto.officialImage !== null;
}

/** Ordine di selezione, esposto per test e riuso. */
export function sortByPromotionFit(proposals: CatalogProposalDto[]): CatalogProposalDto[] {
  return [...proposals].sort(compareCandidates);
}

/** Filtro per destinazione/testo sul DTO. Esposto perché è logica pura. */
export function filterByQuery(
  proposals: CatalogProposalDto[],
  query: string | null
): CatalogProposalDto[] {
  if (!query) return proposals;
  return proposals.filter((p) => textMatchesQuery(`${p.name} ${p.destination ?? ""}`, query));
}

/**
 * Selezione per una richiesta generica ("crea un post"), su una lista già
 * caricata. `null` = nessuna proposta utilizzabile: il chiamante NON deve
 * creare nulla.
 */
export function selectFromProposals(
  proposals: CatalogProposalDto[],
  query?: string | null
): CatalogProposalDto | null {
  return sortByPromotionFit(filterByQuery(proposals, query ?? null)).find(promotable) ?? null;
}

/**
 * Selezione per una richiesta generica ("crea un post").
 * `null` = nessuna proposta utilizzabile: il chiamante NON deve creare nulla.
 */
export async function selectCatalogProposalForAi(input?: {
  query?: string | null;
}): Promise<CatalogProposalDto | null> {
  return selectFromProposals(await activeProposalDtos(), input?.query ?? null);
}

/** Il catalogo ha almeno una proposta utilizzabile? */
export async function hasPromotableProposal(): Promise<boolean> {
  return (await selectCatalogProposalForAi()) !== null;
}

export type CatalogResolution =
  | { ok: true; proposal: CatalogProposalDto }
  | { ok: false; reason: string; message: string };

/**
 * Regola "il modello non inventa", applicata a una lista di proposte.
 *
 * È una funzione pura su purpose: le garanzie si verificano anche con il
 * catalogo vuoto, senza dover azzerare i dati reali per il test.
 */
export function resolveFromProposals(
  candidates: CatalogProposalDto[],
  input: { proposalId?: string | null; destination?: string | null }
): CatalogResolution {
  const id = input.proposalId?.trim() || null;
  const destination = input.destination?.trim() || null;

  if (id) {
    const found = candidates.find((p) => p.id === id) ?? null;
    if (!found) {
      return {
        ok: false,
        reason: "proposal_not_found",
        message:
          `Nessuna proposta con id ${id} nel Catalogo attivo. ` +
          "Non creare il contenuto: usa searchCatalog per gli id validi.",
      };
    }
    if (!found.usable) {
      return {
        ok: false,
        reason: "proposal_unusable",
        message:
          `La proposta "${found.name}" non è utilizzabile (${found.unusableReason}). ` +
          "Non creare il contenuto e non correggerla da solo: segnalala all'utente.",
      };
    }
    if (destination && !textMatchesQuery(`${found.name} ${found.destination ?? ""}`, destination)) {
      return {
        ok: false,
        reason: "destination_mismatch",
        message:
          `La proposta "${found.name}" non corrisponde alla destinazione richiesta "${destination}". ` +
          "Non creare il contenuto: verifica con searchCatalog.",
      };
    }
    return { ok: true, proposal: found };
  }

  if (destination) {
    const matched = filterByQuery(candidates, destination);
    if (matched.length === 0) {
      return {
        ok: false,
        reason: "destination_absent",
        message:
          `Nel Catalogo attivo non c'è nessuna proposta per "${destination}". ` +
          "NON creare il DRAFT e non usare una tua conoscenza precedente: " +
          `spiega all'utente che nel Catalogo attuale non è presente una proposta ${destination} ` +
          "e chiedi un'altra destinazione oppure l'aggiornamento del Catalogo.",
      };
    }
    const usable = sortByPromotionFit(matched).filter((p) => p.usable);
    if (usable.length === 0) {
      return {
        ok: false,
        reason: "destination_unusable",
        message:
          `Le proposte per "${destination}" nel Catalogo non sono utilizzabili ` +
          `(${matched.map((p) => p.unusableReason).filter(Boolean).join("; ")}). ` +
          "Non creare il DRAFT: segnalo il problema all'utente.",
      };
    }
    return { ok: true, proposal: usable[0] };
  }

  // Richiesta generica: la scelta la fa il codice, non il modello.
  const selected = selectFromProposals(candidates, null);
  if (!selected) {
    return {
      ok: false,
      reason: "catalog_empty",
      message:
        "Il Catalogo Agenzia non contiene proposte utilizzabili (vuoto, tutte con anomalie bloccanti o senza immagine). " +
        "NON creare il DRAFT: spiega all'utente che il Catalogo va importato o corretto prima di promuovere qualcosa.",
    };
  }
  return { ok: true, proposal: selected };
}

/**
 * Risolve la proposta da promuovere, o spiega perché non esiste.
 *
 * È il punto in cui la regola "il modello non inventa" diventa codice e non
 * prompt: nessun id inesistente e nessuna destinazione assente producono un
 * DRAFT.
 */
export async function resolveCatalogProposalForAi(input: {
  proposalId?: string | null;
  destination?: string | null;
}): Promise<CatalogResolution> {
  return resolveFromProposals(await activeProposalDtos(), input);
}
