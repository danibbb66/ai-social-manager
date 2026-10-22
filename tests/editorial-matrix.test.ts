import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NO_FACTS,
  FRAME_POINTS_FORMATS,
  editorialCaption,
  editorialPoints,
  editorialTitle,
  isGenericTitle,
  titleNamesPlace,
  GENERIC_TITLE_FORMULAS,
  type EditorialFacts,
} from "../src/lib/ai/editorial-matrix";
import { CONTENT_FORMATS, catalogCopyFromProposal } from "../src/lib/ai/catalog-content";
import { fallbackCopyFromTopic } from "../src/lib/ai/content-copy";
import { kickerForFormat } from "../src/lib/ai/format-kicker";
import { placeNameFrom } from "../src/lib/ai/place-name";
import {
  knowledgeFor,
  curatedDestinations,
  MAX_TRAVEL_POINTS,
} from "../src/lib/ai/travel-knowledge";
import type { CatalogProposalDto } from "../src/lib/services/catalog-ai";

/**
 * Matrice editoriale: cinque formati, due output ciascuno.
 *
 * Qui la verifica è sulla struttura, non sul testo preciso: ciò che deve
 * valere per tutti i formati è che il titolo nomini la destinazione e non
 * contenga formule generiche, e che la caption abbia la forma che il formato
 * promette. Il confronto parola per parola sarebbe un test che si rompe a ogni
 * riscrittura senza dire nulla; quello che conta è la regola.
 */

const PLACE = "Formentera";

/** Una proposta con tutti i dati, e una senza nessuno. */
function proposalWith(over: Partial<CatalogProposalDto> = {}): CatalogProposalDto {
  return {
    id: "proposta-1",
    name: "Offerta Formentera",
    destination: PLACE,
    status: "ACTIVE",
    confidence: "UNVERIFIED",
    sourceUrl: "https://catalogo.test/formentera",
    sourceType: "FLYER",
    commercial: {
      priceFrom: 890,
      priceTo: null,
      currency: "EUR",
      priceNote: null,
      periodStart: "2026-06-20",
      periodEnd: "2026-06-27",
      departureCities: "Milano",
      durationNights: 7,
      included: "volo e hotel",
      excluded: null,
    },
    commercialFieldsPresent: [
      "priceFrom",
      "currency",
      "periodStart",
      "periodEnd",
      "departureCities",
      "durationNights",
      "included",
    ],
    officialImage: null,
    anomalies: [],
    usable: true,
    unusableReason: null,
    lastUsedAt: null,
    source: {
      domain: "catalogo.test",
      pageUrl: "https://catalogo.test",
      kind: "SITE_WORDPRESS",
      authority: "PRESENTATION",
    },
    ...over,
  } as unknown as CatalogProposalDto;
}

const EMPTY_PROPOSAL = proposalWith({
  id: "vuota",
  destination: PLACE,
  commercial: {
    priceFrom: null,
    priceTo: null,
    currency: null,
    priceNote: null,
    periodStart: null,
    periodEnd: null,
    departureCities: null,
    durationNights: null,
    included: null,
    excluded: null,
  },
  commercialFieldsPresent: [],
});

/* ──────────────────────────────────────────────────────────────────────── *
 * Regola 1: nessun titolo generico
 * ──────────────────────────────────────────────────────────────────────── */

test("MATRICE: il titolo di ogni formato nomina sempre la destinazione", () => {
  for (const format of CONTENT_FORMATS) {
    const title = editorialTitle(format, PLACE);
    assert.ok(
      titleNamesPlace(title, PLACE),
      `${format}: "${title}" non nomina ${PLACE}`
    );
    assert.equal(isGenericTitle(title), false, `${format}: "${title}" è generico`);
  }
});

