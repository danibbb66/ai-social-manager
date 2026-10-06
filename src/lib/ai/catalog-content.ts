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
import { formatDateRange, formatMoney, formatPriceRange } from "@/lib/catalog/commercial-format";
import { stripDistributorBranding } from "@/lib/catalog/distributor";
import { cleanPlaceName } from "@/lib/ai/place-name";
import {
  editorialCaption,
  editorialPoints,
  editorialTitle,
  isGenericTitle,
  titleNamesPlace,
  type EditorialFacts,
} from "@/lib/ai/editorial-matrix";
import { hasCuratedKnowledge, type KnowledgeSource } from "@/lib/ai/travel-knowledge";

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

/**
 * Il luogo su cui scrivere: la destinazione, o il nome se non è stata derivata.
 *
 * Entrambi vengono ripuliti dal formato editoriale. Anche nel catalogo il
 * `destination` può contenere la formula della richiesta, perché arriva da una
 * riga importata da un sito esterno: senza la pulizia il motore dei contenuti
 * cercava "Travel tips Formentera" nella base di conoscenza, non trovava nulla e
 * produceva un post povero su un posto che conosceva benissimo.
 *
 * La stessa riga che arriva da un sito esterno può portare dentro il nome del
 * distributore che ha costruito la locandina, e quel nome non è un luogo:
 * finirebbe nel titolo stampato sul fotogramma, nella ricerca della base di
 * conoscenza e nel prompt del generatore. Qui viene tolto, e se non rimane un
 * luogo utilizzabile la funzione restituisce la stringa vuota invece di un nome
 * che non è nostro.
 */
export function placeOf(dto: CatalogProposalDto): string {
  return cleanPlaceName(stripDistributorBranding(dto.destination) ?? "") ||
    cleanPlaceName(stripDistributorBranding(dto.name) ?? "") ||
    stripDistributorBranding(dto.destination?.trim()) ||
    "";
}

function priceLabel(dto: CatalogProposalDto): string | null {
  const { priceFrom, priceTo, currency } = dto.commercial;
  // L'intervallo ha due estremi e si legge "da … a …"; il prezzo singolo è un
  // numero solo. In entrambi i casi il numero è in italiano e con l'euro: è
  // `commercial-format` a scriverlo, lo stesso codice che stampa il fotogramma,
  // perché il dato del post e quello dell'immagine non possono divergere.
  if (isNum(priceFrom) && isNum(priceTo) && priceFrom !== priceTo) {
    return `da ${formatMoney(priceFrom, currency)} a ${formatMoney(priceTo, currency)}`;
  }
  const single = formatPriceRange(priceFrom, priceTo, currency);
  if (single === null) return null;
  return isNum(priceFrom) ? `da ${single}` : `fino a ${single}`;
}

