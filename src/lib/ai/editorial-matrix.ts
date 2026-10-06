/**
 * Matrice editoriale: che cosa scrive e che cosa stampa ciascuno dei sette
 * formati, a partire dagli stessi dati.
 *
 * ## Perché esiste
 *
 * I sette formati non erano sette pezzi di copy: erano sette nomi. Il titolo
 * era quasi sempre il nome del luogo, la caption era una frase sola e le
 * differenze tra "un consiglio", "un itinerario" e "una domanda frequentissima"
 * sparivano in un unico blocco di prosa. Un post di consigli e un hero sullo
 * stesso posto erano indistinguibili, e il titolo poteva essere anche una
 * formula vuota ("proposta di viaggio", "vacanza in spiaggia"): un titolo che
 * non nomina la destinazione non identifica niente.
 *
 * Qui ogni formato ha invece due output distinti e verificabili:
 *
 *  - **il titolo**, che contiene **sempre** il nome della destinazione, o un
 *    gancio che la contiene. Non esiste un percorso che produca un titolo senza
 *    il luogo: `editorialTitle` non ha un ramo che lo restituisce, e
 *    `isGenericTitle` elenca le formule bandite perché un titolo futuro non
 *    possa reintrodurle;
 *  - **la caption**, che ha la **struttura** del formato: tre consigli per
 *    TRAVEL_TIPS, tappe per ITINERARY, domanda e risposta per FAQ, dati
 *    commerciali in evidenza per OFFER e HERO.
 *
 * ## La regola che non si negozia
 *
 * Un fatto entra nel testo solo se è in `EditorialFacts`. Nessun formato stima un
 * prezzo, una data o una durata che non ci sono: dove il dato manca, la copy
 * dice che il dato va chiesto in agenzia. È la stessa garanzia che il catalogo
 * si dava prima, applicata a tutti e sette i formati invece che a tre.
 *
 * Nessuna chiamata al modello: sono funzioni pure su un insieme di dati già
 * arricchito, quindi lo stesso formato sulla stessa proposta dà sempre lo stesso
 * testo, e il confronto fra due post è possibile.
 */

import { normalizeForMatch } from "@/lib/catalog/text";
import {
  MAX_TRAVEL_POINTS,
  knowledgeFor,
  type KnowledgeSource,
  type PlaceKind,
} from "@/lib/ai/travel-knowledge";

export { MAX_TRAVEL_POINTS, knowledgeFor, type KnowledgeSource, type PlaceKind };

/**
 * I dati editoriali di una proposta, già formattati come frasi.
 *
 * Sono stringhe e non numeri perché ogni formato li usa in modo diverso: il
 * prezzo diventa "Quanto si spende: ...", la durata "Quanto fermarsi: ...",
 * l'itinerario le conta in giorni. Chi forma le stringhe è il chiamante, che ha
 * il DTO; qui dentro non c'è nessuna aritmetica su dati grezzi, solo layout.
 *
 * `nights` è l'unico campo numerico, e serve a una cosa sola: il titolo
 * dell'itinerario deve dire quanti giorni dura il viaggio, e i giorni si
 * contano dalle notti. Senza notti il titolo non inventa giorni.
 */
export interface EditorialFacts {
  price: string | null;
  dates: string | null;
  duration: string | null;
  nights: number | null;
  departureCities: string | null;
  included: string | null;
  excluded: string | null;
}

/**
 * I dati vuoti: il caso di un post generico, senza catalogo e senza offerta.
 *
 * Non è un caso limite da evitare, è metà dei post che il sistema crea. Con
 * questi fatti i formati non si svuotano: cambiano struttura e continuano a
 * dichiarare che cosa non si può sapere senza passare in agenzia.
 */
export const NO_FACTS: EditorialFacts = {
  price: null,
  dates: null,
  duration: null,
  nights: null,
  departureCities: null,
  included: null,
  excluded: null,
};