test("MATRICE: nessun titolo contiene una delle formule bandite", () => {
  // Le formule sono anche nei titoli prodotti con tutti i dati disponibili: un
  // titolo generico non dipende da quanti dati ci sono, dipende da come è scritto.
  for (const format of CONTENT_FORMATS) {
    const title = editorialTitle(format, PLACE);
    for (const formula of GENERIC_TITLE_FORMULAS) {
      assert.doesNotMatch(
        title.toLowerCase(),
        new RegExp(formula.toLowerCase()),
        `${format}: "${title}" contiene "${formula}"`
      );
    }
  }
});

test("MATRICE: il titolo di catalobao parte dal nome del luogo anche se il DTO ha dati", () => {
  for (const format of CONTENT_FORMATS) {
    const copy = catalogCopyFromProposal(proposalWith(), format);
    assert.ok(
      titleNamesPlace(copy.title, PLACE),
      `${format}: il titolo di catalogo "${copy.title}" non nomina ${PLACE}`
    );
    assert.equal(copy.title, copy.title.trim(), `${format}: il titolo ha spaziature`);
    assert.ok(copy.title.length > 0, `${format}: il titolo è vuoto`);
  }
});

test("MATRICE: il titolo non ripete il topic con la sua formula di richiesta", () => {
  const copy = fallbackCopyFromTopic({ topic: "proposta Formentera", format: "HERO_DESTINATION" });
  assert.equal(copy.title, "Formentera", "il titolo è il luogo, non la richiesta");
  assert.equal(
    isGenericTitle(copy.title ?? ""),
    false,
    `il fallback ha prodotto un titolo generico: ${copy.title}`
  );
});

test("MATRICE: senza un nome di luogo non viene prodotto alcun titolo", () => {
  const copy = fallbackCopyFromTopic({ topic: "proposta di viaggio", format: "HERO_DESTINATION" });
  assert.equal(copy.title, null, "senza luogo un titolo sarebbe una formula vuota");
  assert.equal(copy.caption, null, "e la caption non avrebbe niente di cui parlare");
});

/* ──────────────────────────────────────────────────────────────────────── *
 * Regola 2: la struttura di ogni formato
 * ──────────────────────────────────────────────────────────────────────── */

test("MATRICE: TRAVEL_TIPS ha tre consigli a punti", () => {
  const copy = catalogCopyFromProposal(proposalWith(), "TRAVEL_TIPS");
  const bullets = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.equal(bullets.length, 3, `attese tre righe, trovate: ${copy.caption}`);
  assert.match(copy.title, /Formentera/, "il titolo dice a che cosa serve il post");
  assert.match(copy.title, /Consigli di viaggio/i, "il titolo dichiara l'angolazione");
  // Ogni consiglio è un fatto su quel posto o una regola del viaggio, mai un
  // luogo comune da volantino ("porta gli occhiali", "prova il cibo locale").
  for (const bullet of bullets) {
    assert.doesNotMatch(
      bullet,
      /occhiali|crema solare|banana|scarpe|divertimento|svago/i,
      `consiglio non ancorato: ${bullet}`
    );
  }
});

test("PARSING: il nome del luogo non porta con sé il formato richiesto", () => {
  // Il bug che riguardava questo passaggio: "travel tips Formentera" arrivava al
  // motore dei contenuti come se fosse il nome di un posto, non corrispondeva a
  // nessuna voce della base di conoscenza, e il post ripiegava sui dati del
  // catalogo perdendo i consigli e le tappe vere.
  const sporche: [string, string][] = [
    ["travel tips Formentera", "Formentera"],
    ["Travel Tips Formentera", "Formentera"],
    ["TRAVEL TIPS FORMENTERA", "Formentera"],
    ["itinerario Creta", "Creta"],
    ["ITINERARIO Rodi", "Rodi"],
    ["proposta di viaggio Calabria", "Calabria"],
    ["hero destination Mallorca", "Mallorca"],
    ["Mallorca itinerario", "Mallorca"],
    ["domande frequenti Parigi", "Parigi"],
    ["Formentera - Consigli di viaggio", "Formentera"],
  ];
  for (const [sporco, atteso] of sporche) {
    assert.equal(placeNameFrom(null, null, sporco), atteso, `"${sporco}"`);
    // E la stessa pulizia vale per la destinazione, che ha precedenza sul topic:
    // non accettandola grezza, il formato scritto dentro il campo nome del
    // motore dei contenuti.
    assert.equal(placeNameFrom(sporco, null, null), atteso, `destinazione "${sporco}"`);
  }
});