function isNum(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function datesLabel(dto: CatalogProposalDto): string | null {
  // Stesse date del fotogramma, nella stessa lingua: "dal 12-19 Settembre" e
  // non "dal 2026-09-12 al 2026-09-27". Se manca la fine dell'intervallo si
  // stampa la sola partenza, che è un dato vero e non un'approssimazione.
  const { periodStart, periodEnd } = dto.commercial;
  const dates = formatDateRange(periodStart, periodEnd);
  if (dates) return `dal ${dates}`;
  return dto.commercial.departureCities?.trim() || null;
}

function durationLabel(dto: CatalogProposalDto): string | null {
  const nights = dto.commercial.durationNights;
  return isNum(nights) ? `${nights} notti` : null;
}

/**
 * I dati del catalogo nella forma neutra che la matrice editoriale capisce.
 *
 * È il ponte fra il DTO e la matrice: qui i campi diventano frasi leggibili
 * (`da 890 € a 1.290 €`, `5 notti`), là dentro diventano righe di consigli,
 * tappe o risposte. Un dato assente resta `null` e la matrice non lo
 * rimpiazza: è la stessa promessa che faceva il codice precedente, applicata a
 * sette formati invece che a tre.
 */
function factsFrom(dto: CatalogProposalDto): EditorialFacts {
  const nights = dto.commercial.durationNights;
  return {
    price: priceLabel(dto),
    dates: datesLabel(dto),
    duration: durationLabel(dto),
    nights: isNum(nights) ? nights : null,
    departureCities: dto.commercial.departureCities?.trim() || null,
    included: dto.commercial.included?.trim() || null,
    excluded: dto.commercial.excluded?.trim() || null,
  };
}

export interface CatalogCopy {
  title: string;
  caption: string;
  hashtags: string;
  /** true se la caption contiene almeno un dato commerciale reale. */
  usesCommercialData: boolean;
  /**
   * Consigli o tappe da stampare dentro il fotogramma.
   *
   * Sono le stesse righe che la caption mette a lista, non una versione
   * parallela: il fotogramma e il testo devono dire la stessa cosa, altrimenti
   * uno dei due mente. Vuoto per i formati che non stampano punti (hero,
   * offerta, FAQ, ispirazione, racconto), dove il contenuto del fotogramma è
   * già altro.
   */
  points: string[];
  /**
   * Da dove viene il contenuto dei punti.
   *
   * `curated` = conoscenza reale della destinazione; `derived` = costruito sui
   * dati del catalogo e sulla struttura del viaggio. Va nei warning del DRAFT,
   * dove serve al team e non all'utente, che sul post legge solo i punti.
   */
  knowledgeSource: KnowledgeSource;
}

/**
 * Copy derivata dalla proposta, con la matrice editoriale.
 *
 * Il titolo e la caption non sono più scritti qui: sono delegati a
 * `editorialTitle` ed `editorialCaption`, che garantiscono che il titolo nomini
 * sempre la destinazione e che la caption abbia la struttura del formato. Qui il
 * DTO viene tradotto nei dati che la matrice capisce, e il resto è aritmetica
 * sul risultato.
 *
 * Una sola difesa resta qui e non nella matrice: se il titolo prodotto non
 * nomina il luogo, o è una formula generica, viene sostituito con il nome del
 * luogo. È il punto in cui la regola diventa vera anche se un formato futuro
 * sbaglia, ed è testato come tale.
 */
export function catalogCopyFromProposal(
  dto: CatalogProposalDto,
  format: ContentFormat
): CatalogCopy {
  const place = placeOf(dto);
  const facts = factsFrom(dto);

  let title = editorialTitle(format, place, facts);
  if (!titleNamesPlace(title, place) || isGenericTitle(title)) title = place;

  // I punti del fotogramma e le righe della lista vengono dalla stessa funzione:
  // è l'unico modo perché ciò che si vede sull'immagine e ciò che si legge sotto
  // non possano divergere. E la provenienza dichiara se quei punti sono fatti
  // sulla destinazione o soltanto dati del catalogo.
  const points = editorialPoints(format, place, facts);

  return {
    title,
    // Gli spazi bianchi si normalizzano, ma i a capo no: sono ciò che rende
    // una lista di consigli una lista invece di una frase lunga. Collassarli
    // trasformerebbe il post da strutturato a corridoio.
    caption: normalizeCaption(editorialCaption(format, place, facts)),
    hashtags: hashtagsFromTopic(place),
    usesCommercialData: Object.values(facts).some((value) => value !== null),
    points,
    knowledgeSource: hasCuratedKnowledge(place) ? "curated" : "derived",
  };
}

/** Normalizza gli spazi bianchi riga per riga, conservando i ritorni a capo. */
function normalizeCaption(caption: string): string {
  return caption
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/**
 * Provenienza di un blocco di contenuto dentro la creatività.
 *
 * Serve a rendere osservabile, sulla direzione stessa, *chi* ha portato ogni
 * pezzo: i dati commerciali vengono dalla locandina, la foto dal generatore, il
 * brand dal template dell'agenzia, la copy dal flusso editoriale. Un renderer
 * che mescolasse le quattro senza dirlo produrrebbe immagini in cui non si sa
 * quale parte sia un dato e quale sia una decorazione.
 */
export type CreativeLayerOrigin = "FLYER" | "MAGNIFIC" | "BRAND" | "COPY";

export type CreativeLayer = {
  origin: CreativeLayerOrigin;
  /** Righe già pronte per il renderer. Vuoto = quel blocco non ha dati reali. */
  lines: string[];
  /** Origine puntuale (URL, id, prompt): ciò che rende il blocco verificabile. */
  detail: string | null;
};

/**
 * I quattro strati della creatività, tenuti separati.
 *
 * `commercial` è l'unico che può contenere prezzo, date o servizi, e arriva
 * dalla locandina. Gli altri tre non portano mai un dato commerciale: è la
 * garanzia che il generatore fotografo non riceva (e non inventi) un'offerta.
 */
export type CreativeLayers = {
  commercial: CreativeLayer;
  photo: CreativeLayer;
  brand: CreativeLayer;
  copy: CreativeLayer;
};

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
  /**
   * Presente solo nei flussi che separano la creatività per provenienza (il
   * verticale locandina → fotografia → social). `buildVisualDirection` non lo
   * valorizza: aggiungerlo qui non cambia il comportamento di nessun flusso
   * esistente, dà solo un posto dove dichiarare da dove viene ogni strato.
   */
  layers?: CreativeLayers;
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
    // Per i consigli il soggetto non è il luogo: è un dettaglio che si guarda,
    // non uno sfondo da contemplare. È la differenza visiva tra "Maldive" come
    // vetrina e "Maldive" come consiglio, e senza di essa la rubrica stampata
    // sopra il titolo prometterebbe informazione su un'immagine da cartolina.
    TRAVEL_TIPS: `un dettaglio ravvicinato e osservabile di ${place}, inquadratura da guida pratica, luce che fa leggere il soggetto`,
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