/**
 * Chiusura di ogni caption.
 *
 * Una call to action che fa il suo lavoro: apre una conversazione e dice che
 * rispondiamo. Non è un rinvio a un altro canale né una scusa per non dire
 * nulla, perché è esattamente quello che un post di un'agenzia deve fare a fine
 * testo.
 *
 * Evitiamo la parola "disponibilità" di proposito: è la stessa che i test usano
 * per riconoscere un prezzo, e una chiusura che contiene una parola commerciale
 * fa leggere come commerciale anche un post che non ha prezzi.
 */
const CTA = "Scrivici e ti rispondiamo in giornata.";

/* ──────────────────────────────────────────────────────────────────────── *
 * Titoli
 * ──────────────────────────────────────────────────────────────────────── */

/** Giorni di viaggio: N notti sono N+1 giorni, se le notti sono note. */
function travelDays(facts: EditorialFacts): number | null {
  return typeof facts.nights === "number" && facts.nights > 0 ? facts.nights + 1 : null;
}

/**
 * Le formule che un titolo non deve mai contenere.
 *
 * Sono le cose che si scrivono quando non si sa niente del posto: dicono
 * "viaggio", non "Formentera". Un titolo fatto così può stare su qualunque
 * post di qualunque agenzia, e su Instagram è indistinguibile dagli altri
 * milioni di post che dicono la stessa identica cosa.
 *
 * Il controllo è applicato in `isGenericTitle` e viene testato, così la lista
 * non resta un commento: aggiungere un titolo nuovo non può reintrodurre una
 * formula senza che un test lo dichiari.
 */
export const GENERIC_TITLE_FORMULAS: readonly string[] = [
  "vacanza in",
  "proposta di viaggio",
  "la nostra proposta",
  "da vivere con calma",
  "pronta fuga",
  "destinazione da sogno",
];

/**
 * Un titolo è generico quando non dice niente del posto.
 *
 * Non basta che non contenga le formule vietate: il criterio vero è che il
 * titolo nomini la destinazione richiesta (o un gancio che la contiene). Questa
 * funzione dichiara il caso più facile da automatizzare, quello delle formule,
 * e `titleNamesPlace` quello che le regge davvero.
 */
export function isGenericTitle(title: string): boolean {
  const text = normalizeForMatch(title ?? "");
  if (!text) return true;
  return GENERIC_TITLE_FORMULAS.some((formula) => text.includes(normalizeForMatch(formula)));
}

/**
 * Il titolo nomina il luogo richiesto.
 *
 * Serve ai chiamanti che devono garantire la regola senza fidarsi
 * dell'ispezione visiva: se il titolo non contiene il luogo, non è un titolo
 * ammissibile per un post su quel luogo.
 */
export function titleNamesPlace(title: string, place: string): boolean {
  const wanted = normalizeForMatch(place ?? "");
  if (!wanted) return false;
  return normalizeForMatch(title ?? "").includes(wanted);
}

/**
 * La domanda principale di una FAQ.
 *
 * Se il luogo è noto, la domanda è una di quelle che un viaggiatore si fa
 * davvero su quel posto — e la risposta, in `editorialCaption`, è la vera. Se il
 * luogo non è noto, la domanda nasce dal dato più forte che c'è: il prezzo, poi
 * le date, poi la durata, poi cosa comprende.
 */
function faqQuestion(place: string, facts: EditorialFacts): string {
  const curated = knowledgeFor(place)?.faqs?.[0];
  if (curated?.question) return curated.question;
  if (facts.price) return `Quanto costa una vacanza a ${place}?`;
  if (facts.dates) return `Quando si parte per ${place}?`;
  if (facts.duration) return `Quante notti si passano a ${place}?`;
  if (facts.included) return `Cosa comprende il viaggio a ${place}?`;
  return `Come si organizza un viaggio a ${place}?`;
}