test("PARSING: la pulizia non mangia le parti del nome che sono il nome", () => {
  // "Isola d'Elba" è un posto: se la pulizia togliesse le parole che sembrano
  // rubriche, resterebbe "d'Elba" e la conoscenza dell'isola andrebbe persa.
  assert.equal(placeNameFrom(null, null, "Isola d'Elba"), "Isola d'Elba");
  assert.equal(placeNameFrom("Isola d'Elba", null, null), "Isola d'Elba");
  assert.equal(placeNameFrom(null, "travel tips Isola d'Elba", null), "Isola d'Elba");
  assert.equal(placeNameFrom(null, null, "Costa Smeralda"), "Costa Smeralda");
  assert.equal(placeNameFrom(null, null, "San Vito Lo Capo"), "San Vito Lo Capo");
});

test("PARSING: un topic senza luogo non produce un titolo inventato", () => {
  // Se dopo la pulizia non resta niente, il nome è vuoto: è preferibile un
  // post senza titolo stampato a un titolo che è la rubrica del formato.
  assert.equal(placeNameFrom(null, null, "proposta di viaggio"), "");
  assert.equal(placeNameFrom("travel tips", null, null), "");
});

test("PARSING: la conoscenza viene trovata dopo la pulizia", () => {
  // Il collegamento fra i due punti: se il motore dei contenuti riceve un
  // nome pulito, deve effettivamente trovare i consigli del posto.
  for (const sporco of ["travel tips Formentera", "ITINERARIO Rodi", "proposta di viaggio Creta"]) {
    const place = placeNameFrom(null, null, sporco);
    assert.ok(
      knowledgeFor(place) !== null,
      `"${sporco}" ripulito in "${place}" non trova conoscenza`
    );
    const copy = catalogCopyFromProposal(
      { ...proposalWith(), id: "pulito", destination: sporco } as CatalogProposalDto,
      "TRAVEL_TIPS"
    );
    assert.equal(copy.knowledgeSource, "curated", `"${sporco}" non usa la conoscenza`);
    assert.equal(copy.points.length, 3, `"${sporco}" non stampa i punti`);
  }
});

test("ITINERARI SMART: il mare gira attorno alle spiagge e ai tramonti", () => {
  // Un itinerario d'isola fatto di quartieri e monumenti non sta in piedi: chi
  // va a Ibiza cerca una cala, non un quartiere. E viceversa.
  for (const place of ["Formentera", "Mallorca", "Ibiza", "Creta"]) {
    const caption = editorialCaption("ITINERARY", place);
    assert.match(
      caption,
      /spiagge|cale|tramonti/i,
      `${place}: l'itinerario non parla di mare\n${caption}`
    );
    for (const stop of knowledgeFor(place)!.stops.slice(0, 3)) {
      assert.ok(caption.includes(stop), `${place}: manca la tappa "${stop}"`);
    }
  }
});

test("ITINERARI SMART: sull'isola ogni giornata finisce in acqua", () => {
  // La cornice promette spiagge, cale e tramonti: se le giornate sono tre
  // borghi e un museo, la promessa non è mantenuta. È il motivo per cui la
  // conoscenza di un'isola porta nomi di cala e non di quartiere.
  // "bagno" conta perché è la parola con cui si nomina il mare in una
  // giornata: dire "la spiaggia" in una tappa e "il bagno" in un'altra è la
  // stessa cosa detta in due modi.
  const paroleDiMare = /spiaggia|spiagge|cala|cale|baia|tramonto|grotta|grotte|faro|molo|bastion|bagno/i;
  // Le isole: qui la promessa della cornice è "spiagge, cale, tramonti", e ogni
  // giornata deve potercela mantenere. Sono le destinazioni dove il mare è la
  // ragione del viaggio.
  for (const place of ["Formentera", "Mallorca", "Ibiza", "Creta", "Rodi", "Corfù"]) {
    const stops = editorialPoints("ITINERARY", place);
    assert.equal(stops.length, 3, `${place}: tre giornate`);
    for (const stop of stops) {
      assert.match(
        stop,
        paroleDiMare,
        `${place}: la giornata "${stop}" non porta in acqua`
      );
    }
  }
});

