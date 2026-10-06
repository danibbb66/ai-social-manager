/**
 * Il nome del luogo da stampare in evidenza sul template.
 *
 * Vive in un modulo proprio, senza import, perché è la regola condivisa da
 * tutti i post che stampano un titolo: il post generico (`content-stock`) e il
 * post nato da un'offerta di catalogo (`offer-creative`). Se la regola vivesse
 * dentro uno dei due, l'altro dovrebbe importarlo da lì e i due si
 * richiamerebbero a vicenda.
 */

/**
 * Nome del luogo da stampare in evidenza sul template.
 *
 * Sul post non deve comparire la frase con cui il DRAFT è stato creato, ma il
 * posto di cui parla. Il titolo di un contenuto generico nasce come
 * "Maldive — proposta di viaggio": la parte dopo il trattino è un suffisso
 * editoriale pensato per l'elenco dei contenuti, e sul fotogramma diventa
 * rumido che ripete la stessa formula su ogni post. Qui il suffisso viene
 * tagliato via e resta il nome pulito.
 *
 * Vengono scartate anche le formule di richiesta ("crea un post su Maldive",
 * "proposta di viaggio"): non nominano un luogo, e il template ne ha bisogno per
 * essere leggibile. Se non resta niente di utilizzabile la funzione restituisce
 * stringa vuota e il chiamante decide: meglio un titolo onesto che uno inventato.
 */
export function placeNameFrom(
  destination?: string | null,
  topic?: string | null,
  title?: string | null
): string {
  // La destinazione viene pulita come gli altri candidati, non accettata grezza.
  // Il modello la riempiendola spesso, e "Travel tips Formentera" arrivava al
  // motore dei contenuti come se fosse un posto: nessuna voce della base di
  // conoscenza corrispondeva, e il post ripiegava sui dati del catalogo losingo
  // i consigli e le tappe vere di Formentera. La precedenza resta sulla
  // destinazione, ma ora anche lei viene ripulita.
  for (const candidate of [destination, topic, title]) {
    const name = cleanPlaceName(candidate);
    if (name) return name;
  }
  return "";
}

/**
 * Il nome del luogo dentro una stringa di richiesta.
 *
 * Toglie il formato editoriale scritto in chiaro, ovunque compaia: davanti
 * ("Travel tips Formentera", "proposta di viaggio Rodi"), dentro ("Formentera —
 * Consigli di viaggio") o in coda ("Mallorca itinerario"). Restano le parole che
 * compongono il nome, quindi "Isola d'Elba" resta "Isola d'Elba" e non diventa
 * "d'Elba".
 *
 * Se dopo aver tolto le formule non resta niente — il topic era solo "proposta di
 * viaggio" — restituisce stringa vuota. Il chiamante allora non compone nulla:
 * meglio un post senza titolo stampato che un titolo inventato.
 */
export function cleanPlaceName(value?: string | null): string {
  const text = (value ?? "").trim();
  if (!text) return "";

  // Sufficio editoriale dopo un trattino: "Maldive — proposta di viaggio".
  const dash = text.search(/\s+[—–-]\s+/);
  const head = (dash > 0 ? text.slice(0, dash) : text).trim();
  if (!head) return "";

  const words = head.split(/\s+/).filter(Boolean);

  // Si tolgo le parole editoriali solo alle due estremità, non in mezzo.
  //
  // La ragione è che un articolo o una preposizione dentro un nome sono parte
  // del nome: "San Vito Lo Capo" diventava "San Vito Capo", che non è un posto
  // che esiste. Le formule di richiesta stanno invece all'inizio ("crea un
  // post su Maldive", "travel tips Formentera") o alla fine ("Mallorca
  // itinerario"), e in quelle posizioni vengono tolte finché rimane qualcosa.
  while (words.length > 1 && PLACE_NAME_STOP_WORDS.has(stemOf(words[0]))) words.shift();
  while (words.length > 1 && PLACE_NAME_STOP_WORDS.has(stemOf(words[words.length - 1]))) {
    words.pop();
  }

  // Se è rimasto solo un pezzo di formula ("proposta di viaggio" lascia
  // "viaggio"), non è un luogo: meglio stringa vuota che un titolo che è una
  // parola della rubrica. Con due parole o più, invece, è un nome.
  if (words.length === 1 && PLACE_NAME_STOP_WORDS.has(stemOf(words[0]))) return "";

  return clampPlaceName(normalizeCase(words.join(" ")));
}

/**
 * Riporta il nome a una forma stampabile.
 *
 * Solo quando l'intera stringa è in maiuscolo: in quel caso il maiuscolo non
 * porta informazione — è come l'utente lo ha digitato, o come è arrivato da un
 * catalogo — e "TRAVEL TIPS FORMENTERA" ripulito diventerebbe "FORMENTERA" sul
 * fotogramma. Una stringa in minuscolo o in CamelCase viene lasciata com'è,
 * perché lì il maiuscolo è parte del nome.
 */
function normalizeCase(value: string): string {
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0 || letters !== letters.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/** Minuscolizza e toglie la punteggiatura, per confrontare le parole alle stop list. */
function stemOf(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Parole che descrivono la richiesta, non il luogo. */
const PLACE_NAME_STOP_WORDS = new Set([
  "proposta",
  "viaggio",
  "viaggi",
  "post",
  "reel",
  "storia",
  "carosello",
  "contenuto",
  "contenuti",
  "bozza",
  "bozze",
  "immagine",
  "immagini",
  "visual",
  "foto",
  "crea",
  "creami",
  "prepara",
  "scrivi",
  "scrivimi",
  "su",
  "sulla",
  "della",
  "delle",
  "dello",
  "dei",
  "degli",
  "della",
  "per",
  "una",
  "uno",
  "la",
  "il",
  "lo",
  "i",
  "gli",
  "le",
  "un",
  "di",
  "del",
  "da",
  "con",
  "e",
  "a",
  "in",
  "sul",
  "sui",
  "al",
  // Il formato editoriale scritto in chiaro. "travel tips Formentera",
  // "itinerario Creta", "proposta di viaggio Rodi": sono tutti la stessa
  // richiesta, e senza questa lista il motore dei contenuti riceveva
  // "travel tips Formentera" come se fosse un posto. Il nome del luogo non
  // corrispondeva a nessuna voce della base di conoscenza, quindi il post
  // ripiegava sui dati del catalogo e perdeva consigli e tappe vere.
  "travel",
  "tip",
  "tips",
  "itinerary",
  "itinerario",
  "itinerari",
  "consigli",
  "guida",
  "guide",
  "hero",
  "destination",
  "storia",
  "racconto",
  "ispirazione",
  "inspiration",
  "faq",
  "domande",
  "frequenti",
  "offer",
  "offerta",
  "offerte",
  "storytelling",
  "con",
  "spiaggia",
  "spiagge",
  "mare",
  "viaggio",
]);

/** Il nome stampato non può essere più lungo di due righe del template. */
const PLACE_NAME_MAX = 48;

function clampPlaceName(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= PLACE_NAME_MAX) return text;
  const cut = text.slice(0, PLACE_NAME_MAX);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > PLACE_NAME_MAX / 2 ? cut.slice(0, boundary) : cut).trim();
}
