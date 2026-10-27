/**
 * La rubrica stampata sul fotogramma, per formato editoriale.
 *
 * Il formato dice che tipo di post si sta scrivendo, ma finora quella scelta non
 * arrivava al template: il fotogramma mostrava solo il nome della destinazione,
 * e un post di consigli si leggeva esattamente come un hero di un luogo. Non è
 * una differenza di contenuto, è una differenza di **struttura**: chi legge deve
 * capire dal primo sguardo se sta guardando un consiglio o una vetrina.
 *
 * ## Perché una rubrica e non un titolo diverso
 *
 * Il titolo resta il nome del luogo, perché è il dato reale e verificabile, e
 * perché rimpiazzarlo con del testo generato dall'agente significherebbe stampare
 * qualcosa che nessuno ha verificato. La rubrica è un'etichetta di formato: non
 * inventa contenuto, dichiara solo a che cosa serve il contenuto. Il risultato è
 * che "Consigli di viaggio · Maldive" dice cosa sta dicendo il post, mentre
 * "Maldive" da solo dice solo dove.
 *
 * ## Perché tutti e cinque
 *
 * La rubrica vale per ogni formato, perché ogni formato promette qualcosa che il
 * fotogramma non mostra: una domanda, un itinerario, tre consigli, un'offerta.
 * Senza l'etichetta, due post sulla stessa destinazione con la stessa foto sono
 * indistinguibili, e non si capisce quale sia quello giusto da leggere. Con
 * l'etichetta, il fotogramma dichiara il formato prima che il lettore legga una
 * parola, ed è lo stesso formato che la caption usa per strutturarsi.
 *
 * Le etichette sono brevi di proposito: entrano in una pill sopra il titolo, e
 * un'etichetta che va a capo non distingue più niente.
 */

/**
 * I formati editoriali dei post. Il tipo vive qui (e non più nel modulo
 * catalogo, ora rimosso) perché la rubrichetta di formato ne è l'unico
 * consumatore rimasto nel flusso dei post.
 */
export type ContentFormat =
  | "HERO_DESTINATION"
  | "TRAVEL_TIPS"
  | "ITINERARY"
  | "OFFER"
  | "FAQ";

/**
 * Occhiello per formato, o `null` se il formato non ne ha bisogno.
 *
 * Un formato senza voce qui non è un errore, ma va pensato: senza rubrica chi
 * legge deve scoprire dal titolo di che post si tratta, e per i formati in cui
 * il titolo è già la domanda o il luogo, la rubrica è ciò che rende il
 * fotogramma leggibile a colpo d'occhio.
 */
const KICKER_BY_FORMAT: Partial<Record<ContentFormat, string>> = {
  // HERO_DESTINATION non ha occhiello: un post "vetrina" deve mostrare SOLO il
  // nome della destinazione, e "La destinazione" sopra il nome è una formula
  // che non aggiunge nulla.
  TRAVEL_TIPS: "Consigli di viaggio",
  ITINERARY: "Itinerario",
  OFFER: "L'offerta",
  FAQ: "Domande frequenti",
};

/**
 * L'occhiello per un formato, normalizzato sul nome che arriva dal modello.
 *
 * Il formato può arrivare come stringa libera dal tool, quindi il confronto è
 * tollerante: un formato sconosciuto non genera un'etichetta inventata, resta
 * semplicemente senza occhiello.
 */
export function kickerForFormat(format: string | null | undefined): string | null {
  const normalized = (format ?? "").trim().toUpperCase();
  if (!normalized) return null;
  return KICKER_BY_FORMAT[normalized as ContentFormat] ?? null;
}

/**
 * Il testo che il fotogramma deve mostrare per un formato.
 *
 * È la rubrica più il nome del luogo, nell'ordine in cui vengono letti. Serve ai
 * chiamanti che devono dichiarare o verificare il testo stampato senza passare
 * dal renderer.
 *
 * Il nome del luogo c'è sempre: è l'unica parte del testo che il template non
 * può fare a meno di stampare, e la rubrica è ciò che gli dà un contesto.
 */
export function frameHeadlineFor(format: string | null | undefined, place: string): string {
  const kicker = kickerForFormat(format);
  return kicker ? `${kicker} · ${place}` : place;
}
