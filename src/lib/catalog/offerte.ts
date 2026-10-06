/**
 * Lettura della pagina pubblica `/offerte/` dell'agenzia.
 *
 * FONTE DI LIVELLO "PRESENTAZIONE": la pagina non espone dati commerciali.
 * Per ogni card ricaviamo solo ciò che il sito dichiara davvero:
 *   - `data-title` → nome della proposta (l'unico dato testuale reale);
 *   - `href`       → l'immagine ORIGINALE della locandina.
 *
 * Prezzi, date, durata, hotel, trattamento, servizi e operatori NON vengono
 * dedotti né stimati: restano nulli. Nessuna associazione titolo→immagine
 * viene "corretta": ciò che il sito pubblica viene registrato come sta e le
 * incoerenze vengono segnalate come anomalie per la revisione umana.
 *
 * ## Il nome del distributore non viene importato
 *
 * Le locandine sono materiale promozionale di terzi e il titolo ne porta spesso
 * il marchio. Quel nome viene tolto prima di diventare nome della proposta o
 * destinazione, perché da lì arriverebbe sul fotogramma di un post
 * dell'agenzia. La rimozione è conservativa: un titolo pulito resta identico,
 * e un titolo fatto solo di un marchio diventa un segnaposto dichiarato con la
 * destinazione `null`, da segnalare e non da inventare.
 */

import { stripDistributorBranding } from "@/lib/catalog/distributor";

/** Pagina sorgente del catalogo pubblico. */
export const OFFERTE_PAGE_URL = "https://www.mrhromaboccea.it/offerte/";

/**
 * Identifica il crawler in modo trasparente. `robots.txt` del sito consente
 * `/offerte/` (l'unico path escluso è `/wp-admin/`).
 */
export const CRAWLER_USER_AGENT =
  "Mozilla/5.0 (compatible; SocialManagerCatalogBot/1.0; +catalogo interno agenzia)";

/** Timeout della richiesta HTTP: oltre, l'import fallisce invece di pendere. */
const FETCH_TIMEOUT_MS = 20_000;

/** Una card letta dalla pagina, ancora non persistita. */
export interface OfferteCard {
  /** `data-title` verbatim, ripulito. Fallback sul nome file se assente. */
  name: string;
  /** `data-title` grezzo: serve a distinguere "titolo assente" da "titolo vuoto". */
  rawTitle: string | null;
  /** URL assoluto dell'immagine originale. */
  imageUrl: string;
  /** Nome file dell'immagine. */
  filename: string;
  /** Posizione della card nella pagina (0-based). */
  order: number;
  /** Destinazione derivata dal titolo, quando è ricavabile senza indovinare. */
  destination: string | null;
  /**
   * `true` quando il titolo pubblicato conteneva il nome di un distributore o
   * di un operatore ed è stato ripulito prima di diventare nome della proposta.
   *
   * Non è un errore: è una dichiarazione. Il marchio di terzi non entra nel
   * catalogo né nei post, e chi rivede le proposte sa che quel titolo ne
   * conteneva uno invece di credere che l'agenzia lo abbia scritto così.
   */
  brandingRemoved?: boolean;
}

export type CatalogAnomalyCode =
  | "MISSING_TITLE"
  | "SHARED_IMAGE"
  | "PLACEHOLDER_TITLE"
  | "TITLE_IMAGE_MISMATCH"
  | "DESTINATION_MISSING"
  | "DISTRIBUTOR_BRAND"
  | "NOT_ON_SITE";

export interface CatalogAnomaly {
  code: CatalogAnomalyCode;
  label: string;
  detail: string;
}

const ANOMALY_LABELS: Record<CatalogAnomalyCode, string> = {
  MISSING_TITLE: "Titolo assente",
  SHARED_IMAGE: "Immagine condivisa",
  PLACEHOLDER_TITLE: "Titolo segnaposto",
  TITLE_IMAGE_MISMATCH: "Titolo e immagine discordi",
  DESTINATION_MISSING: "Destinazione mancante",
  DISTRIBUTOR_BRAND: "Marchio del distributore rimosso",
  NOT_ON_SITE: "Non più sul sito",
};

/** Costruisce un'anomalia con etichetta e dettaglio leggibili in UI. */
export function anomaly(
  code: CatalogAnomalyCode,
  detail: string
): CatalogAnomaly {
  return { code, label: ANOMALY_LABELS[code], detail };
}

