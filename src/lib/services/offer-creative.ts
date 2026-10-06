/**
 * Creatività sociale a partire da un'offerta di catalogo.
 *
 * È il proprietario unico di "che cosa finisce sul fotogramma di un post nato
 * da una proposta di catalogo", e vale per ogni percorso che arriva a una
 * locandina di fornitore (`materializeCatalogVisual` e il verticale locandina).
 *
 * ## La regola
 *
 * Un post non è mai l'immagine del fornitore. La locandina è materiale
 * promozionale di terzi: contiene il logo, il marchio e la grafica di chi ha
 * costruito l'offerta, e pubblicarla come post dell'agenzia metterebbe in
 * circolo un'immagine che non è nostra e un marchio che non è il nostro.
 *
 * Quindi il file del fornitore non viene mai usato come sfondo, non viene
 * ritagliato e non viene allegato al contenuto. Serve a una cosa sola: sapere
 * da dove arrivano i dati dell'offerta, e resta in Media Library con
 * `contentId` nullo e il ruolo di provenienza.
 *
 * ## Che cosa finisce invece sul post
 *
 *  1. una **fotografia generata** dal provider immagini, costruita sul tema
 *     della destinazione e senza alcun dato commerciale nel prompt;
 *  2. il **template social dell'agenzia** (`social-creative-v1`) composto
 *     sopra quella fotografia;
 *  3. il **marchio dell'agenzia**: il logo configurato in `Brand.logoUrl` o,
 *     in sua assenza, il wordmark con `Brand.name`;
 *  4. i **dati dell'offerta** realmente presenti nella fonte, stampati dal
 *     template: un campo assente non viene riempito con un segnaposto.
 *
 * La fotografia è generata ad alta risoluzione (`2k`) per un motivo pratico: il
 * template ritaglia a 1080 px con `cover`, quindi una foto generata a `1k`
 * arrive già al limite e un ritaglio ravvicinato la sfoca. Costa di più di un
 * `1k` e non costa nulla di fronte a un post illeggibile.
 */

import { renderSocialCreative, SOCIAL_CREATIVE_SIZE, type RenderedSocialCreative } from "@/lib/images/social-creative";
import { saveUploadedFile } from "@/lib/uploads";
import { placeNameFrom } from "@/lib/ai/content-stock";
import type { CommercialExtraction } from "@/lib/catalog/commercial-extraction";
import type { VisualDirection } from "@/lib/ai/catalog-content";
import { kickerForFormat } from "@/lib/ai/format-kicker";
import type { BrandMark } from "@/lib/services/brand";

/** Origine dell'asset che è il visuale del post: la nostra creatività. */
export const OFFER_CREATIVE_ORIGIN = "offer-social-creative" as const;

/**
 * Origine dell'asset che è l'originale del fornitore.
 *
 * Stessa stringa del verticale locandina, dichiarata una volta sola: due
 * costanti diverse con lo stesso valore farebbero passare una provenienza
 * sfuggita a un controllo sull'altra. Vale soprattutto perché questa origine è
 * ciò che tiene gli originali del fornitore fuori dai visual dei post generici.
 */
export const OFFER_SOURCE_ORIGIN = "catalog-flyer-source" as const;

/** Ruolo dell'originale del fornitore dentro i suoi metadata. */
export const OFFER_SOURCE_ROLE = "SOURCE_FLYER" as const;

/** Layout applicato al fotogramma: lo stesso degli altri post. */
export const OFFER_CREATIVE_TEMPLATE = "social-creative-v1" as const;

/** Formato del generatore: quadrato, la sposta sicura di questo progetto. */
export const OFFER_PHOTO_ASPECT_RATIO = "square_1_1";

/** Risoluzione del generatore: alta, per il ritaglio a 1080 del template. */
export const OFFER_PHOTO_RESOLUTION = "2k" as const;

/** Limite del prompt: lo impone il provider (Magnific: 1000 caratteri). */
export const MAX_OFFER_PHOTO_PROMPT = 1000;

