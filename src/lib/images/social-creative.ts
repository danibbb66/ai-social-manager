/**
 * Renderer della creatività social.
 *
 * Produce un'immagine NUOVA a partire da una fotografia e dai dati realmente
 * estratti: non riusa la locandina, non la ritaglia, non la riusa come sfondo
 * promozionale. È il punto in cui la fotografia del generatore e i dati
 * commerciali della locandina smettono di essere due cose separate e diventano
 * un unico file postabile.
 *
 * Il testo è composto in SVG e rasterizzato da `sharp`. È una scelta, non un
 * vezzo: è l'unico modo di ottenere testo vero sopra una foto senza introdurre
 * un motore di layout grafico, e rende il risultato deterministico (stessi
 * input, stesso byte) che è ciò che rende la creatività riproducibile e
 * confrontabile tra due esecuzioni.
 *
 * Sul marchio: è sempre presente, ma non è mai inventato. Il repository non
 * contiene il logo dell'agenzia e non lo conterrà: al suo posto si stampa il
 * **wordmark**, cioè il nome dell'agenzia (`Brand.name`) composto come
 * marchio tipografico. Sono dati reali dell'azienda, non un segno grafico
 * inventato né un logo di terzi: la promessa del template è che ogni post
 * esce con il marchio di chi lo ha prodotto. Se l'utente carica il logo
 * vero, `brandLogo` prende il posto del wordmark e il layout non cambia.
 */

import sharp, { type OverlayOptions } from "sharp";
import type { CommercialExtraction } from "@/lib/catalog/commercial-extraction";
import { commercialLines } from "@/lib/catalog/commercial-extraction";
import { APP_FONT_STACK } from "@/lib/fonts";

/** Formato quadrato: la sposta sicura per ogni piattaforma, come nel resto dell'app. */
export const SOCIAL_CREATIVE_SIZE = 1080;
/**
 * Altezza del fotogramma verticale del POST (4:5): 1080×1350.
 *
 * È lo standard dei post immagine su Instagram/Facebook feed: un'immagine
 * statica più alta di 4:5 (es. 9:16) viene ritagliata da Instagram, perdendo
 * titolo/logo. I VIDEO restano 9:16 (1080×1920) perché sono reel, gestiti
 * separatamente in `src/lib/video/ffmpeg.ts`.
 */
export const SOCIAL_CREATIVE_HEIGHT = 1350;

export interface SocialCreativeInput {
  /** Fotografia del generatore: il fondo della creatività. */
  photo: Buffer;
  /**
   * Orientamento del fotogramma.
   *
   * `portrait` (4:5, 1080×1350) è usato dai post teaser (vetrina/tips/
   * itinerario): è il formato verticale corretto per il feed IG/FB. Il flusso
   * catalogo/locandina resta `square` (1080×1080) finché non viene trattato
   * separatamente.
   */
  orientation?: "square" | "portrait";
  /** Titolo in evidenza: destinazione o titolo della proposta. */
  title: string;
  /** Riga secondaria: nome della proposta o formato editoriale. */
  subtitle?: string | null;
  /**
   * Testo "gancio" centrato, stampato su un banner semitrasparente sopra la
   * foto (es. "hotel 4★, mezza pensione, date a richiesta"). Lo fornisce
   * l'utente dalla chat: non deriva né dal catalogo né dal modello. Se manca,
   * il post resta solo con il titolo della destinazione.
   */
  callout?: string | null;
  /**
   * Occhiello: la rubrica del contenuto, stampata sopra il titolo.
   *
   * Serve a dichiarare il tipo di post. Un post di consigli il cui titolo è
   * solo il nome della destinazione si legge come la locandina di un posto:
   * l'occhiello ("Consigli di viaggio") è ciò che lo dichiara contenuto
   * informativo, e quindi strutturalmente diverso da un hero di destinazione.
   */
  kicker?: string | null;
  /**
   * Punti stampati dentro la card: consigli o tappe.
   *
   * È ciò che distingue un post di consigli da un post che promette consigli. Un
   * formato come TRAVEL_TIPS o ITINERARY ha la promessa *nel contenuto* — i
   * consigli, le tappe — e una promessa che sta solo nella caption non si vede:
   * nel feed si scrolla l'immagine, non si legge. Quindi i punti entrano nel
   * fotogramma, non accanto al fotogramma.
   *
   * Il testo è lo stesso che va in caption: non è una versione parallela, è la
   * stessa lista di stringhe, così ciò che si vede e ciò che si legge non
   * possono divergere.
   */
  points?: readonly string[] | null;
  /** Dati commerciali estratti dalla locandina. */
  extraction: CommercialExtraction;
  /** Logo dell'agenzia, se l'utente ne ha caricato uno. */
  brandLogo?: { buffer: Buffer; mimeType: string } | null;
  /**
   * Nome dell'agenzia, stampato come wordmark quando non c'è un logo file.
   *
   * Non è un sostituto grafico del logo: è il nome dell'azienda, quindi
   * dichiara l'autore del post senza inventare nulla. Se manca anche questo,
   * il marchio non viene stampato e `hasBrandMark` lo dichiara.
   */
  brandName?: string | null;
}

export interface RenderedSocialCreative {
  buffer: Buffer;
  mimeType: "image/jpeg";
  filename: string;
  width: number;
  height: number;
  /** Righe commerciali realmente stampate: può essere vuoto. */
  commercialLines: { label: string; value: string }[];
  /**
   * Punti realmente stampati dentro la card: consigli o tappe.
   *
   * Vuoto se il formato non li usa o se non ce ne erano. Dichiarato perché un
   * fotogramma con i consigli stampati e uno senza non sono la stessa
   * creatività, e la differenza si vede solo guardando l'immagine.
   */
  printedPoints: string[];
  /** `true` solo se è stato stampato un marchio reale (logo file o wordmark). */
  hasBrandLogo: boolean;
  /** Quale marchio è stato stampato: dichiarato, non dedotto. */
  brandMark: BrandMarkKind | null;
  /** La rubrica effettivamente stampata sopra il titolo, o `null`. */
  kicker: string | null;
}

/**
 * Provenienza del marchio stampato sull'overlay.
 *
 * `logo` = file caricato dall'utente; `wordmark` = nome dell'agenzia composto
 * come testo. La distinzione resta dichiarata sull'asset perché un post con il
 * logo e un post con il wordmark non sono la stessa creatività.
 */
export type BrandMarkKind = "logo" | "wordmark";

/**
 * Escape XML.
 *
 * Obbligatorio e non decorativo: `&` e `<` compaiono in prezzi ("da 890 €"),
 * agenzie ("R&S") e nomi di località, e un `&` non escapato dentro l'SVG
 * rende l'overlay illegibile o ne cambia il layout.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Metriche del font: larghezze dei glifi in millesimi di em.
 *
 * Tabelle AFM di Arial regolare e Arial bold, cioè le due varianti che
 * l'overlay dichiara. Servono a misurare una riga prima di disegnarla senza
 * introdurre un motore di layout: la misura è deterministica e non dipende dal
 * font che la macchina di rasterizzazione ha installato davvero.
 */
const ARIAL_REGULAR: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
  "H": 722, "I": 278, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722, "O": 778,
  "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "W": 944,
  "X": 667, "Y": 667, "Z": 611, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556,
  "`": 333, "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556,
  "h": 556, "i": 222, "j": 222, "k": 500, "l": 222, "m": 833, "n": 556, "o": 556,
  "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556, "v": 500, "w": 722,
  "x": 500, "y": 500, "z": 500, "{": 334, "|": 260, "}": 334, "~": 584, "…": 1000,
};