test("ITINERARI SMART: la costa estesa alterna mare e borghi", () => {
  // Una regione costiera non è un'isola: borghi e monumenti ci sono, e sono metà
  // del motivo per cui si va. La cornice deve dirlo, altrimenti promette tre
  // giornate di spiaggia e ne dà una.
  for (const place of ["Sicilia", "Calabria", "Puglia", "Sardegna"]) {
    const caption = editorialCaption("ITINERARY", place);
    assert.match(caption, /fra il mare e i borghi/i, `${place}: ${caption.split("\n")[0]}`);
    assert.doesNotMatch(
      caption,
      /fra le spiagge e le cale/i,
      `${place}: non è un'isola, non può promettere solo spiagge`
    );
  }
});

test("ITINERARI SMART: la città gira attorno a quartieri e monumenti", () => {
  for (const place of ["Parigi", "New York", "Londra", "Venezia"]) {
    const caption = editorialCaption("ITINERARY", place);
    assert.match(
      caption,
      /quartieri|monumenti/i,
      `${place}: l'itinerario non parla di città\n${caption}`
    );
    assert.doesNotMatch(
      caption,
      /spiagge e le cale/i,
      `${place}: una città non si gira per spiagge`
    );
  }
});

test("ITINERARI SMART: ogni tappa è una giornata e la cornice dice il genere", () => {
  // La cornice dichiara il genere del giro una volta sola: ripeterla sotto ogni
  // riga la renderebbe rumore, e al secondo giorno l'utente smette di leggerla.
  const mare = editorialCaption("ITINERARY", "Formentera");
  const citta = editorialCaption("ITINERARY", "Parigi");
  assert.match(mare, /fra le spiagge e le cale/);
  assert.match(citta, /fra i quartieri e i monumenti/);
  assert.equal(
    (mare.match(/fra le spiagge e le cale/g) ?? []).length,
    1,
    "la cornice si dice una volta"
  );

  for (const caption of [mare, citta]) {
    const stops = caption.split("\n").filter((l) => l.trim().startsWith("•"));
    assert.equal(stops.length, 3, `servono tre giornate: ${caption}`);
    stops.forEach((stop, i) => {
      assert.match(stop, new RegExp(`Giorno ${i + 1}`), `giornata fuori posto: ${stop}`);
    });
  }
});

test("CONOSCENZA: la tabella è completa e non ha righe vuote", () => {
  // Una destinazione con consigli vuoti o con tappe in numero diverso dai
  // consigli produrrebbe un post che promette tre cose e ne dà due. La verifica
  // è sulla tabella intera, quindi una riga sbagliata falla vedere subito.
  const destinations = curatedDestinations();
  assert.ok(destinations.length >= 10, `conoscenza troppo scarsa: ${destinations.length} destinazioni`);

  for (const key of destinations) {
    const knowledge = knowledgeFor(key);
    assert.ok(knowledge, `${key}: la chiave non si risolve`);
    // La natura del luogo è ciò che rende l'itinerario sensato: una voce senza
    // `kind` produrrebbe una città d'arte girata per spiagge.
    assert.ok(
      ["sea", "coast", "city", "mixed"].includes(knowledge.kind),
      `${key}: natura del luogo mancante o ignota`
    );
    assert.ok(knowledge.tips.length >= MAX_TRAVEL_POINTS, `${key}: meno di tre consigli`);
    assert.ok(knowledge.stops.length >= MAX_TRAVEL_POINTS, `${key}: meno di tre tappe`);
    assert.ok(knowledge.faqs.length >= 1, `${key}: nessuna domanda`);
    assert.ok(knowledge.hooks.length >= 1, `${key}: nessuna atmosphere`);
    for (const tip of knowledge.tips) {
      assert.ok(tip.trim().length > 30, `${key}: consiglio troppo corto: "${tip}"`);
      assert.doesNotMatch(tip, /agenzia|da definire/i, `${key}: "${tip}"`);
    }
    for (const stop of knowledge.stops) {
      assert.ok(stop.trim().length > 10, `${key}: tappa troppo corta: "${stop}"`);
    }
    for (const faq of knowledge.faqs) {
      assert.ok(faq.question.trim().endsWith("?"), `${key}: la domanda non è una domanda`);
      assert.ok(faq.answer.trim().length > 30, `${key}: risposta troppo corta`);
    }
  }
});