/**
 * Parole che descrivono TIPOLOGIA o OCCASIONE, non una destinazione.
 * Se il titolo ne contiene una, non è ragionevole trattarlo come luogo:
 * in quel caso la destinazione resta nulla e la proposta va rivista.
 */
const NON_DESTINATION_TOKENS = [
  "city break",
  "capodanno",
  "natale",
  "immacolata",
  "epifania",
  "festivit",
  "speciale",
  "promozionale",
  "tour",
  "libert",
  "classico",
  "dreaming",
  "fantasia",
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

/** Titolet(i) segnaposto pubblicati dall'agenzia (locandine non identificate). */
const PLACEHOLDER_PATTERN = /nuova\s+locandina/i;

/**
 * Il markup della pagina non è stabile.
 *
 * Verificato sul sito reale: la classe delle card è `locandina-link`
 * ("locandina" = volantino in italiano), mentre il marker del grid è
 * `.locandina-grid`; in una precedente revisione della stessa pagina le
 * classi erano scritte `locandine-*` e gli attributi erano su una riga sola.
 * L'agenzia modifica la pagina quindi il parser non può basarsi su un singolo
 * nome di classe: qui si accettano entrambe le grafie e, in assenza della
 * classe, si riconosce la card dalla combinazione `data-title` + immagine.
 */
const GRID_MARKER = /locandin[ae]-grid/i;
const CARD_CLASS = /^locandin[ae]-/i;
const IMAGE_EXTENSION = /\.(webp|jpe?g|png|gif|avif)$/i;

/** True se l'URL punta a un file immagine (le card linkano la locandina). */
export function isImageUrl(url: string): boolean {
  return IMAGE_EXTENSION.test(url.split(/[?#]/)[0]);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  igrave: "ì",
  icirc: "î",
  ograve: "ò",
  ocirc: "ô",
  ugrave: "ù",
  ucirc: "û",
  ccedil: "ç",
  ntilde: "ñ",
};

/** Decodifica le entità HTML presenti nei `data-title` (es. `&agrave;`). */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Risolve un href (assoluto o relativo) rispetto alla pagina sorgente. */
export function resolveUrl(href: string, baseUrl: string): string | null {
  const raw = decodeEntities(href).trim();
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Nome file da un URL, con query string già esclusa. */
export function filenameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  const parts = withoutQuery.split("/");
  return parts[parts.length - 1] || withoutQuery;
}

/**
 * Il titolo è un segnaposto dichiarato dall'agenzia: non descrive una
 * destinazione e non va usato come nome di proposta.
 */
export function isPlaceholderTitle(name: string): boolean {
  return PLACEHOLDER_PATTERN.test(name);
}

/**
 * Il titolo ripulito dal nome del distributore che vi era attaccato.
 *
 * La pagina dell'agenzia ri-pubblica locandine di terzi e il titolo ne porta
 * spesso il marchio: "Veratour - Rodi", "Rodi con Bravifondo". Quel nome non è
 * un luogo, e una destinazione derivata da lì finirebbe stampata sul
 * fotogramma di un post dell'agenzia, con dentro il nome di chi non siamo.
 *
 * La rimozione è dichiarata e conservativa: se il titolo è pulito resta
 * identico, e se non rimane più nulla la destinazione resta `null` e la
 * card viene segnalata come anomala, non riparata con un nome inventato.
 */
function stripBranding(name: string): string {
  return stripDistributorBranding(name) ?? "";
}

/**
 * Destinazione ricavata dal titolo, con la regola più conservativa possibile.
 *
 *  - "Rodi da Milano e Roma" → "Rodi"   (la parte dopo "da" è la città di partenza)
 *  - "Cipro"                → "Cipro" (titolo senza qualificatori: è il luogo)
 *  - "Thailandia Libertà Capodanno" → null (contiene tipologia/occasione)
 *
 * Non viene mai "corretto" oltre questo: tutto ciò che non è ricavabile resta
 * null e viene segnalato come anomalia.
 */
export function deriveDestination(name: string): string | null {
  const branded = stripBranding(name);
  const title = branded.trim();
  if (!title) return null;
  if (isPlaceholderTitle(branded)) return null;

  const departure = title.match(/^(.+?)\s+da\s+\S+/i);
  if (departure) {
    const place = departure[1].trim();
    return place.length > 0 ? place : null;
  }

  const lower = title.toLowerCase();
  if (NON_DESTINATION_TOKENS.some((token) => lower.includes(token))) return null;

  return title;
}

/** Token alfanumerici normalizzati (accenti rimossi, maiuscoli). */
function normalizeTokens(input: string): string[] {
  return input
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Indica se il nome file dell'immagine contiene la destinazione.
 *
 * Serve a rendere visibile il caso in cui il sito abbina un titolo a
 * un'immagine che parla di un'altra destinazione (es. "Mauritius da Milano
 * e Roma" con `NEW-YORK-MIL-E-ROM-30-DEC.webp`). Non corregge nulla:
 * segnala e basta.
 */
export function titleMatchesImage(
  destination: string | null,
  filename: string
): boolean {
  if (!destination) return true; // niente da confrontare: non è un errore
  const fileTokens = normalizeTokens(filename);
  return normalizeTokens(destination).some((token) => {
    if (token.length < 3) return false;
    return fileTokens.some(
      (fileToken) =>
        fileToken === token ||
        (fileToken.length >= 3 && token.startsWith(fileToken))
    );
  });
}

function attribute(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = tag.match(re);
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}

/**
 * Estrae le card del grid delle locandine da un HTML già scaricato.
 *
 * Riconosce una card se l'ancora ha una classe `locandina-*`/`locandine-*`
 * oppure, in mancanza, se ha un `data-title` e punta a un'immagine.
 * L'ordine degli attributi e i ritorni a capo nel tag non contano.
 *
 * Se il marker del grid non è presente restituisce un array vuoto: è il
 * segnale che il layout della pagina è cambiato e che l'import NON deve
 * procedere (il chiamante deve fallire invece di marcare tutto come
 * "non più sul sito").
 */
export function parseLocandineCards(
  html: string,
  pageUrl: string = OFFERTE_PAGE_URL
): OfferteCard[] {
  if (!html || !GRID_MARKER.test(html)) return [];

  const cards: OfferteCard[] = [];
  const anchors = html.matchAll(/<a\b([^>]*)>/gi);
  let order = 0;

  for (const match of anchors) {
    const tag = match[1];
    const classAttr = attribute(tag, "class") ?? "";
    const classes = classAttr.split(/\s+/);
    const rawTitle = attribute(tag, "data-title");

    const href = attribute(tag, "href");
    const imageUrl = href ? resolveUrl(href, pageUrl) : null;
    if (!imageUrl || !isImageUrl(imageUrl)) continue;

    const hasCardClass = classes.some((token) => CARD_CLASS.test(token));
    if (!hasCardClass && rawTitle === null) continue;

    const title = rawTitle ? decodeEntities(rawTitle).trim() : "";
    const filename = filenameFromUrl(imageUrl);
    // Il nome della proposta non porta il marchio del distributore: quel nome
    // finirebbe nell'elenco, nel titolo del post e sul fotogramma, e su un post
    // dell'agenzia non ci deve essere. Il titolo ripulito è anche ciò che
    // `deriveDestination` usa, quindi il nome non viene più derivato da un
    // testo che contiene già un nome di terzi.
    //
    // Se dalla rimozione non resta nulla — un titolo fatto solo di un marchio —
    // il nome diventa un segnaposto dichiarato e la destinazione resta `null`:
    // la card viene segnalata per la revisione umana, non riparata con un nome
    // inventato.
    const published = title || filename.replace(/\.[a-z0-9]+$/i, "");
    const name = stripBranding(published);
    // La destinazione si deriva SOLO da un titolo realmente pubblicato: il
    // nome file è un'etichetta tecnica e sbaglia (vedi Mauritius/New York).
    const hasTitle = title.length > 0;

    cards.push({
      name: name || `Proposta ${order + 1}`,
      rawTitle: rawTitle === null ? null : title,
      imageUrl,
      filename,
      order,
      destination: hasTitle ? deriveDestination(published) : null,
      brandingRemoved: name !== published && name.length > 0,
    });
    order += 1;
  }

  return cards;
}

/**
 * Anomalie calcolate sulle card lette, senza scrivere nulla.
 * `SHARED_IMAGE` richiede il confronto tra tutte le card, quindi viene
 * risolto qui e non durante il parsing.
 */
export function detectCardAnomalies(cards: OfferteCard[]): Map<number, CatalogAnomaly[]> {
  const byImage = new Map<string, OfferteCard[]>();
  for (const card of cards) {
    const list = byImage.get(card.imageUrl) ?? [];
    list.push(card);
    byImage.set(card.imageUrl, list);
  }

  const result = new Map<number, CatalogAnomaly[]>();

  for (const card of cards) {
    const found: CatalogAnomaly[] = [];

    if (card.rawTitle === null || card.rawTitle.length === 0) {
      found.push(
        anomaly(
          "MISSING_TITLE",
          `Nessun data-title: nome ricavato dal file "${card.filename}".`
        )
      );
    }

    if (card.brandingRemoved) {
      // La rimozione è silenziosa solo per l'utente, non per chi rivede il
      // catalogo: il titolo pubblicato conteneva il marchio di un
      // distributore, e quel nome non entra né nel catalogo né nei post.
      found.push(
        anomaly(
          "DISTRIBUTOR_BRAND",
          `Dal titolo pubblicato "${card.rawTitle ?? card.name}" è stato tolto ` +
            `il marchio di un distributore: la proposta si chiama "${card.name}".`
        )
      );
    }

    // La parola che dichiara il segnaposto ("locandina") è anche una delle
    // parole che il titolo perde quando viene ripulito dal marchio: va
    // verificata sul titolo pubblicato, PRIMA della rimozione. "Nuova
    // Locandina 1" ripulito diventa "Nuova 1", che non dice più nulla, e una
    // card non identificata deve restare segnalata come tale.
    const placeholderPublished =
      card.rawTitle && isPlaceholderTitle(card.rawTitle) ? card.rawTitle : null;

    if (isPlaceholderTitle(card.name) || placeholderPublished !== null) {
      found.push(
        anomaly(
          "PLACEHOLDER_TITLE",
          `Titolo segnaposto "${placeholderPublished ?? card.name}": locandina non ancora identificata dall'agenzia.`
        )
      );
    }

    if (!titleMatchesImage(card.destination, card.filename)) {
      found.push(
        anomaly(
          "TITLE_IMAGE_MISMATCH",
          `Il titolo "${card.name}" non trova riscontro nel file "${card.filename}".`
        )
      );
    }

    if (!card.destination) {
      found.push(
        anomaly(
          "DESTINATION_MISSING",
          card.rawTitle === null
            ? "Destinazione non ricavabile: titolo assente."
            : `Destinazione non ricavabile dal titolo "${card.name}".`
        )
      );
    }

    const sharing = byImage.get(card.imageUrl) ?? [];
    if (sharing.length > 1) {
      found.push(
        anomaly(
          "SHARED_IMAGE",
          `Immagine usata da ${sharing.length} card: ${sharing
            .map((c) => `"${c.name}"`)
            .join(", ")}.`
        )
      );
    }

    result.set(card.order, found);
  }

  return result;
}

/** Esito di `fetchOffertePage`. */
export interface OffertePageFetch {
  html: string;
  pageUrl: string;
  /** `Last-Modified` della risposta, quando il server lo invia. */
  lastModified: Date | null;
}

/**
 * Scarica la pagina `/offerte/`.
 *
 * Serve HTTP normale: la pagina è server-rendered, `robots.txt` la consente e
 * non serve alcun browser headless. In caso di errore si preferisce fallire:
 * un import a zero card farebbe sparire il catalogo senza motivo.
 */
export async function fetchOffertePage(
  pageUrl: string = OFFERTE_PAGE_URL
): Promise<OffertePageFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(pageUrl, {
      headers: { "User-Agent": CRAWLER_USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `Sorgente non raggiungibile: HTTP ${response.status} su ${pageUrl}.`
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("html")) {
      throw new Error(
        `Contenuto inatteso (${contentType}) invece di HTML su ${pageUrl}.`
      );
    }
    const lastModifiedHeader = response.headers.get("last-modified");
    const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : null;

    return {
      html: await response.text(),
      pageUrl: response.url || pageUrl,
      lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timeout dopo ${FETCH_TIMEOUT_MS}ms su ${pageUrl}.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