/**
 * Questo asset è un originale del fornitore, e per questo non può diventare il
 * visuale di un post.
 *
 * È il controllo che chiude l'unico modo in cui la grafica di un fornitore
 * arriverebbe su un post generico: la ricerca in Media Library (`findLocalStock`)
 * sfoglia gli asset liberi e li cerca per nome e metadati, e la locandina di una
 * proposta contiene quasi sempre il nome della destinazione. Senza questo
 * controllo, un post "su Creta" avrebbe come sfondo la locandina Creta del
 * fornitore, con il suo logo e la sua grafica sotto il nostro titolo.
 *
 * Si basa sull'origine dichiarata nei metadata, non sul nome del file: il nome
 * lo cambia `saveUploadedFile` e non dice nulla di che cosa sia l'immagine.
 */
export function isSupplierOriginal(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const m = metadata as Record<string, unknown>;
  return m.origin === OFFER_SOURCE_ORIGIN || m.role === OFFER_SOURCE_ROLE;
}

/**
 * Prompt fotografico: solo fotografia.
 *
 * È l'unico prompt che il provider immagini riceve per un post da offerta, ed
 * è costruito qui invece di riusato da `visualPromptFromDirection` per una
 * ragione precisa: quel prompt descrive il visuale di un post generico e include
 * il formato editoriale e l'uso dell'originale del catalogo, che qui non
 * esistono. Qui entrano il luogo, il soggetto, la composizione e l'umore, più
 * l'elenco esplicito di ciò che il generatore non deve mai introdurre.
 *
 * I dati commerciali non sono "esclusi a parole": non sono presenti nel testo,
 * quindi non possono esserci dentro. Il prezzo e le date finiscono sull'overlay,
 * che è un altro strato e un'altra immagine.
 */
export function offerPhotoPrompt(direction: VisualDirection): string {
  const { groundedOn } = direction;
  const place = (groundedOn.destination || groundedOn.proposalName || "").replace(/\s+/g, " ").trim();

  const parts = [
    place ? `Luogo: ${place}.` : null,
    direction.subject,
    direction.composition,
    direction.mood,
    "Fotografia di viaggio realistica, luce naturale, alta qualità.",
    place
      ? `La scena deve raffigurare ESCLUSIVAMENTE ${place}: non introdurre altre ` +
        "destinazioni, città, regioni, isole, spiagge o monumenti."
      : "La scena deve raffigurare il luogo della proposta di viaggio.",
    // Il divieto è formulato senza nominare le categorie commerciali. Scrivere
    // "nessun prezzo, nessuna data, nessun hotel" metterebbe quelle parole nel
    // prompt, cioè le consegnerebbe al generatore: il vincolo utile è "solo
    // fotografia", e i dati commerciali restano fuori dal prompt a monte.
    //
    // "Di terzi" è la parte che non si può togliere: la locandina di partenza è
    // grafica promozionale di un operatore, e un generatore che riceve "nessun
    // logo" può comunque ricostruire un marchio plausibile o una filigrana con
    // un nome. Sul post dell'agenzia non deve comparire niente che venga da
    // fuori: il marchio è il nostro e lo stampa il template.
    "Nessun testo, nessun logo, nessun marchio, nessuna filigrana, nessun " +
      "elemento grafico o commerciale: solo fotografia del luogo, senza " +
      "riferimenti a terzi.",
  ].filter((p): p is string => Boolean(p && p.trim().length > 0));

  const prompt = parts.join(" ");
  return prompt.length > MAX_OFFER_PHOTO_PROMPT
    ? prompt.slice(0, MAX_OFFER_PHOTO_PROMPT).trimEnd()
    : prompt;
}

