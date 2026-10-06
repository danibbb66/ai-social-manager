/**
 * Soldi e date, scritti come li scrive un'agenzia di viaggi italiana.
 *
 * Vive in un modulo proprio perché ne hanno bisogno due consumatori che
 * altrimenti lo farebbero in modo diverso: le righe commerciali stampate sul
 * fotogramma (`commercialLines`) e la copy dei post (`catalog-content`). Un
 * fotogramma che dice "890 EUR" e una caption che dicono "890 €" sono due
 * versioni dello stesso dato, e due versioni divergono alla prima correzione.
 *
 * ## Due regole, e perché sono regole
 *
 * **Il prezzo si scrive in euro, non in codice.** "890 EUR" è come la colonna
 * del catalogo tiene il dato, non come un prezzo si legge: il simbolo sta
 * davanti o dopo il numero e non tradotto. La valuta che il catalogo non
 * dichiara non viene inventata: un prezzo senza valuta resta senza valuta.
 *
 * **La data si scrive in italiano, non in ISO.** "2026-09-12" è un valore di
 * database, non una data che si possa pronunciare in un post; sul fotogramma
 * si legge "12-19 Settembre", che è ciò che il lettore cerca. L'anno resta
 * nei metadati e nell'estrazione: sul fotogramma serve il giorno e il mese,
 * perché sono quelli su cui si decide di partire.
 *
 * La formattazione è pura e senza fuso orario: le date arrivano come
 * `YYYY-MM-DD` e vengono spezzate sul posto, mai passate da `new Date(...)` e
 * `toLocaleDateString`. Su un server in fuso diverso dal posto del viaggio
 * quella strada sposta la data di un giorno e stampa "11 Settembre" per un
 * viaggio che parte il 12.
 */

/** Mesi in italiano, con l'iniziale maiuscola come li scrive un calendario. */
const MONTHS = [
  "Gennaio",
  "Febbraio",
  "Marzo",
  "Aprile",
  "Maggio",
  "Giugno",
  "Luglio",
  "Agosto",
  "Settembre",
  "Ottobre",
  "Novembre",
  "Dicembre",
] as const;

/**
 * Codici valuta che il catalogo usa per l'euro.
 *
 * Non serve una tabella completa delle valute: l'unica conversione che
 * dichiariamo è quella che il nostro catalogo contiene davvero, perché un
 * simbolo inventato per una valuta che non si conosce è peggio del codice.
 */
const EURO_CODES = new Set(["eur", "euro", "€", "eur."]);

interface DateParts {
  day: number;
  month: number;
  year: number;
}

/** Spezza `YYYY-MM-DD` — anche con suffisso orario — senza passar da `Date`. */
function parseIsoDay(value: string | Date | null | undefined): DateParts | null {
  if (!value) return null;
  const text = typeof value === "string" ? value : value.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month, year };
}

function monthName(month: number): string {
  return MONTHS[month - 1];
}

/**
 * Il giorno di una data, come intero positivo.
 *
 * La data non è formattata qui: è un pezzo di un intervallo e va composto
 * con l'altra estremità. Restituisce `null` invece di una data approssimata,
 * perché una data inventata su un fotogramma è indistinguibile da quella vera.
 */
export function formatDay(value: string | Date | null | undefined): string | null {
  const parts = parseIsoDay(value);
  return parts ? String(parts.day) : null;
}

/** "12 Settembre": la data singola, per quando l'intervallo non c'è. */
export function formatDateLabel(value: string | Date | null | undefined): string | null {
  const parts = parseIsoDay(value);
  return parts ? `${parts.day} ${monthName(parts.month)}` : null;
}

/**
 * L'intervallo di partenza, come lo legge chi prenota.
 *
 * Nello stesso mese l'anno si omette, perché "12-19 Settembre" è già tutto ciò
 * che serve per decidere e l'anno aggiunto solo ruberebbe spazio: "12-19
 * Settembre 2026" occupa una riga in più sul fotogramma. Su mesi diversi i
 * due estremi portano il proprio mese, e su anni diversi anche l'anno.
 */
export function formatDateRange(
  from: string | Date | null | undefined,
  to?: string | Date | null
): string | null {
  const start = parseIsoDay(from);
  if (!start) return null;
  const end = parseIsoDay(to ?? null);

  if (!end) return `${start.day} ${monthName(start.month)}`;
  if (start.month === end.month && start.year === end.year) {
    return `${start.day}-${end.day} ${monthName(start.month)}`;
  }
  const endYear = end.year !== start.year ? ` ${end.year}` : "";
  return (
    `${start.day} ${monthName(start.month)} - ` +
    `${end.day} ${monthName(end.month)}${endYear}`
  );
}

/**
 * Il simbolo della valuta, o `null` se il catalogo non la dichiara.
 *
 * `null` non è un difetto: è l'assenza di un dato. Un prezzo in una valuta
 * non dichiarata resta senza simbolo invece di diventare euro per abitudine.
 */
export function currencySymbol(currency: string | null | undefined): string | null {
  const code = (currency ?? "").trim();
  if (!code) return null;
  if (EURO_CODES.has(code.toLowerCase())) return "€";
  return code;
}

/** "890 €": il numero con il separatore delle migliaia italiano e la valuta. */
export function formatMoney(
  value: number,
  currency?: string | null
): string | null {
  if (!Number.isFinite(value)) return null;
  const amount = new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
  const symbol = currencySymbol(currency);
  return symbol ? `${amount} ${symbol}` : amount;
}

/**
 * Il prezzo stampato: un numero, o l'intervallo che la proposta dichiara.
 *
 * "890 €" e "890 – 1.290 €". La valuta si stampa una volta sola: metterla
 * accanto a ogni estremo fa "890 € – 1.290 €", che sembra che il secondo
 * numero sia in un'altra valuta.
 */
export function formatPriceRange(
  from: number | null | undefined,
  to?: number | null,
  currency?: string | null
): string | null {
  const hasFrom = typeof from === "number" && Number.isFinite(from);
  const hasTo = typeof to === "number" && Number.isFinite(to);
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom) return formatMoney(to as number, currency);
  if (hasTo && to !== from) {
    return `${formatMoney(from, currency)} – ${formatMoney(to as number, currency)}`;
  }
  return formatMoney(from, currency);
}