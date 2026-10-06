/**
 * La grafica del distributore non entra in un nostro post.
 *
 * ## Il problema
 *
 * La locandina che l'agenzia pubblica in `/offerte/` è un materiale promozionale
 * di terzi: ci sono il marchio dell'operatore o del grossista, il loro
 * impianto grafico e il loro testo promozionale. Quella locandina entra nel
 * catalogo per una ragione sola — sapere da dove arrivano i dati dell'offerta —
 * e da quel momento nessuna parte di essa deve più comparire su un post.
 *
 * Il caso reale che questo file chiude è il titolo. Un titolo come
 * "Veratour – Rodi" o "Rodi con Bravifondo" non è un luogo: è il nome di un
 * distributore attaccato al nome di un luogo. Se quel titolo viene derivato
 * come destinazione, finisce stampato in grande sul fotogramma con il logo di
 * chi non siamo — ed è esattamente la riga di locandina che si voleva evitare.
 *
 * ## Cosa fa, e cosa non fa
 *
 * Toglie i **nomi** del distributore da un testo che già esiste. Non legge
 * l'immagine, non ne riconosce il logo e non indovina: se non trova un nome
 * noto, il testo passa intatto, perché un titolo che non contiene marchi è un
 * titolo che va usato così com'è.
 *
 * Se la rimozione lascia un testo vuoto la funzione restituisce `null`: è la
 * risposta onesta per "di questo titolo non c'è più niente di utilizzabile", e
 * il chiamante registra un'anomalia per la revisione umana invece di stampare
 * un nome di distributore.
 */

/**
 * Nomi di distributori, operatori e grossisti.
 *
 * Sono solo nomi che non possono essere un luogo: se un elenco contenesse
 * "Parigi" o "Rodi", la funzione cancellerebbe destinazioni vere, e il danno
 * sarebbe ben maggiore del problema che risolve. Per questo qui ci sono
 * marchi del canale vendita, non quelli del catalogo turistico.
 *
 * La lista è dichiarata e non dedotta: aggiungere un nome è una scelta, si
 * vede nella diff e si può discutere. È il posto giusto per i nomi che arrivano
 * dai cataloghi di terzi.
 */
export const DISTRIBUTOR_BRAND_TOKENS: readonly string[] = [
  // Operatori e tour operator del canale agenzie.
  "veratour",
  "alpitour",
  "bravifondo",
  "italiatour",
  "mystical island",
  "mistral",
  "orizzonti",
  "vacanze italia",
  "italy shore",
  "oggi tour",
  "nicolaus",
  "grange facade",
  "villa deste",
  "happy euro",
  "eurovips",
  "king holidays",
  "santandrea",
  "travel incoming",
  "incoming",
  "linea blu",
  "viaggi del ventaglio",
  "i viaggi del ventaglio",
  "cambio",
  "salamander",
  "nobita",
  "trinity",
  // Sigle e forme brevi del canale.
  "s&s",
  "s s",
  "bt&",
  "by rc",
  // Parole che descrivono il materiale promozionale, non il viaggio.
  "locandina",
  "brochure",
  "depliant",
  "volantino",
  "catalogo",
];

/**
 * Marchi brevi con simboli, tolti prima di spezzare in parole.
 *
 * Vanno qui e non nella lista token perché `&` e `.` non sono lettere: dopo la
 * normalizzazione diventano spazi e il nome si frammenta in parole senza
 * significato ("S" "S"), che il confronto per token non riconoscerebbe.
 *
 * Il sorgente è dichiarato e l'espressione viene ricostruita a ogni uso: una
 * regex con il flag `g` conserva il punto in cui si è fermata fra una chiamata
 * e l'altra, e due confronti consecutivi sullo stesso testo darebbero risposte
 * diverse.
 */
const SYMBOL_BRAND_SOURCE = "(?:by\\s+rc|s\\s*&\\s*s|bt\\s*&)";

function symbolBrandPattern(): RegExp {
  return new RegExp(`\\b${SYMBOL_BRAND_SOURCE}\\b`, "gi");
}

/** Token già normalizzati: maiuscole e accenti non possono creare una voce nuova. */
const NORMALIZED_BRANDS: ReadonlySet<string> = new Set(
  DISTRIBUTOR_BRAND_TOKENS.map((token) => normalizeToken(token))
);

/** Minuscole, senza diacritici, spazi compattati: la chiave del confronto. */
function normalizeToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `true` se il testo nomina un distributore o descrive materiale promozionale. */
export function hasDistributorBranding(value: string | null | undefined): boolean {
  if (!value) return false;
  if (symbolBrandPattern().test(value)) return true;
  return value
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .some((token) => token.length > 0 && NORMALIZED_BRANDS.has(token));
}

/**
 * Il testo senza i nomi del distributore.
 *
 * Se il testo è già pulito torna identico, carattere per carattere: la funzione
 * non normalizza e non riscrive, perché un titolo che non contiene marchi va
 * usato esattamente come è stato pubblicato. Cambia qualcosa solo quando trova
 * qualcosa da togliere.
 */
export function stripDistributorBranding(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const withoutSymbols = text.replace(symbolBrandPattern(), " ");
  const words = withoutSymbols.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter((word) => !NORMALIZED_BRANDS.has(normalizeToken(word)));
  if (kept.length === words.length) return text;
  if (kept.length === 0) return null;

  return kept.join(" ").replace(/\s+/g, " ").trim() || null;
}