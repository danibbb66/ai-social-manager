/**
 * Trasforma il testo grezzo dell'OCR di una locandina in dati strutturati.
 *
 * L'OCR su una locandina grafica è rumoroso (font, bande colorate, testo su
 * foto). Questo parser è deliberatamente difensivo: estrae ciò che riconosce
 * con sicurezza e lascia `null` il resto. Un campo non riconosciuto NON viene
 * inventato e NON finisce sulla locandina rigenerata.
 */

export interface LocandinaHotel {
  /** Nome dell'hotel (es. "HOTEL BARCELONA HOUSE"). */
  name: string;
  /** Stelle (es. 3). */
  stars: number;
  /** Prezzo in euro (es. 349). */
  price: number;
}

export interface ParsedLocandina {
  /** Riga del titolo grande (es. "CITY BREAK"). */
  title: string | null;
  /** Città di partenza ("Voli diretti da Roma" → "Roma"). */
  departure: string | null;
  /** Trattamento (es. "Pernottamento e colazione"). */
  board: string | null;
  /** Numero di notti (es. 3). */
  nights: number | null;
  /** Hotel con stelle e prezzo, nell'ordine in cui appaiono. */
  hotels: LocandinaHotel[];
  /** Testo "INCLUDE". */
  include: string | null;
  /** Testo "NON INCLUDE". */
  exclude: string | null;
}

const MONTH_MATCH =
  "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre";

/** Rimuove il rumore iniziale (caratteri non alfabetici) da un nome OCR. */
function cleanName(raw: string): string {
  return raw
    .replace(/^[^A-Za-zÀ-ÿ]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function parsePrice(raw: string): number | null {
  // Toglie il separatore delle migliaia e gli eventuali centesimi.
  const cleaned = raw.replace(/\./g, "").replace(/,/g, "").replace(/\s/g, "");
  const num = Number.parseInt(cleaned, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Normalizza il testo grezzo OCR mantenendo gli a-capo. */
function normalize(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function parseLocandinaText(rawText: string): ParsedLocandina {
  const text = normalize(rawText);
  const result: ParsedLocandina = {
    title: null,
    departure: null,
    board: null,
    nights: null,
    hotels: [],
    include: null,
    exclude: null,
  };

  const hotelNameRe =
    /([A-Z][A-Z0-9'’\- ]{3,40}?)\s+(\d)\s*\*\s+([\d.,]+)\s*(?:€|©|euro|eur)?/gi;

  for (const line of text.split("\n")) {
    // Hotel: "NOME 3* 349 €"
    let m: RegExpExecArray | null;
    hotelNameRe.lastIndex = 0;
    while ((m = hotelNameRe.exec(line)) !== null) {
      const name = cleanName(m[1]);
      const stars = Number.parseInt(m[2], 10);
      const price = parsePrice(m[3]);
      if (name.length >= 3 && price !== null) {
        result.hotels.push({ name, stars, price });
      }
    }
  }

  // Trattamento.
  const boardMatch = text.match(
    /(pernottamento e colazione|mezza pensione|pensione completa|tutto incluso|all inclusive|full board|half board|colazione)/i
  );
  if (boardMatch) result.board = boardMatch[1].replace(/\s+/g, " ").trim();

  // Notti.
  const nightsMatch = text.match(/(\d+)\s*nott[ie]/i);
  if (nightsMatch) result.nights = Number.parseInt(nightsMatch[1], 10);

  // Partenza: "Voli diretti da Roma".
  const depMatch = text.match(/voli diretti da\s+([A-Za-zÀ-ÿ]+)/i);
  if (depMatch) result.departure = cleanName(depMatch[1]);

  // Il titolo NON si estrae dall'OCR: sulla locandina è su più righe e l'euristica
  // rischia di prendere voci del footer (es. "TASSE ASSISTENZA"). Il titolo
  // arriva dal record di catalogo (`CatalogProposal.name`), non dai pixel.

  // INCLUDE / NON INCLUDE.
  const includeMatch = text.match(/INCLUDE\s*:?\s*([^\n]+)/i);
  if (includeMatch) result.include = includeMatch[1].trim();
  const excludeMatch = text.match(/NON\s+INCLUDE\s*:?\s*([^\n]+)/i);
  if (excludeMatch) result.exclude = excludeMatch[1].trim();

  return result;
}
