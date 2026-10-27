import { formatDateRange, formatPriceRange } from "@/lib/catalog/commercial-format";

/**
 * Dati commerciali di una creatività, quando ci sono.
 *
 * Regola che governa tutto il file: **un campo vale solo se esiste una prova
 * nella fonte**. Se il dato non c'è, il campo è `null` e non viene stampato.
 * Non esiste un percorso che stima, deduce o completa un dato commerciale.
 *
 * Il flusso dei post generici non attinge più al catalogo fornitore: qui resta
 * solo la *forma* dei dati commerciali (il tipo) e il modo in cui si stampano
 * sul fotogramma (`commercialLines`). Nessun valore viene estratto, letto o
 * inventato al di fuori di ciò che il chiamante passa esplicitamente.
 */

/** Come i dati commerciali sono arrivati. */
export const COMMERCIAL_EXTRACTION_METHOD = "catalog-record" as const;

export type CommercialExtractionMethod = typeof COMMERCIAL_EXTRACTION_METHOD;

/** Un dato commerciale e la prova da cui viene. */
export type ExtractedField<T = string | number | null> = {
  field: string;
  value: T;
  /** Campo o letterale della fonte da cui è stato preso. */
  from: string;
  kind: "CATALOG_FIELD" | "LITERAL_MATCH";
};

export interface CommercialExtraction {
  proposalId: string;
  destination: string | null;
  title: string;
  price: number | null;
  priceTo: number | null;
  currency: string | null;
  departureCity: string | null;
  departureDate: string | null;
  returnDate: string | null;
  duration: string | null;
  accommodation: string | null;
  board: string | null;
  transport: string | null;
  sourceImageUrl: string;
  sourceImageId: string | null;
  sourceImageFilename: string | null;
  extractionMethod: CommercialExtractionMethod;
  extractedFields: ExtractedField[];
  /** 0 = nessun dato commerciale trovato. */
  confidence: number;
  warnings: string[];
}

/**
 * Righe commerciali da stampare sulla creatività, nell'ordine in cui un lettore
 * le cerca: prima quanto costa, poi quando parte, poi da dove, poi cosa include.
 *
 * Una riga esiste solo se il dato esiste: non c'è un segnaposto ("prezzi su
 * richiesta") perché sarebbe un dato commerciale inventato travestito da testo.
 *
 * Soldi e date sono già in italiano: il prezzo è in euro ("890 €") e la
 * partenza è "12-19 Settembre". Le funzioni sono in `commercial-format` perché
 * la caption dei post e il fotogramma dicano lo stesso numero nello stesso modo.
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
