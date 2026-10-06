/**
 * Dati commerciali di una proposta, con la provenienza della locandina.
 *
 * Regola che governa tutto il file: **un campo vale solo se esiste una prova
 * nella fonte**. Se il dato non c'è, il campo è `null` e resta un warning
 * esplicito. Non esiste un percorso che stima, deduca o completa un dato
 * commerciale: un prezzo inventato su una locandina è indistinguibile da uno
 * vero, e su un'immagine social nessuno può accorgersene.
 *
 * Per questo l'estrattore legge una sola cosa: i campi già valorizzati nella
 * riga `CatalogProposal`, che l'import del catalogo ha copiato dalla pagina
 * dell'agenzia. Il nome del file dell'immagine (`locandina_mainstream-CRETA…`)
 * non viene mai letto: è un nome di file, non una fonte, e derivarne la
 * destinazione o il prezzo significa inventare.
 *
 * Quello che qui NON c'è, di proposito: un motore OCR. Nel progetto non ne
 * esiste uno (né libreria, né modello vision su Ollama), quindi questa versione
 * non promette di leggere i pixel della locandina: dichiara che i dati
 * commerciali arrivano dal record di catalogo. Quando l'estrazione dai pixel
 * diventerà disponibile, si aggiungerà come metodo dichiarato
 * (`extractionMethod`), non come ripiego silenzioso dentro questo file.
 */

import type { CatalogProposalDto } from "@/lib/services/catalog-ai";
import { formatDateRange, formatPriceRange } from "@/lib/catalog/commercial-format";
import { stripDistributorBranding } from "@/lib/catalog/distributor";

/**
 * Come i dati commerciali sono arrivati.
 *
 * `catalog-record` = letti dai campi già valorizzati della proposta, quindi
 * tracciabili a una fonte concreta. Non esiste ancora un ramo OCR: dichiararlo
 * ora, con un valore che non esiste, sarebbe mentire sul metodo.
 */
export const COMMERCIAL_EXTRACTION_METHOD = "catalog-record" as const;

export type CommercialExtractionMethod = typeof COMMERCIAL_EXTRACTION_METHOD;

/** Un dato commerciale e la prova da cui viene. */
export type ExtractedField<T = string | number | null> = {
  field: string;
  value: T;
  /** Campo di `CatalogProposal` o letterale del testo da cui è stato preso. */
  from: string;
  /** Come è stato ottenuto: copia di un campo, o corrispondenza letterale. */
  kind: "CATALOG_FIELD" | "LITERAL_MATCH";
};

export interface CommercialExtraction {
  proposalId: string;
  destination: string | null;
  title: string;
  /** Prezzo minimo dichiarato. `null` se la proposta non lo contiene. */
  price: number | null;
  /** Prezzo massimo dichiarato, quando la proposta dà un intervallo. */
  priceTo: number | null;
  currency: string | null;
  departureCity: string | null;
  departureDate: string | null;
  returnDate: string | null;
  duration: string | null;
  accommodation: string | null;
  board: string | null;
  transport: string | null;
  /** La locandina da cui tutto questo proviene. */
  sourceImageUrl: string;
  sourceImageId: string | null;
  sourceImageFilename: string | null;
  extractionMethod: CommercialExtractionMethod;
  extractedFields: ExtractedField[];
  /** 0 = nessun dato commerciale trovato. Mai 1: la verifica resta umana. */
  confidence: number;
  warnings: string[];
}

/**
 * Letterali accettati per i campi che lo schema non ha.
 *
 * Sono l'unico modo in cui `accommodation`, `board` e `transport` possono
 * riempirsi, e funzionano solo se quelle parole compaiono *letteralmente* nel
 * testo già presente nel record. Non è interpretazione: è una corrispondenza
 * esatta, e la prova (il frammento trovato) finisce in `extractedFields`. Se il
 * testo non contiene nessuno di questi termini, il campo resta `null`.
 */