/**
 * Direzione per il prompt fotografico, con la provenienza ripulita.
 *
 * `buildVisualDirection` dice "uso l'immagine ufficiale del catalogo" perché
 * nella sua formulazione il visuale è la foto del catalogo. Qui non è vero: di
 * quell'immagine si usa solo la provenienza dei dati, e il visuale è una
 * fotografia generata e composta. Senza questo allineamento il prompt
 * arriverebbe al generatore con un "ripresa dall'originale del catalogo" che qui
 * è falso, e la direzione dichiarata nei metadati contraddirrebbe l'immagine
 * prodotta.
 */
export function photoDirectionFrom(direction: VisualDirection): VisualDirection {
  return {
    ...direction,
    // Il soggetto dice "ripresa dall'originale del catalogo" quando la
    // direzione era nata per usare la locandina. Qui l'originale non è il
    // visuale, quindi quel testo mentirebbe al generatore: gli si chiederebbe
    // una ripresa di un file che non riceverà mai.
    subject: direction.subject.replace(
      /\s*\(ripresa dall'originale del catalogo\)/gi,
      ""
    ),
    useOfficialImage: false,
    officialImageUrl: null,
    officialImageFilename: null,
  };
}

/**
 * Il titolo da stampare sul fotogramma: il nome pulito del luogo.
 *
 * Non è il titolo del DRAFT e non è il nome della proposta: entrambi sono
 * stringhe editoriali che portano con sé formule generiche ("... - proposta di
 * viaggio") che sul post diventano rumido. Vuoto significa che non c'è un nome
 * utilizzabile, e il chiamante deve allora non comporre nulla.
 */
export function printedTitleFrom(extraction: CommercialExtraction): string {
  return placeNameFrom(extraction.destination, null, extraction.title);
}

/**
 * Compone il fotogramma e lo mette a terra.
 *
 * Il file finale è questo e non altro: la fotografia del provider con sopra il
 * template dell'agenzia, il suo marchio e i dati dell'offerta. Il risultato
 * dichiara il titolo stampato e il marchio usato, perché un post con il logo e
 * un post con il wordmark, o un post senza titolo, non sono la stessa
 * creatività.
 */
export async function composeOfferCreative(input: {
  photo: Buffer;
  extraction: CommercialExtraction;
  mark: BrandMark | null;
  title: string;
  /** Formato editoriale: decide la rubrica stampata sopra il titolo. */
  format?: string | null;
  /**
   * Consigli o tappe stampati dentro la card.
   *
   * Vengono dalla stessa funzione che produce le righe della caption, quindi il
   * fotogramma e il testo dicono la stessa cosa. Vuoto per i formati che non
   * hanno punti da mostrare, e in quel caso il fotogramma resta com'è.
   */
  points?: readonly string[] | null;
}): Promise<{
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  rendered: RenderedSocialCreative;
}> {
  const rendered = await renderSocialCreative({
    photo: input.photo,
    title: input.title,
    // Nessun sottotitolo: sul post il titolo è il luogo e il resto lo dice la
    // fascia dei dati. Un sottotitolo qui porterebbe il nome della proposta,
    // cioè la formula generica che il titolo si è appena liberato di.
    subtitle: null,
    // La rubrica dichiara di che post si tratta: senza, un post di consigli
    // porterebbe lo stesso titolo e lo stesso aspetto di un hero sul luogo.
    kicker: kickerForFormat(input.format),
    // I punti dentro la card: per TRAVEL_TIPS e ITINERARY la promessa del post
    // sono i consigli e le tappe, e una promessa che sta solo nella caption non
    // si vede nel feed.
    points: input.points ?? null,
    extraction: input.extraction,
    brandLogo: input.mark?.kind === "logo" ? input.mark : null,
    brandName: input.mark?.kind === "wordmark" ? input.mark.name : null,
  });

  const saved = await saveUploadedFile({
    buffer: rendered.buffer,
    originalName: rendered.filename,
    mimeType: rendered.mimeType,
  });

  return {
    url: saved.url,
    filename: rendered.filename,
    mimeType: rendered.mimeType,
    size: saved.size,
    rendered,
  };
}

/** Lato della creatività, riesposto: chi compone deve conoscerlo. */
export { SOCIAL_CREATIVE_SIZE };
