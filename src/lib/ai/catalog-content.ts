/**
 * Dal Catalogo al post: format editoriale, direzione visual e copy.
 *
 * Regola che governa tutto il file: la copy può usare solo i dati realmente
 * presenti in `CatalogProposal`. Se un campo commerciale è null, il testo non
 * lo nomina e non lo stima: è preferibile un post povero di dati a un post
 * con un prezzo inventato. Per questo i format che descrivono un'offerta
 * (`OFFER`, `ITINERARY`, `FAQ`) sono ammessi solo quando gli dati ci sono.
 *
 * Niente chiamate al modello: la copy è deterministica ederivative dal
 * catalogo, quindi riproducibile e testabile. Il DRAFT resta una bozza da
 * rifinire a mano, ed è il modello a scegliere *quale* proposta promuovere.
 */

import type { CatalogProposalDto } from "@/lib/services/catalog-ai";
import { hashtagsFromTopic } from "@/lib/ai/content-copy";
import { normalizeForMatch } from "@/lib/catalog/text";

export const CONTENT_FORMATS = [
  "HERO_DESTINATION",
  "ITINERARY",
  "TRAVEL_TIPS",
  "STORYTELLING",
  "OFFER",
  "INSPIRATION",
  "FAQ",
] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** Requisiti di dato per ogni format: cosa deve esserci per poterlo scegliere. */
const FORMAT_REQUIREMENTS: Record<
  ContentFormat,
  { price?: boolean; dates?: boolean; anyCommercial?: boolean }
> = {
  // Tre format parlano della destinazione senza toccare dati commerciali.
  HERO_DESTINATION: {},
  STORYTELLING: {},
  INSPIRATION: {},
  TRAVEL_TIPS: {},
  // Questi descrivono un prodotto: senza dati reali racconterebbero fiction.
  ITINERARY: { dates: true },
  OFFER: { price: true, dates: true },
  FAQ: { anyCommercial: true },
};

export function hasPrice(dto: CatalogProposalDto): boolean {
  return dto.commercialFieldsPresent.some((f) => f === "priceFrom" || f === "priceTo");
}

export function hasDates(dto: CatalogProposalDto): boolean {
  return dto.commercialFieldsPresent.some(
    (f) => f === "periodStart" || f === "periodEnd" || f === "departureCities"
  );
}

export function hasAnyCommercial(dto: CatalogProposalDto): boolean {
  return dto.commercialFieldsPresent.length > 0;
}

/** Format ammessi su questa proposta, nell'ordine di dichiarazione. */
export function availableFormats(dto: CatalogProposalDto): ContentFormat[] {
  return CONTENT_FORMATS.filter((format) => {
    const need = FORMAT_REQUIREMENTS[format];
    if (need.price && !hasPrice(dto)) return false;
    if (need.dates && !hasDates(dto)) return false;
    if (need.anyCommercial && !hasAnyCommercial(dto)) return false;
    return true;
  });
}

/** Perché un format non è disponibile: entra nei warning del DRAFT. */
export function formatUnavailableReason(dto: CatalogProposalDto, format: ContentFormat): string {
  const need = FORMAT_REQUIREMENTS[format];
  if (need.price && !hasPrice(dto)) return "manca il prezzo nel catalogo";
  if (need.dates && !hasDates(dto)) return "mancano le date nel catalogo";
  if (need.anyCommercial && !hasAnyCommercial(dto)) {
    return "non ci sono dati commerciali nel catalogo";
  }
  return "";
}

/**
 * Scelta del format, deterministica.
 *
 * 1. se il modello ne chiede uno, si usa solo se i dati lo permettono;
 * 2. altrimenti si ruota tra i format disponibili con un hash dell'id della
 *    proposta: due post sulla stessa proposta non escono uguali, e la stessa
 *    proposta dà sempre lo stesso risultato.
 */