test("CONOSCENZA: i consigli di una destinazione nota sono fatti su quel posto", () => {
  // Formentera è nella base di conoscenza: i suoi consigli riguardano Ses
  // Salines, il faro e le piste, non l'offerta. È la prova che la conoscenza
  // esiste e che ha la precedenza sui dati commerciali.
  const copy = catalogCopyFromProposal(proposalWith(), "TRAVEL_TIPS");
  const knowledge = knowledgeFor("Formentera")!;
  for (const tip of knowledge.tips.slice(0, 3)) {
    assert.ok(
      copy.caption.includes(tip),
      `il consiglio curato "${tip}" deve comparire nella caption`
    );
  }
  assert.equal(copy.knowledgeSource, "curated");
  // La caption non può essere la stessa di un'altra destinazione: due post su
  // due isole diverse non possono condividere i consigli.
  const other = catalogCopyFromProposal(
    proposalWith({ id: "altra", destination: "Parigi" }),
    "TRAVEL_TIPS"
  );
  assert.notEqual(copy.caption, other.caption, "due destinazioni, due consigli diversi");
});

test("CONOSCENZA: i consigli di una destinazione ignota vengono dai dati reali", () => {
  const copy = catalogCopyFromProposal(
    proposalWith({ id: "ignota", destination: "Vallemaggia" }),
    "TRAVEL_TIPS"
  );
  const bullets = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.equal(bullets.length, 3);
  assert.equal(copy.knowledgeSource, "derived", "la provenienza dichiara che non è conoscenza");
  // Nessun consiglio su un posto che non conosciamo: i dati ci sono e bastano.
  assert.match(copy.caption, /890/, "il dato reale c'è ed è il primo dei tre");
});

test("VIETATO: nessuna caption contiene formule di servizio", () => {
  // Sono le frasi che hanno sostituito i contenuti quando non c'era niente da
  // dire. Non sono informazione: sono un'assenza di informazione travestita.
  const banned = [
    "dettagli in agenzia",
    "in agenzia",
    "l'agenzia",
    "agenzia",
    "da definire",
    "le conferma",
    "le indica l'agenzia",
    "su richiesta",
  ];
  for (const place of ["Formentera", "Parigi", "Vallemaggia"]) {
    for (const format of CONTENT_FORMATS) {
      const caption = editorialCaption(format, place);
      for (const phrase of banned) {
        assert.doesNotMatch(
          caption.toLowerCase(),
          new RegExp(phrase),
          `${format} su ${place}: "${caption}" contiene "${phrase}"`
        );
      }
      assert.doesNotMatch(
        caption,
        /richiedi in agenzia|chiedi in agenzia|consulta/i,
        `${format}: rinvio a un altro canale`
      );
    }
  }
});

test("VIETATO: nessun titolo contiene formule di servizio", () => {
  for (const place of ["Formentera", "Vallemaggia"]) {
    for (const format of CONTENT_FORMATS) {
      const title = editorialTitle(format, place);
      assert.doesNotMatch(
        title.toLowerCase(),
        /agenzia|da definire|su richiesta/,
        `${format}: "${title}"`
      );
    }
  }
});