const LITERAL_ALLOWLIST = {
  board: [
    "all inclusive",
    "tutto incluso",
    "mezza pensione",
    "pensione completa",
    "full board",
    "half board",
    "breakfast",
    "colazione",
  ],
  transport: ["volo incluso", "volo incluso in", "aereo incluso", "trasporto incluso"],
  accommodation: ["hotel 4 stelle", "hotel 3 stelle", "hotel 5 stelle", "residence", "appartamenti"],
} as const;

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Data ISO in forma leggibile, senza fuso: `YYYY-MM-DD`. */
function isoDay(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Corrispondenza letterale dentro un testo già presente nel record.
 *
 * I confini sono quelli di parola veri, non quelli di uno spazio: in
 * "Hotel 4 stelle, all inclusive" il termine è seguito da una virgola, e un
 * confronto per spazi lo dichiarerebbe assente proprio quando c'è. Non è
 * interpretazione: è il termine per esteso, e la prova finisce in
 * `extractedFields`. Se il testo non contiene nessuno di questi termini, il
 * campo resta `null`.
 */
function literalIn(
  haystack: string,
  terms: readonly string[]
): { value: string; from: string } | null {
  const text = haystack.toLowerCase();
  for (const term of terms) {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
    if (re.test(text)) return { value: term, from: `"${term}"` };
  }
  return null;
}

/**
 * Confidenza dell'estrazione, calcolata solo da segnali reali.
 *
 * Senza dati commerciali è 0: dichiarare una confidenza media su un'estrazione
 * vuota nasconderebbe proprio il fatto che non è stato letto niente. Con dati
 * presenti resta sotto 0.9, perché in catalogo una verifica umana non è mai
 * saltata e `UNVERIFIED` resta il livello onesto.
 */
function computeConfidence(dto: CatalogProposalDto, fields: ExtractedField[]): number {
  if (fields.length === 0) return 0;
  // I tre livelli sono quelli dello schema (`CatalogConfidence`): VERIFIED per una
  // proposta verificata a mano, OCR_DRAFT per una bozza non ancora controllata,
  // UNVERIFIED per l'import di vetrina, che è il caso di questo catalogo.
  const base = dto.confidence === "VERIFIED" ? 0.75 : dto.confidence === "OCR_DRAFT" ? 0.5 : 0.3;
  // Ogni dato in più alza la confidenza ma con rendimenti decrescenti: il primo
  // campo dice "c'è un'estrazione", il terzo non dice "c'è un'offerta".
  const bonus = Math.min(0.15, fields.length * 0.05);
  return Math.round(Math.min(0.9, base + bonus) * 100) / 100;
}

/**
 * Estrae i dati commerciali di una proposta, ancorati alla sua locandina.
 *
 * La provenienza è la locandina della proposta: senza un'immagine non c'è una
 * locandina, e senza la locandina non c'è niente da cui aver estratto. La
 * funzione non genera e non stima: legge, e dove non trova scrive `null`.
 */
export function extractCommercial(dto: CatalogProposalDto): CommercialExtraction {
  const image = dto.officialImage;
  const commercial = dto.commercial;
  const fields: ExtractedField[] = [];
  const warnings: string[] = [];

  const add = (field: string, value: string | number | null, from: string, kind: ExtractedField["kind"] = "CATALOG_FIELD") => {
    if (value === null || value === undefined || value === "") return;
    fields.push({ field, value, from, kind });
  };

  // Prezzo: copia dei campi, senza arrotondare e senza scegliere un estremo.
  const priceFrom = isNum(commercial.priceFrom) ? commercial.priceFrom : null;
  const priceTo = isNum(commercial.priceTo) ? commercial.priceTo : null;
  add("price", priceFrom, "CatalogProposal.priceFrom");
  add("priceTo", priceTo, "CatalogProposal.priceTo");
  add("currency", clean(commercial.currency) || null, "CatalogProposal.currency");

  // Date: si prende il giorno, non l'orario, perché una locandina non ha orari.
  const departureDate = isoDay(commercial.periodStart);
  const returnDate = isoDay(commercial.periodEnd);
  add("departureDate", departureDate, "CatalogProposal.periodStart");
  add("returnDate", returnDate, "CatalogProposal.periodEnd");

  // Città di partenza: il catalogo la tiene in un campo testuale già pronto.
  const departureCity = clean(commercial.departureCities) || null;
  add("departureCity", departureCity, "CatalogProposal.departureCities");

  // Durata: dalle notti dichiarate, mai calcolata da date che potrebbero essere
  // parziali. Se le notti non ci sono ma le date sì, resta `null`: dedurre "7
  // notti" dalle date sarebbe un'inferenza, non un dato letto.
  const duration = isNum(commercial.durationNights) && commercial.durationNights > 0
    ? `${commercial.durationNights} ${commercial.durationNights === 1 ? "notte" : "notti"}`
    : null;
  add("duration", duration, "CatalogProposal.durationNights");

  // Accommodation / board / transport: nessuna colonna dedicata, quindi l'unica
  // fonte ammessa è una corrispondenza letterale nel testo già presente.
  const searchable = [clean(commercial.included), clean(commercial.excluded), clean(commercial.priceNote)]
    .filter(Boolean)
    .join(" \u00b7 ");
  const accommodation = searchable ? literalIn(searchable, LITERAL_ALLOWLIST.accommodation) : null;
  const board = searchable ? literalIn(searchable, LITERAL_ALLOWLIST.board) : null;
  const transport = searchable ? literalIn(searchable, LITERAL_ALLOWLIST.transport) : null;
  add("accommodation", accommodation?.value ?? null, accommodation?.from ?? "", accommodation ? "LITERAL_MATCH" : "CATALOG_FIELD");
  add("board", board?.value ?? null, board?.from ?? "", board ? "LITERAL_MATCH" : "CATALOG_FIELD");
  add("transport", transport?.value ?? null, transport?.from ?? "", transport ? "LITERAL_MATCH" : "CATALOG_FIELD");

  // Quello che manca diventa un warning, non un valore approssimato.
  if (priceFrom === null && priceTo === null) {
    warnings.push("prezzo non presente nella fonte: resta null, non viene stimato.");
  }
  if (departureDate === null) {
    warnings.push("data di partenza non presente nella fonte: resta null.");
  }
  if (duration === null) {
    warnings.push("durata non presente nella fonte: resta null, non viene calcolata dalle date.");
  }
  if (accommodation === null) {
    warnings.push("alloggiamento non presente nella fonte: resta null.");
  }
  if (board === null) {
    warnings.push("trattamento pasti non presente nella fonte: resta null.");
  }
  if (transport === null) {
    warnings.push("trasporto non presente nella fonte: resta null.");
  }
  if (dto.confidence === "UNVERIFIED") {
    warnings.push("proposta UNVERIFIED: i dati commerciali restano da verificare a mano.");
  }

  return {
    proposalId: dto.id,
    // La destinazione è il titolo stampato in grande sul fotogramma: qui non
    // può arrivare il marchio del distributore che l'ha pubblicata, altrimenti
    // la nostra creatività avrebbe il nome di un operatore di terzi in testa.
    destination: stripDistributorBranding(clean(dto.destination)),
    // Anche il titolo della proposta entra nel catalogo, nel DTO letto
    // dall'agente e nelle chiavi di deduplicazione: ripulito per lo stesso
    // motivo. `rawTitle` non esiste qui: la traccia di ciò che il sito
    // pubblicava resta in `CatalogProposal`.
    title: stripDistributorBranding(clean(dto.name)) ?? "",
    price: priceFrom,
    priceTo,
    currency: clean(commercial.currency) || null,
    departureCity,
    departureDate,
    returnDate,
    duration,
    accommodation: accommodation?.value ?? null,
    board: board?.value ?? null,
    transport: transport?.value ?? null,
    sourceImageUrl: image?.url ?? "",
    sourceImageId: image?.id ?? null,
    sourceImageFilename: image?.filename ?? null,
    extractionMethod: COMMERCIAL_EXTRACTION_METHOD,
    extractedFields: fields,
    confidence: computeConfidence(dto, fields),
    warnings,
  };
}

/**
 * Righe commerciali da stampare sulla creatività, nell'ordine in cui un lettore
 * le cerca: prima quanto costa, poi quando parte, poi da dove, poi cosa include.
 *
 * Una riga esiste solo se il dato esiste: non c'è un segnaposto ("prezzi su
 * richiesta") perché sarebbe un dato commerciale inventato travestito da testo.
 *
 * Soldi e date sono già in italiano: il prezzo è in euro ("890 €") e la
 * partenza è "12-19 Settembre". Non è una questione di stile, è il motivo per
 * cui il fotogramma si legge: "890 EUR" e "2026-09-12" sono come il catalogo
 * tiene i dati, non come un'offerta si annuncia a chi prenota. Le funzioni sono
 * in `commercial-format` perché la caption dei post e il fotogramma dicano lo
 * stesso numero nello stesso modo.
 */
export function commercialLines(extraction: CommercialExtraction): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];

  const price = formatPriceRange(extraction.price, extraction.priceTo, extraction.currency);
  if (price) lines.push({ label: "Prezzo", value: price });

  const dates = formatDateRange(extraction.departureDate, extraction.returnDate);
  if (dates) lines.push({ label: "Partenza", value: dates });

  if (extraction.duration) {
    lines.push({ label: "Durata", value: extraction.duration });
  }
  if (extraction.departureCity) {
    lines.push({ label: "Partenze da", value: extraction.departureCity });
  }
  if (extraction.accommodation) {
    lines.push({ label: "Alloggiamento", value: extraction.accommodation });
  }
  if (extraction.board) {
    lines.push({ label: "Pasti", value: extraction.board });
  }
  if (extraction.transport) {
    lines.push({ label: "Trasporto", value: extraction.transport });
  }
  return lines;
}