const ARIAL_BOLD: Record<string, number> = {
  " ": 278, "!": 333, '"': 474, "#": 556, "$": 556, "%": 889, "&": 722, "'": 238,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 333, ";": 333, "<": 584, "=": 584, ">": 584, "?": 611,
  "@": 975, "A": 722, "B": 722, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
  "H": 722, "I": 278, "J": 556, "K": 722, "L": 611, "M": 833, "N": 722, "O": 778,
  "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "W": 944,
  "X": 667, "Y": 667, "Z": 611, "[": 333, "\\": 278, "]": 333, "^": 584, "_": 556,
  "`": 333, "a": 556, "b": 611, "c": 556, "d": 611, "e": 556, "f": 333, "g": 611,
  "h": 611, "i": 278, "j": 278, "k": 556, "l": 278, "m": 889, "n": 611, "o": 611,
  "p": 611, "q": 611, "r": 389, "s": 556, "t": 333, "u": 611, "v": 556, "w": 778,
  "x": 556, "y": 556, "z": 500, "{": 389, "|": 280, "}": 389, "~": 584, "…": 1000,
};

/** Glifi fuori tabella (accenti, simboli esotici): media prudente della famiglia. */
const FALLBACK_REGULAR = 556;
const FALLBACK_BOLD = 611;

/**
 * Larghezza approssimata di una stringa, in pixel.
 *
 * Il titolo è in weight 700, quindi si misura con la tabella bold: usare le
 * larghezze regolari significherebbe sottostimare ogni riga e fare uscire il
 * testo dal bordo. Nessuna chiamata al font installato, nessuna sorgente di
 * variabilità tra una esecuzione e l'altra.
 */
function textWidth(text: string, fontSize: number, bold: boolean): number {
  const table = bold ? ARIAL_BOLD : ARIAL_REGULAR;
  const fallback = bold ? FALLBACK_BOLD : FALLBACK_REGULAR;
  let units = 0;
  for (const ch of text) units += table[ch] ?? fallback;
  return (units * fontSize) / 1000;
}

/** Corpo di partenza del titolo, in rapporto al lato della creatività. */
const TITLE_SIZE_RATIO = 0.14;

/** Corpo minimo sotto al quale il testo non si legge più su uno schermo. */
const TITLE_MIN_SIZE_RATIO = 0.04;

/** Righe desiderate: un titolo che ne serve di più rimpicciolisce il corpo. */
const TITLE_TARGET_LINES = 4;

/** Riduzione del corpo a ogni tentativo che non entra nel riquadro. */
const TITLE_SHRINK = 0.9;

/**
 * Riserva orizzontale: la macchina di rasterizzazione potrebbe non avere
 * Arial e ricadere su un font metricamente più largo (DejaVu). L'8% di riserva
 * assorbe la differenza senza che una riga tocchi il bordo.
 */
const TITLE_WIDTH_SAFETY = 0.92;

/** Come la riga cresce rispetto al corpo: 0.078/0.072 del lato, come da layout. */
const TITLE_STEP_RATIO = 0.078 / 0.072;

/** Discendente approssimato del font, in rapporto al corpo. */
const TITLE_DESCENT_RATIO = 0.24;

/** Respiro fra il fondo del titolo e il blocco successivo, in rapporto al lato. */
const TITLE_BLOCK_GAP_RATIO = 0.026;

/** Corpo della pill della rubrica, in rapporto al lato. */
const KICKER_PILL_SIZE_RATIO = 0.026;

/** Vuoto fra la pill e la prima riga del titolo, in rapporto al lato. */
const KICKER_PILL_PADDING_RATIO = 0.045;

/**
 * Sfumature calde per il titolo, in rotazione: ogni post riceve un accento
 * diverso in modo deterministico dal proprio titolo, così due post non hanno
 * mai lo stesso identico titolo. Il bianco in alto è comune a tutti: è ciò che
 * tiene il corpo del testo luminoso e leggibile, l'accento colora la base.
 */
const TITLE_ACCENTS: ReadonlyArray<{ mid: string; bottom: string }> = [
  { mid: "#ffedb8", bottom: "#ffd166" }, // oro
  { mid: "#ffd9a8", bottom: "#ff9a3d" }, // arancione (tramonto)
  { mid: "#c8f5d8", bottom: "#34d399" }, // verde
  { mid: "#c4f4ee", bottom: "#2dd4bf" }, // turchese (mare)
  { mid: "#ffd8d3", bottom: "#ff7a6e" }, // corallo
  { mid: "#cfe7ff", bottom: "#54b8ff" }, // azzurro (cielo)
];

/** Indice stabile di un accento dal titolo: stesso posto, stesso colore. */
export function accentForTitle(title: string): { mid: string; bottom: string } {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  }
  return TITLE_ACCENTS[hash % TITLE_ACCENTS.length];
}

interface TitleBox {
  /** Larghezza utile per i glifi: padding e alone già scalati. */
  maxWidth: number;
  /** y a cui finisce il blocco in basso: il titolo non può scendere oltre. */
  maxBottom: number;
  /** y della prima baseline. */
  firstBaseline: number;
  /** Corpo di partenza e relativo passo tra le righe. */
  baseFontSize: number;
  baseStep: number;
  /** Soglia sotto la quale non si restringe più. */
  minFontSize: number;
}

/** Composizione del titolo: righe, corpo e geometria già risolta. */
interface TitleLayout {
  lines: string[];
  fontSize: number;
  firstBaseline: number;
  step: number;
}

/**
 * Spezza un titolo su più righe misurando davvero la larghezza di ogni riga.
 *
 * Tre vincoli, in quest'ordine:
 *
 *  - nessuna riga può superare `maxWidth`, nemmeno con una sola parola
 *    lunghissima: una parola senza spazi viene spezzata per caratteri anziché
 *    uscire dal bordo;
 *  - se le righe superano `TITLE_TARGET_LINES` il corpo si riduce
 *    proporzionalmente e il titolo viene ricomposto, finché non entra;
 *  - il blocco non può scendere sotto `maxBottom`, cioè non può finire sopra
 *    sottotitolo e dati commerciali.
 *
 * Solo all'ultimo, se nemmeno il corpo minimo basta, le righe che eccedono lo
 * spazio disponibile vengono tagliate con le ellissi: l'unico compromesso
 * ammesso è perdere coda, mai uscire dal riquadro.
 */
function wrapTitle(title: string, box: TitleBox): TitleLayout {
  const words = title.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const empty: TitleLayout = {
    lines: [],
    fontSize: box.baseFontSize,
    firstBaseline: box.firstBaseline,
    step: box.baseStep,
  };
  if (words.length === 0) return empty;

  let fontSize = box.baseFontSize;
  for (;;) {
    const lines = layoutWords(words, box.maxWidth, fontSize);
    const step = Math.max(1, Math.round((box.baseStep * fontSize) / box.baseFontSize));
    const descent = Math.round(fontSize * TITLE_DESCENT_RATIO);
    const lastBaseline = box.firstBaseline + Math.max(0, lines.length - 1) * step;
    const layout: TitleLayout = { lines, fontSize, firstBaseline: box.firstBaseline, step };
    if (lastBaseline + descent <= box.maxBottom && lines.length <= TITLE_TARGET_LINES) {
      return layout;
    }
    if (fontSize > box.minFontSize) {
      fontSize = Math.max(box.minFontSize, Math.floor(fontSize * TITLE_SHRINK));
      continue;
    }
    const capacity = Math.max(
      1,
      Math.floor((box.maxBottom - descent - box.firstBaseline) / step) + 1
    );
    if (lines.length <= capacity) return layout;
    return { ...layout, lines: trimLines(lines, capacity, fontSize, box.maxWidth) };
  }
}