test("MATRICE: TRAVEL_TIPS ha tre consigli anche senza dati commerciali", () => {
  const copy = catalogCopyFromProposal(EMPTY_PROPOSAL, "TRAVEL_TIPS");
  const bullets = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.equal(bullets.length, 3, "il titolo promette tre consigli: la lista devono esserci");
  assert.doesNotMatch(copy.caption, /\d+\s*(giorni|notti)/i, "nessuna durata inventata");
  assert.doesNotMatch(copy.caption, /€|euro|prezzo/i, "nessun prezzo inventato");
});

test("PUNTI: il fotogramma riceve gli stessi punti della caption", () => {
  // È la regola che tiene insieme immagine e testo: ciò che si vede sopra la
  // foto e ciò che si legge sotto devono essere la stessa lista. Due versioni
  // parallele divergerebbero alla prima modifica.
  for (const format of CONTENT_FORMATS) {
    const copy = catalogCopyFromProposal(proposalWith(), format);
    const points = editorialPoints(format, PLACE);
    if (FRAME_POINTS_FORMATS.includes(format)) {
      assert.equal(points.length, 3, `${format}: devono esserci tre punti`);
      for (const point of points) {
        assert.ok(
          copy.caption.includes(point),
          `${format}: il punto "${point}" non è nella caption`
        );
      }
    } else {
      assert.equal(points.length, 0, `${format}: non stampa punti`);
      assert.equal(copy.points.length, 0, `${format}: nessun punto dichiarato`);
    }
  }
});

test("PUNTI: nessun punto è una formula di servizio", () => {
  // Un punto stampato sopra una foto ha il peso di un'affermazione: se è un
  // rinvio a un altro canale, è un avviso travestito da contenuto.
  for (const place of ["Formentera", "Vallemaggia"]) {
    for (const format of FRAME_POINTS_FORMATS) {
      for (const point of editorialPoints(format, place)) {
        assert.doesNotMatch(
          point.toLowerCase(),
          /agenzia|dettagli in agenzia|da definire|su richiesta/,
          `${format} su ${place}: "${point}"`
        );
        assert.ok(point.length > 20, `${format}: punto troppo corto per essere un consiglio: "${point}"`);
      }
    }
  }
});

test("PUNTI: la caption di ogni formato nomina la destinazione", () => {
  // Nel feed il titolo non c'è: la caption è ciò che identifica il post mentre
  // si scrolla. Una caption che parla di "sull'isola" senza nominarla è
  // incomprensibile da sola.
  for (const place of ["Formentera", "Creta", "Parigi", "Vallemaggia"]) {
    for (const format of CONTENT_FORMATS) {
      const caption = editorialCaption(format, place);
      assert.ok(
        caption.toLowerCase().includes(place.toLowerCase().replace("è", "e")),
        `${format} su ${place}: la caption non nomina la destinazione`
      );
    }
  }
});

test("MATRICE: ITINERARY ha il titolo in giorni e la caption a tappe", () => {
  const copy = catalogCopyFromProposal(proposalWith(), "ITINERARY");
  // 7 notti sono 8 giorni: il titolo deve contarli, non riportare le notti.
  assert.match(copy.title, /Formentera in 8 giorni/i, `titolo: ${copy.title}`);
  const stops = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.ok(stops.length >= 2, `servono almeno due tappe: ${copy.caption}`);
  // Le tappe devono essere le tappe vere di quel posto, non una struttura vuota.
  const knowledge = knowledgeFor("Formentera")!;
  for (const stop of knowledge.stops.slice(0, 3)) {
    assert.ok(copy.caption.includes(stop), `manca la tappa "${stop}"`);
  }
});

