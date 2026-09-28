/**
 * Utilità di confronto testuale per il Catalogo.
 *
 * Il confronto serve a due scopi: trovare una destinazione che l'utente scrive
 * a mano ("rodi", "Rodì", "RODI") e deduplicare i token per gli hashtag.
 *
 * SQLite non supporta il confronto case-insensitive di Prisma
 * (`mode: "insensitive"`): normalizzare qui rende il comportamento identico
 * su ogni database e testabile come funzione pura.
 */

/** Minuscole, senza diacritici, spazi compattati. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token significativi di una ricerca libera.
 *
 * Sotto i 3 caratteri i token sono troppo ambigui ("ny", "re") e produrrebbero
 * falsi positivi: in quel caso il chiamante deve ripiegare sul confronto per
 * sottostringa.
 */
export function matchTokens(value: string): string[] {
  return normalizeForMatch(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

/** Tutti i token della ricerca devono comparire nel testo indicato. */
export function textMatchesQuery(haystack: string, query: string): boolean {
  const hay = normalizeForMatch(haystack);
  const tokens = matchTokens(query);
  if (tokens.length === 0) {
    const needle = normalizeForMatch(query);
    return needle.length > 0 && hay.includes(needle);
  }
  return tokens.every((token) => hay.includes(token));
}