export function pickEditorialFormat(
  dto: CatalogProposalDto,
  requested?: ContentFormat | null
): { format: ContentFormat; warnings: string[] } {
  const available = availableFormats(dto);
  const warnings: string[] = [];
  const fallback = available[0] ?? "HERO_DESTINATION";

  if (requested && CONTENT_FORMATS.includes(requested)) {
    if (available.includes(requested)) return { format: requested, warnings };
    const reason = formatUnavailableReason(dto, requested);
    warnings.push(
      `format ${requested} non usabile (${reason}): scelto ${fallback} senza dati commerciali inventati.`
    );
    return { format: fallback, warnings };
  }
  if (requested) {
    warnings.push(`format "${requested}" sconosciuto: scelto ${fallback}.`);
  }

  const pool = available.filter((f) => f !== "OFFER");
  const target = pool.length > 0 ? pool : available;
  let hash = 0;
  for (let i = 0; i < dto.id.length; i += 1) hash = (hash + dto.id.charCodeAt(i)) % target.length;
  return { format: target[hash], warnings };
}

/** Il luogo su cui scrivere: la destinazione, o il nome se non è stata derivata. */
export function placeOf(dto: CatalogProposalDto): string {
  return dto.destination?.trim() || dto.name.trim();
}

function money(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function priceLabel(dto: CatalogProposalDto): string | null {
  const { priceFrom, priceTo, currency } = dto.commercial;
  const unit = currency?.trim() ? ` ${currency.trim()}` : "";
  if (isNum(priceFrom) && isNum(priceTo) && priceFrom !== priceTo) {
    return `da ${money(priceFrom!)}${unit} a ${money(priceTo!)}${unit}`;
  }
  if (isNum(priceFrom)) return `da ${money(priceFrom!)}${unit}`;
  if (isNum(priceTo)) return `fino a ${money(priceTo!)}${unit}`;
  return null;
}

function isNum(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function monthName(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("it-IT", { month: "long", year: "numeric" });
}

function datesLabel(dto: CatalogProposalDto): string | null {
  const from = monthName(dto.commercial.periodStart);
  const to = monthName(dto.commercial.periodEnd);
  if (from && to && from !== to) return `dal ${from} al ${to}`;
  if (from) return `dal ${from}`;
  return dto.commercial.departureCities?.trim() || null;
}

function durationLabel(dto: CatalogProposalDto): string | null {
  const nights = dto.commercial.durationNights;
  return isNum(nights) ? `${nights} notti` : null;
}

/** Fatti commerciali realmente presenti, in forma di frase. */
function commercialFacts(dto: CatalogProposalDto): string[] {
  const out: string[] = [];
  const price = priceLabel(dto);
  if (price) out.push(price);
  const dates = datesLabel(dto);
  if (dates) out.push(dates);
  const duration = durationLabel(dto);
  if (duration) out.push(duration);
  if (dto.commercial.included?.trim()) {
    out.push(`comprende: ${dto.commercial.included.trim()}`);
  }
  if (dto.commercial.excluded?.trim()) {
    out.push(`non comprende: ${dto.commercial.excluded.trim()}`);
  }
  return out;
}

const CTA = "Dettagli in agenzia.";

function joinFacts(facts: string[]): string {
  if (facts.length === 0) return "";
  const text = facts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export interface CatalogCopy {
  title: string;
  caption: string;
  hashtags: string;
  /** true se la caption contiene almeno un dato commerciale reale. */
  usesCommercialData: boolean;
}

/**
 * Copy derivata dalla proposta.
 *
 * Il titolo resta distinto dalla caption e nessuna parola commerciale compare
 * se il dato non c'è: è il test a garantire questo, non l'occhio.
 */
export function catalogCopyFromProposal(
  dto: CatalogProposalDto,
  format: ContentFormat
): CatalogCopy {
  const place = placeOf(dto);
  const facts = commercialFacts(dto);
  const factSentence = joinFacts(facts);
  const tail = factSentence ? `${factSentence} ${CTA}` : CTA;

  let title: string;
  let caption: string;

  switch (format) {
    case "HERO_DESTINATION":
      title = place;
      caption = `${place} è la protagonista di questa proposta. ${tail}`;
      break;
    case "STORYTELLING":
      title = `Un viaggio che parte da ${place}`;
      caption =
        `Tutto comincia da una scelta: ${place}. ` +
        `Un posto da tenere d'occhio per la prossima partenza. ${tail}`;
      break;
    case "INSPIRATION":
      title = `Il richiamo di ${place}`;
      caption =
        `A volte basta pensare a ${place} per rimettere in moto i desideri. ` +
        `Ecco cosa abbiamo in serbo per questa stagione. ${tail}`;
      break;
    case "TRAVEL_TIPS":
      title = `Prima di partire verso ${place}`;
      caption =
        `Tre domande da fare prima di scegliere ${place}: quando partire, ` +
        `da dove, e cosa portare. ${tail}`;
      break;
    case "ITINERARY":
      title = `${place}: ${datesLabel(dto) ?? "proposta"}`;
      caption =
        `${place}, ${datesLabel(dto) ?? "con partenza da definire"}. ` +
        `${dto.commercial.departureCities?.trim() ? `Partenze da ${dto.commercial.departureCities.trim()}. ` : ""}` +
        `${durationLabel(dto) ? `${durationLabel(dto)} in programma. ` : ""}${CTA}`;
      break;
    case "OFFER": {
      const price = priceLabel(dto) ?? "su richiesta";
      const dates = datesLabel(dto);
      title = `${place}: ${price}${dates ? ` · ${dates}` : ""}`;
      caption =
        `${place} è disponibile ${price}` +
        `${dates ? ` ${dates}` : ""}. ` +
        `${durationLabel(dto) ? `${durationLabel(dto)}.` : ""} ${CTA}`;
      break;
    }
    case "FAQ": {
      const lines: string[] = [];
      const price = priceLabel(dto);
      if (price) lines.push(`Quanto costa? ${price}.`);
      const dates = datesLabel(dto);
      if (dates) lines.push(`Quando? ${dates}.`);
      const duration = durationLabel(dto);
      if (duration) lines.push(`Quante notti? ${duration}.`);
      if (dto.commercial.included?.trim()) {
        lines.push(`Cosa comprende? ${dto.commercial.included.trim()}.`);
      }
      title = `${place}: le domande frequenti`;
      caption = `${lines.join(" ")} ${CTA}`;
      break;
    }
    default:
      title = place;
      caption = `${place} è la protagonista di questa proposta. ${CTA}`;
  }

  return {
    title,
    caption: caption.replace(/\s+/g, " ").trim(),
    hashtags: hashtagsFromTopic(place),
    usesCommercialData: facts.length > 0,
  };
}

export type VisualDirection = {
  format: ContentFormat;
  visualType: "OFFICIAL_IMAGE" | "GENERATED_HERO";
  concept: string;
  subject: string;
  composition: string;
  mood: string;
  textOverlay: { allowed: boolean; lines: string[] };
  useOfficialImage: boolean;
  officialImageUrl: string | null;
  officialImageFilename: string | null;
  /** Serve una generazione in futuro: qui non viene mai eseguita. */
  needsGeneration: boolean;
  /** Istruzione breve per il prossimo step (Magnific), null se basta l'originale. */
  generationBrief: string | null;
  groundedOn: {
    catalogProposalId: string;
    proposalName: string;
    destination: string | null;
    sourceUrl: string;
    sourceType: string;
  };
};

/**
 * Direzione visual strutturata: il contratto che userà la generazione immagini.
 *
 * Non è una stringa libera ("bella foto di X") ma campi distinti, così il
 * prossimo step può trasformarli in prompt senza reinterpretare il DRAFT. Se
 * esiste l'immagine ufficiale del catalogo la si riusa e non serve generare
 * nulla; altrimenti si registra un brief e `needsGeneration: true`, senza
 * chiamare mai Magnific adesso.
 */
export function buildVisualDirection(
  dto: CatalogProposalDto,
  format: ContentFormat
): VisualDirection {
  const place = placeOf(dto);
  const image = dto.officialImage;
  const anchored = {
    catalogProposalId: dto.id,
    proposalName: dto.name,
    destination: dto.destination,
    sourceUrl: dto.sourceUrl,
    sourceType: dto.sourceType,
  };

  const subjectByFormat: Record<ContentFormat, string> = {
    HERO_DESTINATION: `la destinazione ${place} in primo piano`,
    STORYTELLING: `un momento di viaggio che evoca ${place}`,
    INSPIRATION: `l'atmosfera di ${place} senza persone in primo piano`,
    TRAVEL_TIPS: `un dettaglio iconico di ${place}`,
    ITINERARY: `la sequenza di tappe di un viaggio a ${place}`,
    OFFER: `la destinazione ${place} con lo spazio per il testo dell'offerta`,
    FAQ: `un'immagine neutra di ${place} che lasci spazio alle domande`,
  };

  return {
    format,
    visualType: image ? "OFFICIAL_IMAGE" : "GENERATED_HERO",
    concept:
      format === "OFFER" || format === "ITINERARY" || format === "FAQ"
        ? `Comunicazione commerciale di ${place} con testo in evidenza`
        : `Immagine di viaggio centrata su ${place}, tono sobrio e aspirazionale`,
    subject: image ? `${subjectByFormat[format]} (ripresa dall'originale del catalogo)` : subjectByFormat[format],
    composition: image
      ? "1:1 o 4:5, soggetto in terzi, spazio in alto per il titolo, nessun ritaglio aggressivo"
      : "1:1 o 4:5, elemento in terzi, luce naturale, spazio negativo in alto",
    mood: "chiaro, luminoso, professionale, senza testo generico sovrapposto",
    textOverlay: { allowed: true, lines: [place] },
    useOfficialImage: image !== null,
    officialImageUrl: image?.url ?? null,
    officialImageFilename: image?.filename ?? null,
    needsGeneration: image === null,
    generationBrief: image
      ? null
      : `Immagine originale per un post su ${place} (${normalizeForMatch(format)}): ` +
        `${subjectByFormat[format]}, luce naturale, senza loghi, senza testo.`,
    groundedOn: anchored,
  };
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Prompt del visual: dalla direzione al testo per il generatore immagini
 * ──────────────────────────────────────────────────────────────────────── */

/** Limite del prompt: lo impone il provider immagini (Magnific: 1000 caratteri). */
export const MAX_VISUAL_PROMPT_LENGTH = 1000;

/**
 * Stile di casa: stringa fissa, non un dato della proposta.
 *
 * Vive qui e non dentro la `VisualDirection` perché non cambia mai e non deve
 * derivare da nulla: se dipendesse dalla proposta, lo stesso posto produrrebbe
 * due prompt diversi a seconda dei dati commerciali, e il prompt smetterebbe
 * di essere confrontabile.
 */
const VISUAL_PROMPT_STYLE =
  "fotografia di viaggio realistica, luce naturale, composizione professionale, " +
  "alta qualità, senza testo, loghi o filigrane";

/** Vincolo quando la proposta non ha né destinazione né nome utilizzabile. */
const NO_PLACE_CONSTRAINT =
  "La scena deve raffigurare ESCLUSIVAMENTE il luogo della proposta: non introdurre " +
  "altre destinazioni, città, regioni, isole, spiagge o monumenti. Non mostrare prezzi, " +
  "date, durate, servizi, hotel o altri dettagli commerciali.";

/**
 * Un campo del prompt, compattato e troncato alla sua quota.
 *
 * Il troncamento avviene qui, per campo, e non a fine prompt: così un nome
 * lunghissimo non può spingere fuori il limite la parte che garantisce che la
 * destinazione sia rispettata.
 */
function clampPromptPart(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Il vincolo di luogo, con la destinazione reale al centro. */
function placeConstraint(place: string): string {
  return (
    `La scena deve raffigurare ESCLUSIVAMENTE ${place}: non introdurre altre ` +
    "destinazioni, città, regioni, isole, spiagge o monumenti. Non mostrare prezzi, " +
    "date, durate, servizi, hotel o altri dettagli commerciali."
  );
}

/**
 * Prompt di generazione derivato dalla `VisualDirection`.
 *
 * È il punto in cui una direzione strutturata diventa il testo che il
 * generatore di immagini riceve. Le garanzie, in ordine:
 *
 *  - **Grounded**: entra solo ciò che è già nella direzione (nome, destinazione,
 *    concept, subject, composition, mood). Nessuna conoscenza esterna, nessun
 *    dato commerciale: la direzione non li contiene, quindi qui non compaiono.
 *  - **Non inventato**: il prompt vieta esplicitamente altre destinazioni e
 *    qualsiasi dettaglio commerciale, perché è il generatore a riempirlo da solo
 *    se gliene lascia lo spazio.
 *  - **Deterministico**: stesso input, stesso carattere per carattere. Niente
 *    date, niente locale, niente casualità.
 *  - **Entro il limite del provider**: le sezioni sacrificabili escono in ordine
 *    di priorità decrescente finché il prompt non rientra nel limite. Identità
 *    e vincolo di luogo non sono mai sacrificabili, e da soli stanno ampiamente
 *    sotto il limite: il troncamento finale è solo la rete di sicurezza.
 *
 * Nota: il prompt non viene usato quando la direzione ha `useOfficialImage`
 * (in quel caso si riusa la foto del catalogo). Chi decide è il chiamante.
 */
export function visualPromptFromDirection(direction: VisualDirection): string {
  const { groundedOn, format } = direction;

  const name = clampPromptPart(groundedOn.proposalName, 120);
  const destination = clampPromptPart(groundedOn.destination, 80);
  // La destinazione è l'unico riferimento geografico autorizzato; quando manca
  // si ripiega sul nome della proposta, che è comunque un dato reale.
  const place = destination || name;

  const identity = [
    name ? `Proposta di viaggio "${name}"` : null,
    destination && destination !== name ? `luogo: ${destination}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(", ");

  const sections: { text: string; required: boolean; priority: number }[] = [
    { text: identity, required: true, priority: 0 },
    { text: place ? placeConstraint(place) : NO_PLACE_CONSTRAINT, required: true, priority: 0 },
    { text: `Formato editoriale: ${clampPromptPart(format, 40)}`, required: false, priority: 5 },
    { text: clampPromptPart(direction.concept, 200), required: false, priority: 4 },
    { text: clampPromptPart(direction.subject, 240), required: false, priority: 3 },
    { text: clampPromptPart(direction.composition, 200), required: false, priority: 2 },
    { text: clampPromptPart(direction.mood, 160), required: false, priority: 1 },
    { text: VISUAL_PROMPT_STYLE, required: false, priority: 0 },
  ];

  const kept = sections.filter((s) => s.text.length > 0);
  const length = (): number => kept.map((s) => s.text).join(" ").length;

  while (length() > MAX_VISUAL_PROMPT_LENGTH) {
    const droppable = kept.filter((s) => !s.required);
    if (droppable.length === 0) break;
    const lowest = droppable.reduce((min, s) => (s.priority < min.priority ? s : min));
    kept.splice(kept.lastIndexOf(lowest), 1);
  }

  const prompt = kept.map((s) => s.text).join(" ");
  return prompt.length > MAX_VISUAL_PROMPT_LENGTH
    ? prompt.slice(0, MAX_VISUAL_PROMPT_LENGTH).trimEnd()
    : prompt;
}