test("CONOSCENZA: l'itinerario di una destinazione ignota è costruito sui dati", () => {
  const copy = catalogCopyFromProposal(
    proposalWith({ id: "ignota", destination: "Vallemaggia" }),
    "ITINERARY"
  );
  const stops = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.ok(stops.length >= 2, `servono almeno due tappe: ${copy.caption}`);
  assert.match(copy.caption, /Milano/, "la partenza è un dato reale e va nel percorso");
  assert.equal(copy.knowledgeSource, "derived");
});

test("MATRICE: ITINERARY senza notti non inventa i giorni", () => {
  const copy = catalogCopyFromProposal(EMPTY_PROPOSAL, "ITINERARY");
  assert.doesNotMatch(copy.title, /\d+\s*giorni/i, `titolo: ${copy.title}`);
  assert.ok(titleNamesPlace(copy.title, PLACE), `titolo: ${copy.title}`);
  const stops = copy.caption.split("\n").filter((l) => l.trim().startsWith("•"));
  assert.ok(stops.length >= 2, "le tappe ci sono anche senza date, e dicono che cosa fare");
});

test("MATRICE: FAQ ha una domanda nel titolo e la risposta nel testo", () => {
  const copy = catalogCopyFromProposal(proposalWith(), "FAQ");
  assert.ok(copy.title.includes("?"), `il titolo deve essere una domanda: ${copy.title}`);
  assert.match(copy.title, /Formentera|auto|servizio/i, "la domanda riguarda la destinazione");
  // La risposta è quella vera alla domanda stampata sopra, non un paragrafo.
  const knowledge = knowledgeFor("Formentera")!;
  assert.match(copy.caption, /auto|bici/i, `caption: ${copy.caption}`);
  assert.ok(knowledge.faqs.length > 0);
  assert.notEqual(
    copy.title.toLowerCase(),
    copy.caption.toLowerCase(),
    "titolo e caption non sono la stessa stringa"
  );
});

test("MATRICE: FAQ senza dati non inventa una risposta", () => {
  // Nessun dato commerciale e nessuna conoscenza: il caso peggiore. La risposta
  // deve essere un consiglio vero, non un rinvio.
  const copy = catalogCopyFromProposal(
    { ...EMPTY_PROPOSAL, id: "ignota", destination: "Vallemaggia" } as CatalogProposalDto,
    "FAQ"
  );
  assert.ok(copy.title.includes("?"), `titolo: ${copy.title}`);
  assert.doesNotMatch(copy.caption, /€|euro|prezzo|\d+\s*(giorni|notti)/i, `caption: ${copy.caption}`);
  // Niente dato e niente conoscenza: la risposta è comunque un consiglio.
  assert.ok(
    copy.caption.length > 40,
    `senza dati la risposta deve essere un consiglio, non un rinvio: ${copy.caption}`
  );
});

test("MATRICE: OFFER mette in evidenza i dati commerciali", () => {
  const copy = catalogCopyFromProposal(proposalWith(), "OFFER");
  assert.match(copy.title, /Formentera/, `titolo: ${copy.title}`);
  assert.match(copy.title, /890/, "il prezzo è nel titolo: è il dato che decide");
  assert.match(copy.caption, /890/);
  assert.match(copy.caption, /Milano/, "la partenza è citata");
  assert.equal(copy.usesCommercialData, true);
});

test("MATRICE: HERO_DESTINATION è il luogo con i suoi dati", () => {
  const copy = catalogCopyFromProposal(proposalWith(), "HERO_DESTINATION");
  assert.equal(copy.title, PLACE, "l'hero è il luogo, senza aggettivi non verificabili");
  assert.match(copy.caption, /890/, "i dati ci sono, in caption");
});

test("MATRICE: le caption dei formati sono tutte diverse fra loro", () => {
  const captions = CONTENT_FORMATS.map((f) => editorialCaption(f, PLACE));
  assert.equal(
    new Set(captions).size,
    captions.length,
    "due formati con la stessa caption non sono due formati"
  );
});