/** Greedy word-wrap: ogni riga finisce all'ultima parola che ci sta ancora. */
function layoutWords(words: string[], maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const piece of splitLongWords(words, maxWidth, fontSize)) {
    const candidate = current ? `${current} ${piece}` : piece;
    if (!current || textWidth(candidate, fontSize, true) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Riduce in pezzi le parole più larghe della riga.
 *
 * Senza questo passaggio una parola senza spazi (un URL, una località unita)
 * resterebbe intatta e uscirebbe dal bordo: spezzarla è l'unico modo di
 * rispettare il vincolo senza troncare il contenuto.
 */
function splitLongWords(words: string[], maxWidth: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const word of words) {
    if (textWidth(word, fontSize, true) <= maxWidth) {
      out.push(word);
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      const candidate = chunk + ch;
      if (chunk && textWidth(candidate, fontSize, true) > maxWidth) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk = candidate;
      }
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

/** Taglia le righe eccessive aggiungendo le ellissi sull'ultima riga utile. */
function trimLines(lines: string[], capacity: number, fontSize: number, maxWidth: number): string[] {
  const kept = lines.slice(0, capacity);
  let last = kept[kept.length - 1].replace(/\s+$/, "");
  while (last.length > 1 && textWidth(`${last}…`, fontSize, true) > maxWidth) {
    last = last.slice(0, -1);
  }
  kept[kept.length - 1] = `${last.replace(/\s+$/, "")}…`;
  return kept;
}

/** Spessore dell'alone: il titolo deve scalarlo prima di misurarsi. */
function haloWidthOf(size: number): number {
  return Math.max(3, Math.round(size * 0.007));
}

/** Interruttori della card, in rapporto al lato. */
const CARD_RADIUS_RATIO = 0.026;
const CARD_PAD_RATIO = 0.052;
/** Padding della card quando contiene solo il titolo: aderisce al testo. */
const CARD_PAD_TITLE_RATIO = 0.026;
const CARD_MIN_TOP_RATIO = 0.1;
const CARD_MAX_BOTTOM_RATIO = 0.9;

/** Altezza del logo, in rapporto al lato: ben visibile sotto il banner. */
const LOGO_HEIGHT_RATIO = 0.25;
/** Margine dal fondo del logo, in rapporto all'altezza: il logo sta sotto il banner. */
const LOGO_BOTTOM_MARGIN_RATIO = 0.06;

/** Corpo di partenza del testo dei punti, in rapporto al lato. */
const POINT_SIZE_RATIO = 0.024;
/**
 * Corpo minimo dei punti: sotto questo il consiglio smette di essere leggibile,
 * e un consiglio illeggibile è la stessa cosa di un consiglio assente.
 */
const POINT_MIN_SIZE_RATIO = 0.019;
/** Passo fra le righe dello stesso punto: maggiore del corpo, sono paragrafi. */
const POINT_STEP_RATIO = 1.32;
/** Vuoto fra un punto e l'altro, in rapporto al lato. */
const POINT_GAP_RATIO = 0.016;
/** Rientro del testo rispetto al pallino del punto, in rapporto al lato. */
const POINT_INDENT_RATIO = 0.02;
/**
 * Righe commerciali stampate quando la card contiene anche i punti.
 *
 * Una locandina può avere sette campi, e sette righe più tre consigli non
 * entrano in un quadrato: la card uscirebbe dal fotogramma. I dati restano
 * tutti nell'audit e nei metadata, ma sul post ne entrano quattro, quelli che
 * decidono una prenotazione. È un limite di stampa, non di informazione.
 */
const MAX_COMMERCIAL_WITH_POINTS = 4;
/**
 * Righe commerciali che restano quando anche quattro non ci stanno.
 *
 * È il fondo oltre il quale si preferisce togliere un dato commerciale
 * dell'offerta — che l'utente ha già letto nell'offerta e che resta nei
 * metadata — invece di togliere l'ultimo consiglio, che è la ragione per cui il
 * post esiste. Un punto in meno è un punto in meno; un dato in meno è un dato
 * che l'utente può chiedere.
 */
const MIN_COMMERCIAL_WITH_POINTS = 1;

/**
 * Un punto da stampare, già misurato e spezzato in righe.
 *
 * I punti sono le righe lunghe — un consiglio, una tappa — quindi non entrano
 * nella riga singola delle righe commerciali. Vengono spezzati a parole sulla
 * larghezza interna della card, senza mai venire tagliati: un punto entra
 * intero, su quante righe serve, e chi decide è il corpo del testo, non un
 * tetto di righe.
 */
interface PointLayout {
  points: { lines: string[] }[];
  fontSize: number;
  step: number;
  /** Altezza del blocco, vuoti fra i punti compresi. */
  blockHeight: number;
}

/**
 * I corpi da provare, dal più grande al più piccolo, per i punti della card.
 *
 * La lista finisce sempre con il corpo minimo: se anche quello non basta, si
 * stampa lo stesso, perché l'alternativa non è "un fotogramma più piccolo" ma
 * "un consiglio in meno", e un consiglio in coda è proprio quello che il
 * fotogramma non può perdere.
 */
function pointFontSizes(size: number): number[] {
  return rangeDown(
    Math.round(size * POINT_SIZE_RATIO),
    Math.max(1, Math.round(size * POINT_MIN_SIZE_RATIO))
  );
}

/** `from`, `from - 1`, … `to`: la scala dei tentativi, dalla più generosa. */
function rangeDown(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value >= to; value -= 1) out.push(value);
  return out;
}

/**
 * Misura i punti da stampare dentro la card, al corpo indicato.
 *
 * Nessun punto viene tagliato e nessuno viene perso: la funzione spezza ogni
 * consiglio a parole sulla larghezza interna della card e restituisce tutte le
 * righe che servono. Il numero di righe non è un vincolo ma un risultato,
 * perché è il corpo scelto dal `renderSocialCreative` a decidere quanto spazio
 * il blocco occupa, e la scelta del corpo avviene proprio per far entrare tutti
 * i punti.
 */
function layoutPoints(
  points: readonly string[],
  maxWidth: number,
  size: number,
  fontSize: number
): PointLayout {
  const step = Math.round(fontSize * POINT_STEP_RATIO);
  const gap = Math.round(size * POINT_GAP_RATIO);

  const measured = points
    .map((point) => point.replace(/\s+/g, " ").trim())
    .filter((point) => point.length > 0)
    .map((point) => ({
      lines: layoutWords(point.split(" ").filter(Boolean), maxWidth, fontSize),
    }))
    .filter((point) => point.lines.length > 0);

  const blockHeight =
    measured.length === 0
      ? 0
      : measured.reduce((total, point) => total + point.lines.length * step, 0) +
        (measured.length - 1) * gap;

  return { points: measured, fontSize, step, blockHeight };
}

/**
 * Il riquadro che contiene rubrica, titolo e dati.
 *
 * Il testo non appoggia più direttamente sulla foto. Sta in una card scura,
 * semitrasparente e arrotondata che galleggia sopra il gradiente: è ciò che
 * distingue un'immagine di un'agenzia da un'immagine con del testo sopra. La
 * foto continua a essere leggibile sopra la card — la card è scura ma non
 * opaca — e il gradiente sotto diventa l'ombra che stacca il blocco dal fondo.
 *
 * ## Perché la card sta in basso
 *
 * Il formato del fotogramma è `1:1` e la copia vive in basso: titolo, dati
 * dell'offerta e CTA si leggono nello stesso punto. Con la card in alto, il
 * titolo e i dati sarebbero separati dal fondo dal contenuto della foto, che
 * su Instagram viene ritagliato in anteprima.
 *
 * ## Perché è limitata in larghezza
 *
 * La larghezza è calcolata sul contenuto e limitata a metà frame. Un blocco a
 * tutta larghezza sembrerebbe una didascalia, non una card; una card più larga
 * di metà frame non conterrebbe il titolo su tre righe senza allargarsi oltre.
 */
interface CardBox {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  padding: number;
}

/**
 * La card che contiene il blocco di testo.
 *
 * `contentWidth` è la larghezza che il testo richiede davvero, già calcolata
 * dal renderer: qui si ricava il riquadro e si sceglie dove metterlo. La card
 * non può uscire dal frame né occuparne tutta l'altezza, altrimenti non
 * sarebbe più una fascia sopra una foto ma un'immagine con una foto dentro.
 */
function cardBox(input: {
  size: number;
  /** Altezza del fotogramma: la card si ancora al bordo inferiore di questa. */
  canvasHeight: number;
  contentWidth: number;
  contentHeight: number;
  hasSubtitle: boolean;
  hasCommercial: boolean;
  hasPoints?: boolean;
}): CardBox {
  const { size, canvasHeight, contentWidth, contentHeight, hasSubtitle, hasCommercial, hasPoints } = input;
  // Un blocco senza dati e senza sottotitolo è solo un titolo: in quel caso la
  // card si stringe sia in larghezza sia in padding, perché un rettangolo
  // grande per tre parole sembrerebbe vuoto e squilibrato. Con i punti o un
  // listino dentro, invece, la card è il contenuto e va lasciata respirare.
  const emptyish = !hasSubtitle && !hasCommercial && !hasPoints;
  const padding = Math.round(size * (emptyish ? CARD_PAD_TITLE_RATIO : CARD_PAD_RATIO));
  const radius = Math.round(size * CARD_RADIUS_RATIO);

  const maxWidth = Math.round(size * 0.9);
  const minWidth = Math.round(size * 0.56);
  const width = Math.min(
    maxWidth,
    Math.max(emptyish ? 0 : minWidth, Math.ceil(contentWidth) + padding * 2)
  );

  const height = Math.ceil(contentHeight) + padding * 2;

  // La fascia è ancorata IN ALTO al centro: il nome della destinazione vive
  // sempre in cima alla creatività. La card cresce verso il basso quando
  // contiene anche punti o listino, e resta comunque entro il limite inferiore
  // del fotogramma.
  const topLimit = Math.round(canvasHeight * CARD_MIN_TOP_RATIO);
  const bottomLimit = Math.round(canvasHeight * CARD_MAX_BOTTOM_RATIO);
  let y = topLimit;
  if (y + height > bottomLimit) y = bottomLimit - height;

  return { x: Math.round((size - width) / 2), y, width, height, radius, padding };
}

/** Le righe commerciali sono etichetta + valore: qui si tiene solo il testo. */
function commercialText(extraction: CommercialExtraction): string {
  return commercialLines(extraction)
    .map((l) => `${l.label}  ${l.value}`)
    .join("\u0001");
}

/**
 * Wordmark: il nome dell'agenzia composto come marchio, nello slot del logo.
 *
 * È la promessa del template mantenuta anche quando l'utente non ha caricato
 * un logo file: il post dichiara l'autore. I dati sono il nome configurato in
 * `Brand.name`, quindi niente viene inventato.
 *
 * Il testo e il corpo sono entrambi vincolati, e in quest'ordine:
 *
 *  1. il nome viene ridotto a un massimo di parole e di caratteri, tagliandolo
 *     solo al confine di una parola: "La Mia Agenzia di" non dichiara l'autore;
 *  2. il corpo viene ridotto finché il marchio non entra nello slot.
 *
 * La misura, a differenza del titolo, non usa la tabella di glifi: il candidato
 * viene rasterizzato e ritagliato sull'inchiostro, e la sua larghezza reale
 * decide se entra. Il wordmark è una singola riga che non può andare a capo,
 * quindi una stima sbagliata non verrebbe corretta da nessun passaggio
 * successivo e taglierebbe il marchio sul bordo.
 *
 * Restituisce `null` quando il nome è vuoto o quando non entra nemmeno al
 * corpo minimo: nessun nome non significa un marchio anonimo disegnato a mano,
 * significa che il marchio non c'è e `hasBrandLogo` lo dichiara.
 */
const WORDMARK_MAX_WORDS = 5;
const WORDMARK_MAX_CHARS = 34;
const WORDMARK_MIN_SIZE_RATIO = 0.016;
const WORDMARK_SIZE_RATIO = 0.026;
/** Tentativi di riduzione del corpo prima di rinunciare al marchio. */
const WORDMARK_FIT_ATTEMPTS = 6;

function wordmarkSvg(input: {
  text: string;
  fontSize: number;
  canvasWidth: number;
  canvasHeight: number;
  haloWidth: number;
}): string {
  const { text, fontSize, canvasWidth, canvasHeight, haloWidth } = input;
  const baseline = Math.round(fontSize * 1.2);
  const attrs =
    `x="2" y="${baseline}" font-size="${fontSize}" font-weight="700" ` +
    `font-family="${APP_FONT_STACK}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">` +
    `<text ${attrs} fill="#000000" fill-opacity="0.92" stroke="#000000" ` +
    `stroke-opacity="0.92" stroke-width="${haloWidth}" stroke-linejoin="round">${esc(text)}</text>` +
    `<text ${attrs} fill="#ffffff">${esc(text)}</text>` +
    `</svg>`
  );
}

async function brandWordmarkOverlay(input: {
  size: number;
  /** Altezza del fotogramma: posiziona il marchio sotto il banner. */
  height: number;
  name: string;
}): Promise<{ overlay: OverlayOptions } | null> {
  const { size, height, name } = input;

  const words = name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return null;
  let text = words.slice(0, WORDMARK_MAX_WORDS).join(" ");
  if (text.length > WORDMARK_MAX_CHARS) {
    text = text.slice(0, WORDMARK_MAX_CHARS).replace(/\s+\S*$/, "");
  }
  if (!text) return null;

  // Stessa larghezza massima del logo: i due marchio occupano lo stesso slot,
  // quindi il layout non dipende da quale dei due sia stato stampato.
  const maxWidth = Math.round(size * 0.35);
  const haloWidth = haloWidthOf(size);
  const minFontSize = Math.round(size * WORDMARK_MIN_SIZE_RATIO);
  // La tela è volutamente più larga dello slot: il testo viene ritagliato
  // attorno all'inchiostro, così la larghezza misurata è quella del marchio e
  // non quella di una scatola con spazio morto.
  const canvasWidth = maxWidth * 4;
  const canvasHeight = Math.round(size * WORDMARK_SIZE_RATIO * 1.8);

  let fontSize = Math.round(size * WORDMARK_SIZE_RATIO);
  for (let attempt = 0; attempt < WORDMARK_FIT_ATTEMPTS; attempt++) {
    if (fontSize < minFontSize) return null;
    const svg = wordmarkSvg({ text, fontSize, canvasWidth, canvasHeight, haloWidth });
    // `trim` ritaglia sull'inchiostro: quello che resta è il marchio, delle
    // dimensioni reali che occupa, che è l'unica misura valida per decidere se
    // entra nello slot.
    const trimmed = await sharp(Buffer.from(svg, "utf8")).png().trim().toBuffer();
    const meta = await sharp(trimmed).metadata();
    const measured = meta.width ?? 0;
    if (measured > 0 && measured <= maxWidth) {
      const markHeight = meta.height ?? canvasHeight;
      return {
        overlay: {
          input: trimmed,
          left: Math.round((size - measured) / 2),
          top: height - markHeight - Math.round(size * LOGO_BOTTOM_MARGIN_RATIO),
        },
      };
    }
    if (measured === 0) return null;
    // Corpo ridotto in proporzione allo sforamento, con un piccolo margine:
    // la misura successiva non deve ripetere lo stesso tentativo.
    fontSize = Math.max(minFontSize - 1, Math.floor(fontSize * (maxWidth / measured) * 0.98));
  }
  return null;
}

/**
 * Overlay SVG: velatura per la leggibilità, titolo, dati commerciali, logo.
 *
 * La velatura è un gradiente scuro su entrambi i lati, non un rettangolo pieno:
 * ombreggia la fascia del titolo in alto e quella dei dati in basso e lascia la
 * fotografia respirare al centro, che è la parte che il generatore ha lavorato
 * di più.
 *
 * Ogni testo va in canvas due volte: prima come alone nero, poi come riempimento
 * bianco. L'alone è ciò che garantisce il contrasto su qualsiasi foto, il bianco
 * sopra ci dà la nitidezza: nessuna delle due metà dipende dal colore dietro.
 */
function buildOverlay(input: {
  size: number;
  title: TitleLayout;
  /** Il badge della rubrica, o `null` se il post non ne ha uno. */
  kicker: { label: string; fontSize: number; tracking: number; pillW: number; pillH: number } | null;
  subtitle: string | null;
  commercial: { label: string; value: string }[];
  /** Consigli o tappe, già misurati: il renderer non li deve più comporre. */
  points: PointLayout;
  card: CardBox;
  rowHeight: number;
  subtitleH: number;
  /** Altezza del fotogramma verticale. */
  height: number;
  /** Accento del titolo, scelto dal renderer in base al nome della destinazione. */
  accent: { mid: string; bottom: string };
}): string {
  const { size, title, kicker, subtitle, commercial, points, card, rowHeight, subtitleH, height, accent } = input;
  const family = APP_FONT_STACK;
  // Senza dati né punti la card è solo un contenitore per il titolo: si toglie
  // del tutto e il titolo poggia direttamente sulla foto (velatura in basso +
  // alone scuro). Con punti o listino dentro, invece, la card resta il fondo
  // che rende leggibili le righe.
  const emptyish = !subtitle && commercial.length === 0 && points.points.length === 0;
  // Spessore dell'alone in unità utente: abbastanza da staccare i glyph dal
  // fondo della card, abbastanza poco da non impastare il corpo del carattere.
  // Dentro una card scura l'alone serve meno che sulla foto, ma resta: il
  // titolo è bianco pieno e senza alone su un semitrasparente medio si
  // consumerebbe.
  const haloWidth = Math.round(haloWidthOf(size) * 0.8);
  const haloAttrs = `fill="#0b0f14" fill-opacity="0.85" stroke="#0b0f14" stroke-opacity="0.85" stroke-width="${haloWidth}" stroke-linejoin="round"`;

  const layers: { halo: string; fill: string }[] = [];
  /**
   * Contenitori disegnati sotto al testo: la card e i badge.
   *
   * Sono separati dai layer perché il loro ordine di disegno è diverso: sono
   * fondi, quindi vanno sotto agli ali del titolo. Se stessero nello stesso
   * array, l'alone — pensato per staccare i glyph — passerebbe sopra la card e
   * ne sporcerebbe il bordo.
   */
  const badges: string[] = [];

  // Origine interna della card: tutto il testo è posizionato relative a questa,
  // e la card viene traslata nel frame alla fine. Il layout del testo non
  // dipende quindi da dove la fascia finisce.
  const innerX = card.x + card.padding;
  const innerY = card.y + card.padding;
  const innerW = card.width - card.padding * 2;
  const innerCenterX = innerX + innerW / 2;

  // Il titolo è centrato sulla card, non allineato a sinistra.
  //
  // `text-anchor="middle"` con `x` al centro interno è l'unico modo per farlo
  // senza misurare ogni riga qui: l'ancoraggio è calcolato dal rasterizzatore
  // sul font che ha davvero, quindi resta centrato anche se il font installato
  // non è quello previsto dalla tabella di glifi.
  title.lines.forEach((line, i) => {
    const y = innerY + title.firstBaseline + i * title.step;
    const attrs =
      `x="${innerCenterX}" y="${y}" text-anchor="middle" font-size="${title.fontSize}" ` +
      `font-weight="700" font-family="${family}"`;
    layers.push({
      halo: `<text ${attrs} ${haloAttrs}>${esc(line)}</text>`,
      // Il titolo usa una sfumatura calda oro-champagne invece del bianco
      // piatto: resta luminoso su qualsiasi foto ma ha più carattere.
      fill: `<text ${attrs} fill="url(#titleFill)">${esc(line)}</text>`,
    });
  });

  // La rubrica è un badge, non una riga di testo.
  //
  // Un'etichetta appoggiata sulla foto è solo un titolo più piccolo: si legge
  // come parte del titolo e non ha una funzione propria. Il badge ha un
  // contenitore arrotondato e semitrasparente che la separa dal titolo, ed è
  // ciò che la fa leggere come etichetta. Dentro la card il contrasto è per
  // costruzione: non usa l'alone del titolo, perché la pill ha già un fondo
  // proprio e l'alone sopra un bordo chiaro la renderebbe illeggibile.
  if (kicker) {
    const pillX = Math.round(innerCenterX - kicker.pillW / 2);
    const pillY = innerY;
    badges.push(
      `  <rect x="${pillX}" y="${pillY}" width="${kicker.pillW}" height="${kicker.pillH}" ` +
        `rx="${Math.round(kicker.pillH / 2)}" fill="#f8fafc" fill-opacity="0.14" ` +
        `stroke="#f8fafc" stroke-opacity="0.3" stroke-width="${Math.max(1, Math.round(size * 0.002))}"/>`
    );
    const textY = pillY + Math.round(kicker.pillH / 2 + kicker.fontSize * 0.35);
    layers.push({
      halo: "",
      fill:
        `<text x="${innerCenterX}" y="${textY}" text-anchor="middle" font-size="${kicker.fontSize}" ` +
        `font-weight="600" font-family="${family}" letter-spacing="${kicker.tracking}" ` +
        `fill="#ffffff" fill-opacity="0.94">${esc(kicker.label)}</text>`,
    });
  }

  // Il fondo del titolo è il fondo dei glyph, non l'ultima baseline: sotto
  // l'ultima riga ci sono ancora i discenti, e il blocco successivo deve
  // partire da lì. Poi c'è un respiro esplicito prima del sottotitolo.
  const titleBottom =
    innerY + title.firstBaseline + Math.max(0, title.lines.length - 1) * title.step +
    Math.round(title.fontSize * TITLE_DESCENT_RATIO);
  const blockTop = titleBottom + Math.round(size * TITLE_BLOCK_GAP_RATIO);

  if (subtitle) {
    const y = blockTop + subtitleH - Math.round(size * 0.014);
    const attrs =
      `x="${innerCenterX}" y="${y}" text-anchor="middle" font-size="${Math.round(size * 0.031)}" ` +
      `font-family="${family}"`;
    layers.push({
      halo: `<text ${attrs} ${haloAttrs}>${esc(subtitle)}</text>`,
      fill: `<text ${attrs} fill="#ffffff" fill-opacity="0.82">${esc(subtitle)}</text>`,
    });
  }

  // I punti sono il contenuto del post stampato sopra la foto.
  //
  // Stanno fra il sottotitolo e i dati commerciali perché è la loro posizione
  // naturale: il titolo dice *di cosa* parlano, i punti dicono *cosa*, i dati
  // dicono quanto costa. Ogni punto ha un pallino che lo separa dagli altri,
  // perché un paragrafo senza interruzioni sopra una foto si legge come un
  // blocco unico e i tre consigli diventano uno solo.
  const pointsTop = blockTop + subtitleH + Math.round(size * 0.012);
  const pointGap = Math.round(size * POINT_GAP_RATIO);
  const pointIndent = Math.round(size * POINT_INDENT_RATIO);
  const dotR = Math.max(2, Math.round(points.fontSize * 0.28));
  let cursor = pointsTop;
  for (const point of points.points) {
    point.lines.forEach((line, i) => {
      // Ogni riga del punto scende di un passo: è un paragrafo spezzato, e
      // senza il passo tutte le righe finirebbero sulla stessa baseline.
      const baseline =
        cursor + i * points.step + points.step - Math.round(points.step * 0.24);
      const attrs =
        `x="${innerX + pointIndent}" y="${baseline}" font-family="${family}" ` +
        `font-size="${points.fontSize}"`;
      layers.push({
        halo: `<text ${attrs} ${haloAttrs}>${esc(line)}</text>`,
        fill: `<text ${attrs} fill="#ffffff" fill-opacity="0.94">${esc(line)}</text>`,
      });
      // Il pallino sta sulla prima riga del punto: è lì che l'occhio torna a
      // iniziare, e su una riga successiva sarebbe un punto a caso.
      if (i === 0) {
        badges.push(
          `  <circle cx="${innerX + dotR}" cy="${Math.round(baseline - points.fontSize * 0.32)}" ` +
            `r="${dotR}" fill="#ffffff" fill-opacity="0.85"/>`
        );
      }
    });
    cursor += point.lines.length * points.step + pointGap;
  }
  const pointsBottom = cursor - pointGap;

  // I dati sono l'informazione, non il titolo: l'etichetta dice che cos'è e il
  // valore dice quanto. Perciò l'etichetta è minuscola, spaziata e translucida,
  // e il valore è pieno e in grassetto. Con lo stesso corpo e lo stesso colore
  // si leggerebbero come un blocco unico e il lettore non saprebbe quale dei due
  // sia il dato.
  const commercialTop =
    points.points.length > 0
      ? pointsBottom + Math.round(size * 0.018)
      : blockTop + subtitleH + Math.round(size * 0.012);
  commercial.forEach((line, i) => {
    const y = commercialTop + i * rowHeight + Math.round(rowHeight * 0.62);
    const labelSize = Math.round(size * 0.021);
    const valueSize = Math.round(size * 0.029);
    const attrs = `x="${innerX}" y="${y}" font-family="${family}"`;
    const label = line.label.toUpperCase();
    layers.push({
      halo:
        `<text ${attrs} ${haloAttrs}><tspan font-size="${labelSize}" letter-spacing="${Math.round(labelSize * 0.12)}">${esc(label)}</tspan>` +
        `<tspan dx="12" font-size="${valueSize}" font-weight="700">${esc(line.value)}</tspan></text>`,
      fill:
        `<text ${attrs} fill="#ffffff"><tspan fill="#ffffff" fill-opacity="0.62" font-size="${labelSize}" ` +
        `letter-spacing="${Math.round(labelSize * 0.12)}">${esc(label)}</tspan>` +
        `<tspan dx="12" font-size="${valueSize}" font-weight="700" fill="#ffffff">${esc(line.value)}</tspan></text>`,
    });
  });

  // Prima tutti gli ali, poi tutti i riempimenti: un alone disegnato dopo il
  // bianco della riga sopra lo coprirebbe a metà. Gli alone vuoti (il badge non
  // ne ha) non lasciano righe vuote nell'SVG.
  const halos = layers
    .filter((l) => l.halo)
    .map((l) => `  ${l.halo}`)
    .join("\n");
  const fills = layers.map((l) => `  ${l.fill}`).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}">
  <defs>
    <!--
      Il gradiente scurisce il bordo superiore, dove ora sta la card con il
      nome della destinazione, e sfuma verso il basso lasciando la foto libera
      al centro. Il testo non ci poggia più direttamente sopra, quindi la
      velatura non ha più il compito di garantire il contrasto del titolo:
      serve a dare profondità e a far emergere il blocco davanti alla foto.
    -->
    <linearGradient id="veil" x1="0.15" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="#05070b" stop-opacity="0.8"/>
      <stop offset="30%" stop-color="#05070b" stop-opacity="0.48"/>
      <stop offset="55%" stop-color="#05070b" stop-opacity="0.22"/>
      <stop offset="78%" stop-color="#05070b" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#05070b" stop-opacity="0.26"/>
    </linearGradient>
    <!--
      La card è "glass": quasi nera ma non opaca, con un bordo chiaro che la
      stacca dalla foto. Il fill non pieno è deliberato — la foto continua a
      leggersi dentro la card, e quello è ciò che la fa sembrare vetro e non
      un rettangolo.
    -->
    <linearGradient id="cardFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0b1119" stop-opacity="0.62"/>
      <stop offset="100%" stop-color="#05080d" stop-opacity="0.86"/>
    </linearGradient>
    <linearGradient id="cardStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.26"/>
    </linearGradient>
    <!--
      Sfumatura del titolo: dal bianco caldo al dorato. È un accento caldo che
      non dipende dalla foto dietro e dà al nome della destinazione un tono
      più ricco del bianco piatto, restando leggibile grazie all'alone scuro.
    -->
    <linearGradient id="titleFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="${accent.mid}"/>
      <stop offset="100%" stop-color="${accent.bottom}"/>
    </linearGradient>
    <!--
      Il riflesso è un tocco di luce sul bordo inferiore del frame: senza, il
      fondo è un blocco piatto e la card sembra appoggiata a un muro.
    -->
    <linearGradient id="sheen" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.09"/>
      <stop offset="45%" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${height}" fill="url(#veil)"/>
  <rect width="${size}" height="${height}" fill="url(#sheen)"/>
${emptyish
    ? ""
    : `<rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="${card.radius}" fill="url(#cardFill)" stroke="url(#cardStroke)" stroke-width="${Math.max(1, Math.round(size * 0.0022))}"/>`}
${badges.join("\n")}
${halos}
${fills}
</svg>`;
}

/** Corpo di partenza del testo gancio, in rapporto al lato (≈65px su 1080). */
const CALLOUT_SIZE_RATIO = 0.06;
/** Corpo minimo del gancio. */
const CALLOUT_MIN_SIZE_RATIO = 0.026;
/** Larghezza massima del banner del gancio, in rapporto al lato. */
const CALLOUT_MAX_WIDTH_RATIO = 0.74;
/**
 * Numero massimo di righe del gancio.
 *
 * Il gancio è separato in righe sulle virgole (struttura verticale), quindi il
 * tetto sale per accogliere più segmenti senza tagliare il testo dell'utente.
 */
const CALLOUT_MAX_LINES = 7;
/** Padding orizzontale del banner, in rapporto al lato. */
const CALLOUT_PAD_RATIO = 0.036;
/** Posizione verticale del centro del gancio, rispetto all'altezza. */
const CALLOUT_V_CENTER_RATIO = 0.52;

/**
 * Testo "gancio" centrato su un banner semitrasparente.
 *
 * È un elemento separato dalla card: vive al centro del fotogramma, sopra la
 * foto, e dà al post una promessa concreta ("hotel 4★, mezza pensione…") che
 * la sola destinazione non dà. Il testo arriva dall'utente; se manca, il post
 * resta solo con il titolo. Il banner ha il fondo scuro-semitrasparente:
 * sopra un cielo luminoso un testo bianco puro non si leggerebbe.
 */
function buildCallout(input: {
  size: number;
  height: number;
  text: string | null | undefined;
}): string | null {
  const { size, height } = input;
  const trimmed = (input.text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return null;

  const maxWidth = Math.round(size * CALLOUT_MAX_WIDTH_RATIO);
  const baseFontSize = Math.round(size * CALLOUT_SIZE_RATIO);
  const minFontSize = Math.round(size * CALLOUT_MIN_SIZE_RATIO);

  // L'utente separa i concetti con le virgole ("hotel 4★, mezza pensione, da
  // €…"): ogni segmento va su una riga propria, così il gancio diventa una
  // struttura verticale leggibile invece di un unico blocco di testo. Anche la
  // coppia "dal … al …" della data si spezza su due righe. I segmenti più lunghi
  // vanno a capo a parole sulla larghezza massima, senza perdere nulla.
  const segments = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap((s) => s.split(/\s+(?=al\s+)/i).map((p) => p.trim()))
    .filter((s) => s.length > 0);

  let fontSize = baseFontSize;
  let lines: string[] = [];
  for (;;) {
    lines = segments.flatMap((segment) =>
      layoutWords(segment.split(" ").filter(Boolean), maxWidth, fontSize)
    );
    if (lines.length <= CALLOUT_MAX_LINES) break;
    if (fontSize <= minFontSize) break;
    fontSize = Math.max(minFontSize, Math.floor(fontSize * 0.9));
  }
  if (lines.length > CALLOUT_MAX_LINES) {
    lines = trimLines(lines, CALLOUT_MAX_LINES, fontSize, maxWidth);
  }
  if (lines.length === 0) return null;

  const step = Math.max(1, Math.round(fontSize * 1.26));
  const firstBaseline = Math.round(fontSize * 1.05);
  const textBlockH =
    firstBaseline + Math.max(0, lines.length - 1) * step + Math.round(fontSize * 0.24);
  const maxLineW = Math.max(...lines.map((line) => textWidth(line, fontSize, true)), 1);

  const padX = Math.round(size * CALLOUT_PAD_RATIO);
  const padY = Math.round(size * CALLOUT_PAD_RATIO * 0.6);
  const bannerW = Math.round(maxLineW) + padX * 2;
  const bannerH = Math.round(textBlockH) + padY * 2;
  const bannerX = Math.round((size - bannerW) / 2);
  const centerY = Math.round(height * CALLOUT_V_CENTER_RATIO);
  const bannerY = Math.round(centerY - bannerH / 2);
  const radius = Math.round(size * 0.028);

  const family = APP_FONT_STACK;
  const haloWidth = Math.round(size * 0.006);
  const haloAttrs =
    `fill="#0b0f14" fill-opacity="0.5" stroke="#0b0f14" stroke-opacity="0.5" ` +
    `stroke-width="${haloWidth}" stroke-linejoin="round"`;
  const centerX = Math.round(size / 2);

  const textLayers = lines
    .map((line, i) => {
      const y = bannerY + padY + firstBaseline + i * step;
      const attrs =
        `x="${centerX}" y="${y}" text-anchor="middle" font-size="${fontSize}" ` +
        `font-weight="600" font-family="${family}"`;
      return (
        `<text ${attrs} ${haloAttrs}>${esc(line)}</text>` +
        `<text ${attrs} fill="#ffffff">${esc(line)}</text>`
      );
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}">
  <rect x="${bannerX}" y="${bannerY}" width="${bannerW}" height="${bannerH}" rx="${radius}" fill="#0b1119" fill-opacity="0.68" stroke="#ffffff" stroke-opacity="0.26" stroke-width="${Math.max(1, Math.round(size * 0.002))}"/>
${textLayers}
</svg>`;
}

/**
 * Compone la creatività sociale.
 *
 * Fallisce solo per problemi reali (foto illeggibile, disco pieno). Non solleva
 * mai eccezioni "morbide": se non può produrre un'immagine, il chiamante deve
 * saperlo e non deve creare un DRAFT senza visuale.
 */
export async function renderSocialCreative(input: SocialCreativeInput): Promise<RenderedSocialCreative> {
  const size = SOCIAL_CREATIVE_SIZE;
  const height = input.orientation === "portrait" ? SOCIAL_CREATIVE_HEIGHT : size;
  const title = input.title.trim();
  if (!title) throw new Error("Titolo mancante: non si può comporre la creatività.");
  if (input.photo.length === 0) throw new Error("Fotografia mancante: non si può comporre la creatività.");

  const lines = commercialLines(input.extraction);
  const subtitle = input.subtitle?.trim() || null;
  const pad = Math.round(size * 0.062);

  const kicker = input.kicker?.trim() || null;

  // Il blocco di testo vive dentro una card, quindi si misura contro la
  // larghezza interna della card e non contro il frame: una riga che ne
  // occuperebbe il 100% farebbe uscire il testo dai bordi arrotondati.
  const cardPadding = Math.round(size * CARD_PAD_RATIO);
  const cardInnerMax = Math.round((size * 0.9 - cardPadding * 2 - haloWidthOf(size)) * TITLE_WIDTH_SAFETY);

  const kickerSize = kicker ? Math.round(size * KICKER_PILL_SIZE_RATIO) : 0;
  const kickerTracking = Math.round(kickerSize * 0.14);
  const kickerBlockH = kicker
    ? Math.round(kickerSize * 2.2 + KICKER_PILL_PADDING_RATIO * size)
    : 0;

  // I dati occupano una riga ciascuno; il sottotitolo una, se c'è.
  const rowHeight = Math.round(size * 0.043);
  const subtitleH = subtitle ? Math.round(size * 0.046) : 0;

  // I punti vengono misurati per primi, perché decidono quanto spazio resta al
  // titolo: se il titolo si misurasse prima, si troverebbe il posto dove
  // stanno i punti e finirebbe sotto di loro. Misurare i punti per primi è
  // l'unico ordine in cui i due si contendono lo stesso riquadro senza
  // sovrapporsi.
  const requestedPoints = (input.points ?? []).filter((point) => point.trim().length > 0);
  const pointsMaxWidth = cardInnerMax - Math.round(size * POINT_INDENT_RATIO);

  // Con i punti dentro, le righe commerciali si limitano: sette campi più tre
  // consigli non starebbero nel fotogramma, e una card che sfora dal bordo è
  // peggio di una card con quattro dati. Il resto dei dati resta nei metadata.
  const hasPoints = requestedPoints.length > 0;

  // Lo spazio disponibile è quello fra il limite alto e quello basso, meno i
  // due padding: oltre, la card uscirebbe dal fotogramma. Serve a fare il
  // confronto mentre si compone, non dopo.
  const maxContentHeight =
    Math.round(size * (CARD_MAX_BOTTOM_RATIO - CARD_MIN_TOP_RATIO)) - cardPadding * 2;

  const titleGap = Math.round(size * TITLE_BLOCK_GAP_RATIO);
  const subtitleTrailing = subtitle ? Math.round(size * 0.018) : 0;
  const commercialTrailing = Math.round(size * 0.014);

  /**
   * Compone titolo, punti e altezza totale per un corpo dei punti e un tetto di
   * righe commerciali.
   *
   * È una funzione e non un blocco lineare perché i tre elementi si
   * condividono lo spazio: il titolo può restringersi, i punti possono
   * restringersi, le righe dell'offerta possono ridursi, e ognuna di queste
   * scelte cambia lo spazio delle altre. Senza ricalcolare, il titolo resterebbe
   * dimensionato su uno spazio che non esiste più e la card si sovrapporrebbe
   * ai dati.
   *
   * Il titolo riceve due limiti e prende il più stretto: non può scendere
   * sopra il blocco dei punti, e la somma di tutto non può superare l'altezza
   * disponibile. Il secondo limite è quello che rende possibile la promessa
   * sui punti: senza di esso l'unica leva che restava sarebbe togliere un
   * consiglio.
   */
  const fit = (
    pointFontSize: number,
    rowsLimit: number
  ): {
    points: PointLayout;
    title: TitleLayout;
    rows: { label: string; value: string }[];
    contentHeight: number;
  } => {
    const pointsLayout = layoutPoints(requestedPoints, pointsMaxWidth, size, pointFontSize);
    const pointsTrailing = pointsLayout.blockHeight > 0 ? Math.round(size * 0.018) : 0;
    const rows = lines.slice(0, Math.max(0, rowsLimit));
    const commercialHeight = rows.length * rowHeight;

    const belowTitle =
      subtitleH + pointsLayout.blockHeight + pointsTrailing + commercialHeight;
    const contentHeight =
      maxContentHeight -
      titleGap -
      belowTitle -
      subtitleTrailing -
      commercialTrailing;

    const titleLayout = wrapTitle(title, {
      maxWidth: cardInnerMax,
      // Il titolo può occupare tutto lo spazio che `contentHeight` gli ha
      // riservato (sottotitolo, punti e righe commerciali sono già sottratti).
      // Il precedente `Math.min(kickerBlockH + belowTitle, …)` schiacciava a 0
      // il titolo dei post senza punti/sottotitolo, forzando sempre il corpo
      // minimo: per questo il titolo sembrava non crescere mai.
      maxBottom: contentHeight,
      firstBaseline: kickerBlockH + Math.round(size * TITLE_SIZE_RATIO * 1.05),
      baseFontSize: Math.round(size * TITLE_SIZE_RATIO),
      baseStep: Math.round(size * TITLE_SIZE_RATIO * TITLE_STEP_RATIO),
      minFontSize: Math.round(size * TITLE_MIN_SIZE_RATIO),
    });
    const titleBlockH =
      titleLayout.firstBaseline +
      Math.max(0, titleLayout.lines.length - 1) * titleLayout.step +
      Math.round(titleLayout.fontSize * TITLE_DESCENT_RATIO);

    return {
      points: pointsLayout,
      title: titleLayout,
      rows,
      contentHeight:
        titleBlockH + titleGap + belowTitle + subtitleTrailing + commercialTrailing,
    };
  };

  /**
   * Il tentativo che vince: prima il corpo dei punti, poi le righe dell'offerta.
   *
   * L'ordine è una dichiarazione di priorità. I punti non si toccano mai; si
   * restringono fino al minimo leggibile. Poi si accorciano le righe
   * commerciali, che sono dati dell'offerta già letti dall'utente e presenti
   * nei metadata. Il titolo si restringe in tutti i tentativi, perché è
   * l'unico dei tre di cui si può perdere una riga senza perdere un'informazione.
   *
   * L'ultimo tentativo è sempre quello più piccolo: se nemmeno così il blocco
   * entra, si stampa lo stesso. La card potrebbe allora eccedere il limite
   * alto di qualche pixel, che è un difetto di resa; togliere il terzo consiglio
   * sarebbe un difetto di contenuto.
   */
  const rowLimits = hasPoints
    ? rangeDown(MAX_COMMERCIAL_WITH_POINTS, MIN_COMMERCIAL_WITH_POINTS)
    : [Number.MAX_SAFE_INTEGER];
  const fontSizes = hasPoints ? pointFontSizes(size) : [Math.round(size * POINT_SIZE_RATIO)];

  let fitted = fit(fontSizes[0], rowLimits[0]);
  fitting: for (const pointFontSize of fontSizes) {
    for (const rowsLimit of rowLimits) {
      const attempt = fit(pointFontSize, rowsLimit);
      fitted = attempt;
      if (attempt.contentHeight <= maxContentHeight) break fitting;
    }
  }

  const points = fitted.points;
  const titleLayout = fitted.title;
  const commercialRows = fitted.rows;

  // La card è alta quanto il suo contenuto e larga quanto il testo richiede,
  // con un minimo e un massimo: sotto il minimo il titolo andrebbe a capo
  // troppo presto, sopra il massimo sembrerebbe una didascalia.
  const titleWidthPx = Math.max(
    ...titleLayout.lines.map((line) => textWidth(line, titleLayout.fontSize, true)),
    1
  );
  const kickerWidthPx = kicker
    ? textWidth(kicker.toUpperCase(), kickerSize, true) * 1.12 +
      kickerTracking * kicker.toUpperCase().length
    : 0;
  // I punti sono testi lunghi: se la card fosse larga quanto il titolo, andrebbero
  // a capo tre volte per punto e la gerarchia si appiattirebbe. La larghezza
  // della card è quindi almeno quella che i punti richiedono per non essere
  // spezzati più di una volta.
  const pointsWidthPx = points.points.length
    ? Math.max(...points.points.map((point) => textWidth(point.lines[0], points.fontSize, false)))
    : 0;
  const contentWidth = Math.max(
    titleWidthPx,
    kickerWidthPx,
    pointsWidthPx,
    // La larghezza minima per il listino serve solo quando ci sono righe
    // commerciali: un titolo da solo deve stringere la card al proprio testo,
    // un listino no (le etichette lunghe vanno a capo male in una card stretta).
    commercialRows.length > 0 ? textWidth("MMM", Math.round(size * 0.029), true) * 12 : 0
  );

  const card = cardBox({
    size,
    canvasHeight: height,
    contentWidth,
    contentHeight: fitted.contentHeight,
    hasSubtitle: Boolean(subtitle),
    hasCommercial: commercialRows.length > 0,
    hasPoints: points.points.length > 0,
  });

  // Il badge della rubrica, con la sua pill già dimensionata sul testo.
  // La larghezza usa i glifi in grassetto perché il badge è weight 600, e una
  // riserva del 12%: la macchina di rasterizzazione può non avere Arial e
  // ricadere su un font metricamente più largo (DejaVu), e una pill più stretta
  // del testo sembrerebbe un errore di layout.
  const kickerBox = kicker
    ? (() => {
        const label = kicker.toUpperCase();
        const textPx = textWidth(label, kickerSize, true) * 1.12 + kickerTracking * label.length;
        return {
          label,
          fontSize: kickerSize,
          tracking: kickerTracking,
          pillW: Math.ceil(textPx + Math.round(size * 0.056)),
          pillH: Math.round(kickerSize * 2.2),
        };
      })()
    : null;

  // Il marchio sta SOTTO il banner del gancio, centrato orizzontalmente. Il
  // logo file ha la precedenza; quando manca, il wordmark con il nome
  // dell'agenzia prende lo stesso posto, così ogni post esce con il marchio di
  // chi lo ha prodotto. Nessun segno viene inventato: i due casi hanno una sola
  // sorgente ciascuno.
  let brandOverlay: OverlayOptions | null = null;
  let brandMark: BrandMarkKind | null = null;
  if (input.brandLogo && input.brandLogo.buffer.length > 0) {
    const resized = await sharp(input.brandLogo.buffer)
      .resize({ height: Math.round(size * LOGO_HEIGHT_RATIO), fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    // La larghezza va letta dai metadati: dai byte del buffer si metterebbe il
    // logo fuori dal bordo, e un'immagine di terzi appena un po' larga
    // finirebbe tagliata a metà.
    const meta = await sharp(resized).metadata();
    const logoHeight = Math.round(size * LOGO_HEIGHT_RATIO);
    const logoWidth = Math.max(1, Math.min(Math.round(size * 0.35), meta.width ?? logoHeight));
    brandOverlay = {
      input: resized,
      left: Math.round((size - logoWidth) / 2),
      top: height - logoHeight - Math.round(size * LOGO_BOTTOM_MARGIN_RATIO),
    };
    brandMark = "logo";
  } else {
    const wordmark = await brandWordmarkOverlay({
      size,
      height,
      name: input.brandName ?? "",
    });
    if (wordmark) {
      brandOverlay = wordmark.overlay;
      brandMark = "wordmark";
    }
  }

  const overlay = buildOverlay({
    size,
    height,
    title: titleLayout,
    kicker: kickerBox,
    subtitle,
    commercial: commercialRows,
    points,
    card,
    rowHeight,
    subtitleH,
    accent: accentForTitle(title),
  });

  // Il marchio entra con un secondo overlay: l'SVG del testo non deve conoscerlo,
  // così il layout testuale resta identico con logo, con wordmark e senza.
  const overlays: OverlayOptions[] = [
    { input: Buffer.from(overlay, "utf8"), top: 0, left: 0 },
  ];
  // Il gancio vive al centro: un overlay a sé, così la card e il titolo non
  // devono conoscerlo e il layout resta identico con o senza testo.
  const calloutSvg = buildCallout({ size, height, text: input.callout });
  if (calloutSvg) overlays.push({ input: Buffer.from(calloutSvg, "utf8"), top: 0, left: 0 });
  if (brandOverlay) overlays.push(brandOverlay);

  const resized = await sharp(input.photo)
    // `cover` ritaglia il lato longer per riempire SEMPRE l'intero fotogramma:
    // senza questo vincolo una foto più piccola del target resterebbe centrata
    // su uno sfondo nero (bande ai lati) e il logo/le scritte finirebbero a
    // metà tra la foto e il bordo. Un modesto ingrandimento (le foto Pixabay
    // verticali arrivano a ~1280px) è preferibile alle bande nere.
    .resize(size, height, { fit: "cover", position: "attention" })
    .toBuffer();

  const meta = await sharp(resized).metadata();
  const resizedWidth = meta.width ?? size;
  const resizedHeight = meta.height ?? height;

  // Se la foto era più piccola del target, il resize non l'ingrandisce: serve
  // un canvas di sfondo alle dimensioni corrette per poter compositare l'overlay.
  let baseImage: Buffer = resized;
  if (resizedWidth < size || resizedHeight < height) {
    const left = Math.floor((size - resizedWidth) / 2);
    const top = Math.floor((height - resizedHeight) / 2);
    baseImage = await sharp({
      create: { width: size, height: height, channels: 3, background: "#000000" },
    })
      .composite([{ input: resized, left, top }])
      // Il canvas nasce da `create`, cioè senza un formato di lettura: senza
      // un formato esplicito `toBuffer` non ha nulla da scrivere e il buffer
      // di riserva resterebbe indecodificabile a valle.
      .png()
      .toBuffer();
  }

  const buffer = await sharp(baseImage)
    .composite(overlays)
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();

  const slug = (input.extraction.destination || "creativita")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  return {
    buffer,
    mimeType: "image/jpeg",
    filename: `social-${slug || "creativita"}-${input.extraction.proposalId.slice(-6)}.jpg`,
    width: size,
    height: height,
    commercialLines: commercialRows,
    printedPoints: points.points.map((point) => point.lines.join(" ")),
    hasBrandLogo: brandMark !== null,
    brandMark,
    kicker,
  };
}

/** Il testo commerciale stampato, per i test e per l'audit. */
export { commercialText };