/**
 * Titolo del post, per formato.
 *
 * Invariante, verificata dai test: il titolo contiene sempre il nome del luogo.
 * Per questo non c'è un ramo che restituisce una stringa generica: dove il
 * formato non ha bisogno di un aggettivo (HERO) il titolo è il luogo, e dove ha
 * bisogno di un angolo (consigli, itinerario, ispirazione, racconto, domanda) il
 * luogo ci resta dentro.
 *
 * Con dati scarsi la struttura si conserva e sparisce solo il numero: un
 * itinerario senza notti non dice "in 6 giorni", dice che il percorso è da
 * definire. Un titolo che inventa una durata è peggio di un titolo povero.
 */
export function editorialTitle(
  format: string,
  place: string,
  facts: EditorialFacts = NO_FACTS
): string {
  const days = travelDays(facts);

  switch (format) {
    case "TRAVEL_TIPS":
      // Il formato promette informazione, quindi il titolo la dichiara e il
      // luogo la identifica: insieme dicono "di cosa parla" e "di chi parla".
      return `${place} — Consigli di viaggio`;
    case "ITINERARY":
      return days
        ? `${place} in ${days} giorni`
        : `${place}: il tuo itinerario, tappa per tappa`;
    case "FAQ":
      // Il titolo è la domanda: è ciò che il lettore sta cercando, e lo rende
      // anche sul fotogramma, dove è la parte più grande.
      return faqQuestion(place, facts);
    case "INSPIRATION":
      return `Il richiamo di ${place}`;
    case "STORYTELLING":
      return `Il viaggio che comincia a ${place}`;
    case "OFFER":
      return facts.price
        ? `${place} · ${facts.price}${facts.dates ? ` · ${facts.dates}` : ""}`
        : `${place}: cosa comprende il viaggio`;
    case "HERO_DESTINATION":
    default:
      // L'hero non ha un aggettivo da aggiungere: il luogo è l'argomento, e
      // aggiungerne uno ("il paradiso di…") sarebbe un giudizio non verificabile.
      return place;
  }
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Caption
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Le tre righe dei consigli.
 *
 * ## L'ordine in cui si cercano
 *
 * Prima la conoscenza del luogo, poi i dati commerciali, e solo se mancano
 * entrambi la struttura del viaggio. È l'ordine della verità: un consiglio su
 * Formentera vale più di un prezzo, perché il prezzo è già nella locandina
 * mentre il consiglio non è da nessuna parte.
 *
 * ## Perché tre, sempre
 *
 * Tre è il numero oltre il quale una lista non si legge, e sono anche i tre
 * punti che il fotogramma stampa dentro la card. Ma il formato dichiara
 * "consigli di viaggio", quindi la lista è la promessa del post: se ne
 * mancasse qualcuno, il titolo prometterebbe informazione e il testo non la
 * darebbe.
 *
 * ## Cosa non può succedere
 *
 * Le tre righe non possono essere tre formule di servizio. "Le date le conferma
 * l'agenzia" non è un consiglio: è un'assenza di consiglio travestita da
 * informazione, e su un post di consigli è la cosa peggiore che si possa
 * scrivere. Quindi le righe mancanti si riempiono con la conoscenza del luogo e,
 * in ultima istanza, con la struttura del viaggio, che è vera per qualunque
 * destinazione.
 */
function travelTipLines(place: string, facts: EditorialFacts): string[] {
  const knowledge = knowledgeFor(place);

  const fromKnowledge = (knowledge?.tips ?? [])
    .filter((tip) => tip.trim().length > 0)
    .map((tip) => tip.trim());
  if (fromKnowledge.length >= MAX_TRAVEL_POINTS) {
    return fromKnowledge.slice(0, MAX_TRAVEL_POINTS);
  }

  // Dal catalogo: i dati che l'utente ha già visto nell'offerta, detti nel
  // formato dell'informazione, non del listino.
  const fromFacts: string[] = [];
  if (facts.dates) fromFacts.push(`Quando partire: ${facts.dates}.`);
  if (facts.price) fromFacts.push(`Quanto si spende: ${facts.price}.`);
  if (facts.duration) fromFacts.push(`Quanto fermarsi: ${facts.duration}.`);
  if (facts.departureCities) fromFacts.push(`Da dove partire: ${facts.departureCities}.`);
  if (facts.included) fromFacts.push(`Cosa comprende: ${facts.included}.`);

  const lines = [...fromKnowledge, ...fromFacts];
  if (lines.length >= MAX_TRAVEL_POINTS) return lines.slice(0, MAX_TRAVEL_POINTS);

  // Ultimo gradino, e vale per qualunque viaggio: la struttura della giornata
  // di arrivo. È un consiglio vero, non un rinvio.
  for (const fallback of tripStructureTips(place)) {
    if (lines.length >= MAX_TRAVEL_POINTS) break;
    lines.push(fallback);
  }
  return lines.slice(0, MAX_TRAVEL_POINTS);
}

/**
 * Consigli che valgono per qualunque viaggio, usati solo quando non c'è né
 * conoscenza del luogo né dato di catalogo.
 *
 * Sono veri dappertutto — il primo giorno è sempre il più corto, l'ultimo è
 * quello del ritiro — e non contengono nessuna affermazione sul posto. Il
 * punto è che restano informazione: un post di consigli deve insegnare qualcosa,
 * e se non può insegnare la destinazione insegna il viaggio.
 */
function tripStructureTips(place: string): string[] {
  return [
    `Il primo giorno a ${place} è il più corto di tutto il viaggio: meglio arrivare e orientarsi che programmare.`,
    `Le giornate centrali sono quelle che si riempiono: le tappe le scegli quando sei già sul posto.`,
    `L'ultimo giorno meglio tenerlo libero: è quello del ritiro, e finisce sempre piu tardi di quanto sembri.`,
  ];
}

/**
 * Le tappe dell'itinerario.
 *
 * Prima le tappe vere del luogo, che sono il motivo per cui un itinerario
 * esiste; poi, se il catalogo ha date e partenze, l'ordine reale del viaggio
 * imposta su quelle; e infine la struttura di tre giorni, che è vera ovunque.
 * In nessun caso una riga dice che un dato manca: dice che cosa fare.
 */
function itineraryStops(place: string, facts: EditorialFacts): string[] {
  const knowledge = knowledgeFor(place);
  const fromKnowledge = (knowledge?.stops ?? [])
    .filter((stop) => stop.trim().length > 0)
    .map((stop) => stop.trim());

  // Le tappe del posto sono il contenuto dell'itinerario: si etichettano come
  // giornate e si adattano alla natura del luogo, ma non si sostituiscono.
  // Il contatore è condiviso con il riempimento perché l'etichetta di giornata
  // deve essere sequenziale: due "Giorno 1" nella stessa lista farebbero leggere
  // un itinerario di tre giorni come uno di due.
  const stops: string[] = [];
  let day = 1;
  for (const stop of fromKnowledge.slice(0, MAX_TRAVEL_POINTS)) {
    stops.push(dayLabel(day, stop));
    day += 1;
  }

  // I dati del catalogo sono la seconda fonte, e valgono solo se il posto non
  // ha già le sue tappe: nominalmente sono di viaggio, non del luogo.
  if (stops.length === 0) {
    if (facts.departureCities) stops.push(`Partenza da ${facts.departureCities}`);
    if (facts.dates || facts.duration) {
      stops.push(
        `Il soggiorno a ${place}` +
          `${facts.duration ? `, ${facts.duration}` : ""}` +
          `${facts.dates ? `, ${facts.dates}` : ""}`
      );
    }
  }

  // Tre è il minimo che il formato dichiara, non un massimo: un ITINERARY con due
  // tappe promette tre giorni e ne mostra due, e la promessa più corta di ciò
  // che il fotogramma stampa è il difetto che questo codice esiste per evitare.
  // Quindi ciò che manca si riempie con la struttura di tre giorni, che è vera
  // per qualunque destinazione, e mai con una riga che ammette che il dato non
  // c'è. Nessun punto viene perso: sono i punti a essere tre, non a essere due.
  for (const fallback of tripStructureStops(place)) {
    if (stops.length >= MAX_TRAVEL_POINTS) break;
    stops.push(dayLabel(day, fallback));
    day += 1;
  }
  return stops.slice(0, MAX_TRAVEL_POINTS);
}

/** Tre giornate-tappa che valgono per qualunque viaggio. */
function tripStructureStops(place: string): string[] {
  // Il numero di giornata lo mette `dayLabel`, non questa lista: qui il numero
  // sarebbe fisso a "Giorno 1" e le tre righe finirebbero in coda a un elenco
  // che ha già il suo Giorno 1 e il suo Giorno 2.
  return [
    `arrivo a ${place} e primo giro a piedi`,
    `la giornata piena, costruita sul posto`,
    `ultimo giro e rientro`,
  ];
}

/**
 * Rende una tappa del posto una giornata, e sceglie l'etichetta giusta.
 *
 * ## Perché il posto cambia
 *
 * Un'itinerario su un'isola e uno in una città d'arte non si raccontano con le
 * stesse parole. Sul mare la giornata è una cala e l'ora in cui ci si va,
 * perché il mare alle sei del mattino e alle tre del pomeriggio sono due posti
 * diversi. In città la giornata è un quartiere e il suo monumento, perché il
 * valore sta nel mettere il centro storico insieme alle terme o al mercato.
 * Usare la struttura sbagliata non è un difetto di stile: è un itinerario che
 * non aiuta nessuno.
 *
 * La struttura resta la stessa — una riga per tappa — e cambia ciò che si dice,
 * perché è la stessa conoscenza guardata dal punto giusto.
 */
function dayLabel(day: number, stop: string): string {
  return `Giorno ${day} — ${stop}`;
}

/**
 * La cornice dell'itinerario, che dice che genere di viaggio è.
 *
 * È qui, e non in ciascuna tappa, che si dichiara se il giro è per spiagge o
 * per monumenti: ripetere la stessa frase sotto ogni riga la renderebbe rumore
 * al secondo giorno, e la cornice è una cosa che si dice una volta.
 */
function itineraryHead(place: string, kind: PlaceKind, days: number | null): string {
  const opening = days ? `${place} in ${days} giorni` : place;
  switch (kind) {
    case "sea":
      // Isola: tutto il viaggio sta in acqua, e ogni giornata finisce in mare.
      return `${opening}, fra le spiagge e le cale, con i tramonti in evidenza:`;
    case "coast":
      // Costa estesa: il mare convive con i borghi e i monumenti, e l'itinerario
      // serve a capire quale dei due caratterizza ogni tappa.
      return `${opening}, fra il mare e i borghi, una tappa al giorno:`;
    case "mixed":
      return `${opening}, tappa per tappa:`;
    case "city":
    default:
      return `${opening}, fra i quartieri e i monumenti, una tappa al giorno:`;
  }
}

/** Le frasi dei dati commerciali, in ordine di lettura: prezzo, date, servizi. */
function factLines(facts: EditorialFacts): string[] {
  const lines: string[] = [];
  if (facts.price) lines.push(facts.price);
  if (facts.dates) lines.push(facts.dates);
  if (facts.duration) lines.push(facts.duration);
  if (facts.departureCities) lines.push(`partenze da ${facts.departureCities}`);
  if (facts.included) lines.push(`comprende ${facts.included}`);
  if (facts.excluded) lines.push(`non comprende ${facts.excluded}`);
  return lines;
}

/** Le righe dei dati in una frase sola, o stringa vuota se non ce ne sono. */
function factSentence(facts: EditorialFacts): string {
  const lines = factLines(facts);
  if (lines.length === 0) return "";
  const text = lines.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * Caption del post, per formato.
 *
 * La struttura cambia con il formato ed è il punto: tre consigli per
 * TRAVEL_TIPS, tappe per ITINERARY, domanda e risposta per FAQ, dati in
 * evidenza per OFFER e HERO, racconto per STORYTELLING, atmosfera per
 * INSPIRATION.
 *
 * Il contenuto viene dalla conoscenza del luogo quando c'è, e dai dati del
 * catalogo quando non c'è. Non esiste un ramo che ammette di non sapere: ogni
 * formato ha sempre qualcosa da dire, perché un post senza contenuto è un post
 * che non vale di essere pubblicato.
 */
export function editorialCaption(
  format: string,
  place: string,
  facts: EditorialFacts = NO_FACTS
): string {
  const caption = captionBody(format, place, facts);

  // La caption nomina sempre il luogo. È la regola che tiene un post
  // riconoscibile mentre si scrolla un feed: una risposta che parla solo di
  // "sull'isola" o di "tre giorni" è comprensibile solo insieme al titolo, e
  // nel feed il titolo non c'è. I rami che nominano il luogo lo fanno già nel
  // testo; questo è il controllo per quelli che non lo fanno.
  return titleNamesPlace(caption, place) ? caption : `${place}: ${caption}`;
}

/** Il corpo della caption, per formato, senza il prefisso sul luogo. */
function captionBody(
  format: string,
  place: string,
  facts: EditorialFacts
): string {
  const summary = factSentence(facts);
  const knowledge = knowledgeFor(place);

  switch (format) {
    case "TRAVEL_TIPS": {
      const tips = travelTipLines(place, facts);
      const bullets = tips.map((tip) => `• ${tip}`).join("\n");
      return (
        `Tre cose da sapere prima di partire per ${place}.\n\n` +
        `${bullets}\n\n` +
        CTA
      );
    }
    case "ITINERARY": {
      const head = itineraryHead(place, knowledge?.kind ?? "city", travelDays(facts));
      const stops = itineraryStops(place, facts)
        .map((stop) => `• ${stop}`)
        .join("\n");
      return `${head}\n\n${stops}\n\n${CTA}`;
    }
    case "FAQ": {
      // La domanda è il titolo, quindi qui sotto va la risposta a quella domanda
      // e non un'altra: è la struttura che rende una FAQ leggibile in tre righe.
      const curated = knowledge?.faqs?.[0];
      const body: string[] = [];

      if (curated) {
        body.push(curated.answer);
        // Gli altri dati dell'offerta non aspettano: entrano dopo la risposta,
        // perché sono le cifre che l'utente sta confrontando con il resto.
        if (facts.price) body.push(`Il prezzo: ${facts.price}.`);
        if (facts.dates) body.push(`Le date: ${facts.dates}.`);
        if (facts.duration) body.push(`La durata: ${facts.duration}.`);
      } else {
        if (facts.price) body.push(`Il prezzo: ${facts.price}.`);
        if (facts.dates) body.push(`Le date: ${facts.dates}.`);
        if (facts.duration) body.push(`La durata: ${facts.duration}.`);
        if (facts.departureCities) body.push(`Le partenze: da ${facts.departureCities}.`);
        if (facts.included) body.push(`Cosa comprende: ${facts.included}.`);
        if (facts.excluded) body.push(`Cosa non comprende: ${facts.excluded}.`);
        if (body.length === 0) {
          // Nessun dato e nessuna conoscenza: la risposta che si può dare è
          // quella che vale per ogni viaggio, non un rinvio.
          body.push(
            `La prima cosa da fissare prima di ${place} è la durata: tre giorni danno il tempo di vedere qualcosa, ` +
              `due finiscono in spostamenti. Poi il resto si organizza sul posto.`
          );
        }
      }
      return `${body.join(" ")} ${CTA}`;
    }
    case "INSPIRATION":
      return (
        (knowledge?.hooks?.[0]
          ? `${knowledge.hooks[0]} ${place} si racconta meglio a chi ci va una volta, e riparte. `
          : `A volte basta pensare a ${place} perché il desiderio di partire torna, con più chiarezza di prima. `) +
        `${summary ? `Quello che abbiamo in serbo per questa stagione: ${summary} ` : ""}` +
        CTA
      );
    case "STORYTELLING":
      return (
        (knowledge?.hooks?.[1] ?? knowledge?.hooks?.[0]
          ? `${knowledge.hooks[1] ?? knowledge.hooks[0]} `
          : `Tutto comincia da una scelta: ${place}. Una domanda all'inizio, un progetto con un nome e una data davanti, e poi la partenza. `) +
        `${summary ? `Questa è l'offerta che lo rende possibile: ${summary} ` : ""}` +
        CTA
      );
    // L'offerta mette in fila tutti i dati che la decidono: prezzo, date,
    // durata, da dove si parte, cosa è incluso e cosa no. È il formato in cui
    // l'informazione è il prodotto, quindi nessun dato reale resta fuori.
    //
    // Se non c'è nessun dato non c'è un'offerta da descrivere, e dichiararlo
    // con "su richiesta" sarebbe una promessa commerciale inventata: in quel
    // caso il post dice quello che è vero, cioè il posto.
    case "OFFER": {
      const hasAnyFact = Object.values(facts).some((value) => value !== null);
      if (!hasAnyFact) {
        return (
          `${place}: cosa comprende il viaggio su ${place}. ` +
          `${knowledge?.tips?.[0] ?? ""} ` +
          CTA
        );
      }
      return (
        `${place}${facts.price ? ` è disponibile ${facts.price}` : ""}` +
        `${facts.dates ? ` ${facts.dates}` : ""}. ` +
        `${facts.duration ? `${facts.duration} in programma. ` : ""}` +
        `${facts.departureCities ? `Partenze da ${facts.departureCities}. ` : ""}` +
        `${facts.included ? `Comprende ${facts.included}. ` : ""}` +
        `${facts.excluded ? `Non comprende ${facts.excluded}. ` : ""}` +
        CTA
      );
    }
    case "HERO_DESTINATION":
    default:
      return (
        `${place} è al centro di questa proposta: ` +
        `${summary ? `${summary} ` : (knowledge?.tips?.[0] ?? "")} ` +
        CTA
      );
  }
}

/* ──────────────────────────────────────────────────────────────────────── *
 * Punti stampati sul fotogramma
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * I formati che stampano i punti dentro la card del fotogramma.
 *
 * Solo due, e non per disattenzione. TRAVEL_TIPS e ITINERARY sono i formati in
 * cui i punti sono *la* promessa del post: se restano solo nella caption, il
 * fotogramma dice "Consigli di viaggio" e non mostra nessun consiglio, e chi
 * scrolla i feed non legge la caption. Negli altri formati il fotogramma ha già
 * il suo contenuto — i dati dell'offerta — e aggiungere righe lo farebbe
 * affollare senza guadagnare informazione.
 */
export const FRAME_POINTS_FORMATS: readonly string[] = ["TRAVEL_TIPS", "ITINERARY"];

/**
 * I punti che il fotogramma deve stampare dentro la card, per formato.
 *
 * Vuoto quando il formato non li stampa o quando non c'è niente di vero da
 * stampare: in quel caso il fotogramma resta quello che è, e nessuno si
 * aspetta tre righe a caso sopra una foto.
 *
 * La stessa funzione alimenta la caption, così ciò che si vede e ciò che si
 * legge non possono divergere: è la stessa lista di stringhe.
 */
export function editorialPoints(
  format: string,
  place: string,
  facts: EditorialFacts = NO_FACTS
): string[] {
  const normalized = (format ?? "").trim().toUpperCase();
  if (!FRAME_POINTS_FORMATS.includes(normalized)) return [];
  if (!place.trim()) return [];
  return normalized === "ITINERARY"
    ? itineraryStops(place, facts)
    : travelTipLines(place, facts);
}