test("MATRICE: nessuna caption inventa dati commerciali assenti", () => {
  for (const format of CONTENT_FORMATS) {
    const caption = editorialCaption(format, PLACE, NO_FACTS);
    assert.doesNotMatch(caption, /€|euro/i, `${format}: nessuna valuta senza dati`);
    assert.doesNotMatch(caption, /\d+\s*(giorni|notti)/i, `${format}: nessuna durata senza dati`);
    assert.ok(caption.length > 20, `${format}: la caption non può essere vuota`);
  }
});

test("MATRICE: la caption ha a capo, e sono quelli che fanno la struttura", () => {
  // Senza a capo una lista di tre consigli diventa una frase lunga e il post
  // smette di essere quello che il titolo promette.
  for (const format of ["TRAVEL_TIPS", "ITINERARY"] as const) {
    const caption = editorialCaption(format, PLACE);
    assert.ok(caption.includes("\n"), `${format}: le righe devono stare su righe diverse`);
  }
  assert.equal(
    editorialCaption("HERO_DESTINATION", PLACE).includes("\n"),
    false,
    "un hero è un paragrafo: gli a capo sarebbero rumore"
  );
});

test("MATRICE: nessun formato nomina una destinazione che non è richiesta", () => {
  const other = ["Maldive", "Amalfi", "Puglia", "Grecia"];
  for (const format of CONTENT_FORMATS) {
    const copy = catalogCopyFromProposal(proposalWith(), format);
    for (const place of other) {
      assert.doesNotMatch(copy.caption, new RegExp(place, "i"), `${format}: cita ${place}`);
      assert.doesNotMatch(copy.title, new RegExp(place, "i"), `${format}: titolo su ${place}`);
    }
  }
});

test("MATRICE: ogni formato ha la sua rubrica, tranne l'hero", () => {
  // La rubrica è ciò che distingue due post sulla stessa destinazione prima che
  // il lettore legga una parola: senza, il fotogramma è identico. L'hero è
  // l'eccezione: è la vetrina del luogo e mostra solo il suo nome, senza
  // etichetta sopra.
  for (const format of CONTENT_FORMATS) {
    if (format === "HERO_DESTINATION") {
      assert.equal(kickerForFormat(format), null, "l'hero non deve avere una rubrica");
      continue;
    }
    const kicker = kickerForFormat(format);
    assert.ok(kicker && kicker.trim().length > 0, `${format}: manca la rubrica`);
  }
  const rubriche = CONTENT_FORMATS.filter((f) => f !== "HERO_DESTINATION").map((f) =>
    kickerForFormat(f)
  );
  assert.equal(new Set(rubriche).size, rubriche.length, "due formati non possono avere la stessa rubrica");
});

test("MATRICE: il fallback generico rispetta la struttura del formato", () => {
  for (const format of CONTENT_FORMATS) {
    const copy = fallbackCopyFromTopic({
      topic: "proposta Formentera",
      destination: "Formentera",
      format,
    });
    assert.ok(copy.title && titleNamesPlace(copy.title, PLACE), `${format}: ${copy.title}`);
    assert.ok(copy.caption && copy.caption.length > 20, `${format}: caption vuota`);
    assert.doesNotMatch(
      copy.caption ?? "",
      /€|euro|\d+\s*(giorni|notti)/i,
      `${format}: il flusso generico non ha dati e non può inventarli`
    );
  }
});

test("MATRICE: il fallback è deterministico", () => {
  const sample = () => fallbackCopyFromTopic({ topic: "proposta Formentera", format: "ITINERARY" });
  assert.deepEqual(sample(), sample(), "stesso topic e stesso formato, stesso testo");
});

test("MATRICE: la funzione non muta i dati ricevuti", () => {
  const facts: EditorialFacts = {
    price: "da 890 EUR",
    dates: "dal giugno 2026",
    duration: "7 notti",
    nights: 7,
    departureCities: "Milano",
    included: "volo",
    excluded: null,
  };
  const before = { ...facts };
  editorialTitle("ITINERARY", PLACE, facts);
  editorialCaption("ITINERARY", PLACE, facts);
  assert.deepEqual(facts, before, "input non mutato");
});