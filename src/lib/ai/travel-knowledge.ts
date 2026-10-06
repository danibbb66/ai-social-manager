/**
 * Conoscenza di viaggio: che cosa si sa davvero di una destinazione.
 *
 * ## Perché esiste
 *
 * La copy dei post è nata dentro il catalogo, quindi poteva usare solo i dati
 * del fornitore: prezzo, date, durata. Quando quei dati mancano — e mancano
 * quasi sempre, perché il catalogo locale è fatto di locandine — il post si
 * riduceva a tre formule di servizio: "dettagli in agenzia", "le date le
 * conferma l'agenzia", "durata da definire". Non dicono niente del posto, e su
 * Instagram sono indistinguibili da mille post identici. Un "Consigli di
 * viaggio" che non contiene un consiglio è una promessa non mantenuta, e un
 * "Itinerario" senza tappe è soltanto un titolo.
 *
 * Qui c'è la conoscenza che riempie quello spazio: per ogni destinazione nota,
 * i luoghi, le spiagge, le tappe e le domande che un viaggiatore si fa davvero.
 * È **curata e dichiarata**, non generata a ogni richiesta: una riga qui è un
 * fatto verificabile su guide e mappe, e se non lo è non entra.
 *
 * ## Perché non una chiamata al modello
 *
 * Il flusso di copy è deliberatamente deterministico e senza rete: c'è un test
 * che vieta `fetch`, `prisma.` e `getImageProvider` dentro `catalog-content.ts`.
 * Un post deve essere riproducibile, e un DRAFT che cambia testo a ogni
 * esecuzione non è confrontabile con nessuno. Un modello, inoltre, può essere
 * indisponibile proprio nel momento in cui l'utente preme "crea". La
 * conoscenza è quindi una tabella, e la copy la compone in modo prevedibile.
 *
 * ## Destinazioni non presenti
 *
 * Una destinazione assente non è un errore: è il caso normale di un'agenzia che
 * segue richieste che arrivano dal cliente. In quel caso la copy non inventa
 * attrazioni che non conosce e non ricade nelle formule di servizio: usa i dati
 * reali che ha — prezzo, date, durata, partenze — e li dispone con la struttura
 * del formato, insieme ai consigli sulla struttura del viaggio, che valgono per
 * qualunque meta. `knowledgeFor` restituisce `null` e il chiamante registra la
 * provenienza nei warning del DRAFT, dove l'utente non la legge ma il team sì.
 */

import { normalizeForMatch } from "@/lib/catalog/text";

/**
 * Che cosa si sa di una destinazione.
 *
 * `tips`, `stops` e `faqs` sono le tre strutture che i formati promettono al
 * lettore: tre consigli, un percorso, domande con risposta. Sono separate perché
 * un consiglio non è una tappa e una tappa non è una risposta: mescolarle
 * produrrebbe post che non mantengono la promessa del proprio titolo.
 */
/**
 * La natura del luogo, che decide che tipo di itinerario ha senso.
 *
 * Non è una decorazione: è ciò che separa "un giro di spiagge" da "un giro di
 * quartieri". Le due cose hanno bisogno di posti diversi, e usarne uno dove
 * serve l'altro produce un itinerario che non sta in piedi — una città d'arte
 * raccontata con nomi di cale, un'isola con un elenco di piazze.
 */
export type PlaceKind = "sea" | "coast" | "city" | "mixed";

export interface DestinationKnowledge {
  /**
   * Natura del luogo. Guida l'itinerario: sul mare si gira per spiagge e
   * tramonti, in città per quartieri e monumenti.
   */
  kind: PlaceKind;
  /** Consigli pratici, nell'ordine in cui servono a chi arriva. */
  tips: string[];
  /** Tappe o giorni, in sequenza: il percorso si legge dall'alto verso il basso. */
  stops: string[];
  /** Domande che un viaggiatore si fa davvero, con la risposta sotto. */
  faqs: { question: string; answer: string }[];
  /** Due frasi di atmosfera, per ispirazione e racconto. */
  hooks: string[];
}

/** Da dove viene la conoscenza usata per un post. */
export type KnowledgeSource = "curated" | "derived";

/**
 * Quanti punti si stampano su un fotogramma.
 *
 * Tre è il massimo leggibile su un quadrato, e quei punti sono anche i più
 * importanti: sono la ragione per cui il post esiste.
 *
 * È anche il minimo: TRAVEL_TIPS e ITINERARY dichiarano tre consigli o tre
 * tappe, quindi una destinazione curata che ne avesse meno renderebbe il
 * fotogramma una promessa più grande di ciò che mostra. Ogni voce di
 * `KNOWLEDGE` ne dichiara almeno tre, ed è il test a ricordarlo.
 */
export const MAX_TRAVEL_POINTS = 3;

/**
 * Lunghezza massima di un consiglio o di una tappa, in caratteri.
 *
 * Non è un vincolo di stile: è la lunghezza oltre la quale il testo non entra
 * nella card del fotogramma senza diventare illeggibile. Il renderer non taglia
 * mai un punto, quindi il limite qui dentro è dichiarato: una riga troppo lunga
 * si rifiuta di stampare, non si stampa a metà.
 */
export const MAX_TRAVEL_POINT_CHARS = 170;

/**
 * La conoscenza delle destinazioni note.
 *
 * La chiave è il nome del luogo normalizzato con `normalizeForMatch`, quindi la
 * ricerca non dipende da maiuscole, accenti o apici. Gli alias servono perché i
 * nomi arrivano in forme diverse: "Elba" e "Isola d'Elba" sono lo stesso posto e
 * devono dividere la stessa conoscenza, altrimenti la forma più breve resterebbe
 * senza consigli.
 */
const KNOWLEDGE: Record<string, DestinationKnowledge> = {
  formentera: {
    kind: "sea",
    tips: [
      "Le spiagge di Ses Salines e del Trocadero si raggiungono solo a piedi o in bici: nel parco naturale le auto non entrano.",
      "Il faro di Capo de Creus si raggiunge con una strada sterrata di circa quattro chilometri, e gli ultimi due si fanno a piedi.",
      "In estate le escursioni vanno all'alba o al tramonto: le piste non hanno ombra e il sole sulle piste bianche è insostenibile.",
    ],
    stops: [
      "Sant Francesc Xavier e il mercato del sabato, e il tramonto a Caló des Mort",
      "Ses Salines, spiaggia di Levante e la Sal Rossa",
      "Cala d'Aiguardia e le spiagge dell'est, in bici o in barca",
      "Capo de Creus e la discesa al faro",
    ],
    faqs: [
      {
        question: "A Formentera serve l'auto?",
        answer:
          "No, e portarla è un errore: sull'isola si gira in bici o a piedi, le spiagge del parco sono raggiungibili solo così e l'auto finisce per restare nel parcheggio di Savignano.",
      },
      {
        question: "Formentera è aperta tutto l'anno?",
        answer:
          "No: da fine settembre a Pasqua l'isola chiude quasi tutto e i collegamenti sono ridotti al minimo. Fuori stagione si trovano voli e traghetti, ma con orari scarsi.",
      },
      {
        question: "Qual è la spiaggia più bella di Formentera?",
        answer:
          "Ses Salines è la più nota e la più lunga, ma l'acqua è più calma e il fondale più basso a Caló des Mort, che è la scelta migliore con i bambini.",
      },
    ],
    hooks: [
      "Un'isola senza auto, dove la strada più lenta è l'unica che porta alle spiagge.",
      "Il silenzio di Formentera è letterale, non una metafora di copertina.",
    ],
  },

  mallorca: {
    kind: "sea",
    tips: [
      "La Serra de Tramuntana va fatta con la Old Road, non con l'autostrada: dodici tornanti in quota tra Calvià e il porticciolo di Sóller.",
      "Le grotte di Drach non si visitano in autonomia: l'accesso è solo con guida, e sul lago c'è il concertino che chiude la visita.",
      "Le spiagge libere sono a nord, verso Pollensa e Cala Ratjada: sul sud il posto si decide con l'ombrellone, non con la macchina.",
    ],
    // Le tappe dell'isola girano attorno al mare: una cale, una baia, un tramonto.
// Palma e Sóller ci sono perché sono i due posti da vedere comunque, ma ogni
// giornata finisce in acqua, perché è quello che si cerca venendo a Mallorca.
    stops: [
      "Palma e la cattedrale, poi il tramonto dalla terrazza di Alcúdia",
      "Sóller e la Old Road, e la sera sulla baia di Port de Sóller",
      "Pollensa e Cala Boadella, con le grotte marine di Cala Varques",
      "Cala Figuera e Sant Elm, l'ultima spiaggia prima di rientrare",
    ],
    faqs: [
      {
        question: "Mallorca serve noleggiare l'auto?",
        answer:
          "Per vedere l'isola vera sì: senza auto resti a Palma o alle spiagge servite dal bus, che sono poche. Fuori dai villaggi il trasporto pubblico si ferma prima e le distanze sono più lunghe di quanto sembrino sulla mappa.",
      },
      {
        question: "Qual è il periodo migliore per Mallorca?",
        answer:
          "Da aprile a giugno e da settembre a ottobre: temperature gradevoli e code alle spiagge molto più corte. Luglio e agosto restano praticabili sulla costa, ma nell'interno sono bollenti.",
      },
      {
        question: "Nella Serra de Tramuntana serve un permesso?",
        answer:
          "Solo per i fuoristrada: dal 2023 i sentieri sulle piste forestali richiedono una prenotazione online gratuita, limitata nel numero di targhe per giorno.",
      },
    ],
    hooks: [
      "Un'isola che cambia faccia ogni volta che la strada sale di trecento metri.",
      "Il tramonto con le mani piene di arance di Sóller: il gesto più tipico dell'estate di Mallorca.",
    ],
  },

  ibiza: {
    kind: "sea",
    tips: [
      "Da metà giugno a metà agosto Ses Figueretes e Cala Comte sono piene anche all'alba: le spiagge tranquille sono a nord, verso Portinatx.",
      "L'accesso alle Cala Vedrà richiede prenotazione online nei mesi di punta, e la cala chiude per un'ora al giorno quando il mare sale.",
      "Oltre la barca, la bici elettrica è il modo più rapido per arrivare a Portinatx e alle cale dell'est, dove le piste sono sterrate.",
    ],
    stops: [
      "Dalt Vila e i suoi bastioni, e il tramonto dal molo",
      "Ses Figueretes e Cala Comte, di mattina presto",
      "Portinatx e Cala Llonga, le cale dell'est in bici elettrica",
      "Cala d'Hort e le grotte marine di Santa Eulària",
    ],
    faqs: [
      {
        question: "Ibiza è solo feste?",
        answer:
          "No: la parte nord, da Portinatx a Santa Eulària, è ruralissima, e le feste stanno quasi tutte a sud. Andare a nord in giornata è il modo migliore per vedere l'altra isola.",
      },
      {
        question: "Si può fare il bagno a Cala Comte?",
        answer:
          "Sì, ma con ingressi contingentati: le spiagge dell'ovest chiudono quando sono piene e riaprono quando si svuotano, quindi l'orario conta più del luogo.",
      },
      {
        question: "Come ci si sposta senza auto?",
        answer:
          "Il bus 401 collega Ibiza città alle spiagge sud ma copre un solo arco dell'isola. Lo scooter è la soluzione usata da tutti, con patente almeno da un anno e casco obbligatorio.",
      },
    ],
    hooks: [
      "Un'isola che di notte è una cosa e di mattina un'altra, con le stesse spiagge.",
      "Le pinete del nord: il contrasto più netto del Mediterraneo occidentale.",
    ],
  },

  creta: {
    kind: "sea",
    tips: [
      "La penisola di Gramvousa, a nord-ovest, ha strade sterrate vere: servono quattro ruote motrici o una barra anticaduta, e senza non si arriva a Balos.",
      "I musei archeologici di Chania e Heraklion meritano almeno due ore ciascuno, e vanno messi in programma la mattina, non a fine giornata.",
      "Le spiagge del sud, Matala e Kalamaki, sono le meno affollate; sulla costa nord le code arrivano già alle nove del mattino in punta d'estate.",
    ],
    stops: [
      "Chania e i mercati, e il tramonto dal porto veneziano",
      "La penisola di Gramvousa e la spiaggia di Balos",
      "Il lago di Kournas e la spiaggia di Georgioupoli",
      "Matala e le grotte sulla scogliera, al tramonto",
    ],
    faqs: [
      {
        question: "Creta si gira meglio in auto o in bus?",
        answer:
          "In auto, per forza: i bus collegano Chania, Heraklion e le grandi spiagge ma non arrivano dove servono gli itinerari veri, cioè le zone nord e le montagne del sud.",
      },
      {
        question: "Cosa vedere a Creta oltre alle spiagge?",
        answer:
          "I due musei archeologici, il palazzo di Cnosso e, se c'è tempo, le abbazie del monte Athos: senza questi Creta è solo mare.",
      },
      {
        question: "L'autonoleggio a Creta è tranquillo?",
        answer:
          "Le strade sono strette e maltenute ma ben segnalate, e il traffico si concentra sulla fascia costiera. Attenzione alle multe per eccesso di velocità fuori dai centri.",
      },
    ],
    hooks: [
      "L'isola più selvaggia di Grecia, dove il vino ha tremila anni di storia.",
      "Le terrazze d'argilla sotto Heraklion: il paesaggio agricolo più surreale del Mediterraneo.",
    ],
  },

  rodi: {
    kind: "sea",
    tips: [
      "Le spiagge dell'est, Lindos e Faliraki, sono organizzatissime; quelle vere sono a ovest, verso la costa di Kamiros Skala e Tsambika.",
      "Il Colosso di Felaketi si visita all'alba o al tramonto: a mezzogiorno la pietra bianca riflette una luce che rende impossibile leggere qualsiasi cosa.",
      "L'acropoli di Lindos ha gradini stretti nell'ultimo tratto: vanno scarpe buone, e si sale al mattino per evitare la coda.",
    ],
    stops: [
      "La città vecchia e il portale di Mandraki, e il tramonto dai bastioni",
      "Lindos e l'acropoli, con il bagno a St Paul's Bay",
      "Kamiros Skala e la baia di Arvaniti",
      "Tsambika e Prasonisi, le spiaghe dell'ovest",
    ],
    faqs: [
      {
        question: "Qual è la spiaggia più bella di Rodi?",
        answer:
          "Tsambika se vuoi il pieno del mare, Faliraki se vuoi sabbia e ombrelloni organizzati, Rodini se vuoi la vista sull'acropoli di Lindos e poca folla.",
      },
      {
        question: "Rodi serve il noleggio dell'auto?",
        answer:
          "Sì, e conviene: le spiagge dell'est sono a un'ora di strada e i bus non coprono la costa ovest. In estate si parcheggia nei villaggi, non davanti alle spiagge.",
      },
      {
        question: "Quanto dura il volo da Atene?",
        answer:
          "Poco più di un'ora, e c'è anche il traghetto notturno. Per un'isola sola tre o quattro giorni bastano e sono sufficienti.",
      },
    ],
    hooks: [
      "L'isola dei Cavalieri, con una fortezza medievale che ha visto passare diciassette secoli.",
      "Il tramonto a Lindos, quando il villaggio bianco si accende e il mare resta blu.",
    ],
  },

  corfù: {
    kind: "sea",
    tips: [
      "La costa nord-ovest, verso Paleokastritsa e Agios Georgios, ha le spiagge più belle e meno affollate della parte orientale.",
      "Il centro storico è dentro le mura: i vicoli portano al campanile della cattedrale, e la visita merita un'ora a piedi.",
      "Le escursioni in barca verso le grotte di Paleokastritsa vanno prenotate: le imbarcazioni sono poche e si esauriscono entro le nove del mattino.",
    ],
    stops: [
      "La città vecchia e i due forti, con il tramonto alla Spianada",
      "Paleokastritsa e le grotte marine",
      "Agios Georgios Pagon e la baia di Lapitha",
      "Agios Gordios e la baia di Glyfada, sulla costa nord-ovest",
    ],
    faqs: [
      {
        question: "Corfù è più tranquilla di altre isole greche?",
        answer:
          "Sì, e dipende dalla zona: a nord-ovest si trovano spiagge quasi deserte anche in agosto, mentre a sud, attorno a Lefkimmi e Kavos, il divertimento è organizzato e rumoroso.",
      },
      {
        question: "Qual è la spiaggia più bella di Corfù?",
        answer:
          "Per i panorami Paleokastritsa, con le grotte e i due isolotti davanti; per la tranquillità e il verde Agios Georgios, dove l'acqua è bassa.",
      },
      {
        question: "Meglio un quad o un'auto?",
        answer:
          "Un quad, se si resta sulla costa: le piste di nord-ovest sono strette e i parcheggi quasi inesistenti, e un quad si infila dove un'auto non entra.",
      },
    ],
    hooks: [
      "L'isola che il Veneto ha lasciato nel paesaggio, nei colori delle facciate e nelle imposte.",
      "Il Kinal, il liquore locale di erbe che profuma tutta l'isola.",
    ],
  },

  santorini: {
    kind: "sea",
    tips: [
      "Il tramonto a Oia è spettacolare ma impraticabile: si arriva in cima all'acropoli con un'ora di coda e si vede l'ombra di mezzo mondo.",
      "Le spiagge nere di Perissa e Kamari hanno acqua più fredda e meno vento di quella sotto le scogliere, e sono servite da taverne.",
      "Le escursioni in barca verso la caldera partono la mattina presto: sull'isola il sole è forte alle dieci e sul mare non c'è ombra.",
    ],
    stops: [
      "Fira e il sentiero dei camminatori fino a Oia",
      "Oia all'alba, quando il paese è ancora vuoto",
      "Akrotiri, il villaggio sepolto sotto la lava",
      "Perissa e Kamari, e la spiaggia nera",
    ],
    faqs: [
      {
        question: "Oia vale la pena o è solo folla?",
        answer:
          "Vale la pena alle sette del mattino, quando si è soli, oppure dopo le nove di sera, quando le navi lasciano. A metà giornata è una fila.",
      },
      {
        question: "Santorini ha sabbia?",
        answer:
          "Quasi mai: le spiagge sono nere, vulcaniche, e l'acqua scende subito. Se la sabbia è un requisito, va verificata una delle poche spiagge di Perissa o Vlychada.",
      },
      {
        question: "Come si gira a Santorini?",
        answer:
          "Meglio con un quad o un'auto piccola: gli autobus collegano Fira a Perissa e a Oia ma non i punti di vista, che sono su strade strette e senza parcheggio.",
      },
    ],
    hooks: [
      "Un'isola che è il bordo di un vulcano: metà dell'acropoli pende ancora sulla caldera.",
      "Il bianco che non è un colore ma un secolo di ristrutturazioni senza licenza.",
    ],
  },

  calabria: {
    kind: "coast",
    tips: [
      "Il Pollino è la parte meno sfruttata della regione: il sentiero del Bidente sale fra faggi secolari e va fatto con scarpe da trekking.",
      "La Costa Viola, fra Scilla e Bagnara Calabra, ha acqua bassa e spiagge libere: è l'unico tratto dove si fa il bagno senza folla anche a Ferragosto.",
      "Il peperoncino di Cetraro, nella Sila, è la firma della cucina calabrese: si compra dai produttori e si usa anche in salse che si vendono al banco.",
    ],
    stops: [
      "Tropea e la frazione di Santa Maria dell'Isola",
      "Capo Vaticano e le grotte dell'Arena",
      "Il Pollino, fra Orsomarso e la vetta di Miletto",
      "Scilla e la Costa Viola",
    ],
    faqs: [
      {
        question: "La Calabria è cara?",
        answer:
          "Meno di altre isole del Mediterraneo, soprattutto sul mare: gli hotel sul Tirreno stanno sui 60-80 euro a notte e la cena con pesce locale restano sotto i 30.",
      },
      {
        question: "Dove si fa il bagno in Calabria?",
        answer:
          "Sul versante tirrenico le spiagge sono vere e l'acqua è fresca; sullo Ionio molte sono di ciottoli scendenti, con acqua bassa e fondale mobile.",
      },
      {
        question: "Vale la pena fare più di una tappa?",
        answer:
          "Sì, e con la macchina: in cinque giorni conviene fare tirreno e Sila, ionio e Pollino, perché le due coste hanno mare e cucina diversi e distano almeno tre ore.",
      },
    ],
    hooks: [
      "Una costa che scende dal Pollino al mare in venti chilometri, con due mari a due ore di macchina.",
      "La 'nduja, il peperoncino che sa di mare anche quando il mare è lontano.",
    ],
  },

  puglia: {
    kind: "coast",
    tips: [
      "A Polignano a Mare le grotte si vedono dal mare: la spiaggia di Lama Monachile è sul ciglio del burrone e la cala sotto la scogliera si raggiunge a piedi.",
      "Ad Alberobello i trulli si visitano davvero solo dentro la fascia monumentale, anche se fuori il borgo è pieno di altre case bianche col tetto conico.",
      "Nel Salento la sabbia bianca di Santa Maria di Leuca è calda e senza ombra: le spiagge servite da ombrelloni sono invece Otranto e le spiagge urbane.",
    ],
    stops: [
      "Bari e il vecchio quartiere, con le orecchie di bologna",
      "Polignano, le grotte e le spiagge sotto la scogliera",
      "Alberobello e i trulli",
      "Lecce barocca, o le cale a nord di Otranto",
    ],
    faqs: [
      {
        question: "Puglia senza auto si fa?",
        answer:
          "Bari, Polignano, Alberobello e Lecce sono collegati bene da treni e bus, ma le cale del Salento e le zone interne restano irraggiungibili senza macchina.",
      },
      {
        question: "La pizza pugliese è diversa?",
        answer:
          "Sì: più soda, mozzarella di bufala che si sfilaccia in forno e un impasto che non si piega mai. Va assaggiata in loco perché non è la stessa cosa.",
      },
      {
        question: "Che periodo scegliere?",
        answer:
          "Maggio, giugno e settembre: abbastanza caldo per il mare, ma senza l'afa di luglio e agosto, che sulla costa salentina sono pesanti.",
      },
    ],
    hooks: [
      "Il bianco assoluto di Locorotondo e Cisternino, città costruite con la stessa calce.",
      "L'oleandro e il muretto a secco: il paesaggio della Puglia è fatto di cose che resistono al vento.",
    ],
  },

  sardegna: {
    kind: "coast",
    tips: [
      "La Costa Verde, fra Santa Teresa e Buggerru, è fatta di falesie e acqua verde: gli accessi alle spiagge sterrate vanno fatti con scarpe chiuse.",
      "Per la Barbagia e la Planargia la macchina è indispensabile: distanze apparentemente brevi diventano quaranta minuti di strada senza incroci.",
      "La spiaggia di Berchida, poco dopo Solanas, ha l'acqua più trasparente dell'isola: si vede il fondo a dieci metri e il posto finisce entro il primo di luglio.",
    ],
    stops: [
      "Cagliari e il quartiere di Castello",
      "La Costa Verde e le spiagge sotto le falesie",
      "La Barbagia e il nuraghe di Arrubiu",
      "Berchida e la penisola di Sinis, con i fenicotteri rosa",
    ],
    faqs: [
      {
        question: "Sardegna serve l'auto?",
        answer:
          "In estate serve per forza: i trasporti pubblici coprono le coste maggiori e lasciano fuori le spiagge e i borghi interni, che è metà delle cose da vedere.",
      },
      {
        question: "Qual è la spiaggia più bella?",
        answer:
          "Cala Brandinchi per il colore, Berchida per la trasparenza, La Pelosa per la forma, anche se è l'unica raggiungibile in giornata senza auto.",
      },
      {
        question: "Sardegna quando conviene?",
        answer:
          "Da maggio a giugno e da metà settembre a ottobre. L'agosto è pieno e le spiagge del sud, verso Villasimius, sono imperibili.",
      },
    ],
    hooks: [
      "Un'isola che ha ventimila nuraghi e nessuno spettacolo: il silenzio è la sua firma.",
      "Il pane in cassetta, che a Cagliari si mangia ancora caldo alle sei del mattino.",
    ],
  },

  sicilia: {
    kind: "coast",
    tips: [
      "Le scale di Taormina, lo scalone del vecchio rione, sono un sentiero privato e abitato: si sale con civiltà, e la vista sull'Etna si apre una volta sola.",
      "Le catacombe di San Giovanni e le cripte di Noto e Siracusa aprono presto e chiudono prima: vanno messe in programma per prime, non a fine giornata.",
      "Sul Val di Noto si passa da una città barocca all'altra in mezz'ora di macchina, e ogni tappa ha la sua pasticceria.",
    ],
    stops: [
      "Siracusa e l'Ortigia barocca",
      "Noto e la cattedrale",
      "Ragusa Ibla e Modica",
      "L'Etna: le creste o le città del caffè",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per la Sicilia?",
        answer:
          "Una settimana per il sud, fra Siracusa, Noto e il Val di Noto, e una in più se si aggiunge l'Etna o Palermo. Sette giorni per tutta l'isola sono pochi.",
      },
      {
        question: "È sicuro andare in Sicilia?",
        answer:
          "Il sud è più sicuro del nord nei dati sul crimine, ma i furti in auto e nelle spiagge libere esistono: basta non lasciare nulla a vista e non parcheggiare in vie isolate.",
      },
      {
        question: "Le carrozze del Val di Noto si possono noleggiare?",
        answer:
          "Sì, e in estate vanno prenotate con giorni: i giri turistici sono pochi e per fare Noto, Modica e Ragusa in giornata ne servono tre.",
      },
    ],
    hooks: [
      "Il barocco tardo di Noto, ricostruito dopo il terremoto e diventata la città più fotogenica del sud.",
      "L'Etna di notte: il vulcano che si scalda fino a mille metri mentre si guarda.",
    ],
  },

  "costiera amalfitana": {
    kind: "coast",
    tips: [
      "La Costiera si fa meglio in barca o a piedi che in macchina: la strada è lunghissima e nei giorni di punta si percorre in tempi doppi.",
      "La Grotta Azzurra si visita solo in barca e solo con certe condizioni di mare: con vento si salta, e va prenotata il giorno prima.",
      "La Via degli Dei, da Bomerano a Nocelle, si percorre in discesa in tre ore e richiede scarpe chiuse: la gradinata finale è ripida e non ha corrimano.",
    ],
    stops: [
      "Amalfi, il duomo e la scalinata che porta al porto",
      "Positano e la spiaggia di Fornillo",
      "Ravello, i giardini di Villa Cimbrone e il Belvedere",
      "La Via degli Dei da Bomerano a Nocelle",
    ],
    faqs: [
      {
        question: "La Costiera si fa in auto?",
        answer:
          "Si può, ma è sconsigliato in estate: parcheggi a pagamento, traffico bloccato e la barca è più veloce. Chi noleggia lo fa per i monti, non per la costa.",
      },
      {
        question: "Positano o Amalfi?",
        answer:
          "Positano è più bella e più cara, con spiagge poche e ripide; Amalfi è più pratica, con il porto grande da cui partono i traghetti e le escursioni.",
      },
      {
        question: "Le escursioni in barca sono sicure?",
        answer:
          "Con mare calmo e operatori regolari sì. Evitate le proposte a prezzo basso offerte per strada: le imbarcazioni devono avere l'iscrizione e il capitano a bordo.",
      },
    ],
    hooks: [
      "Una costa dove ogni pianta arrampicata è stata messa lì a mano, mattina dopo mattina.",
      "I limoni di Amalfi: così grandi che servono tre mani per portarli al mare.",
    ],
  },

  "isola d'elba": {
    kind: "sea",
    tips: [
      "Per vedere l'isola serve la macchina: le spiagge dell'est, fra Rio Marina e Biodola, sono separate da tornanti e si fa solo su strada.",
      "La strada sterrata che porta alla Fortezza di Montecristo si può fare solo a piedi, e sono quaranta minuti di salita con una vista che ripaga.",
      "Le spiagge termali di San Piero in Campo hanno libero accesso e acqua calda: sono le uniche del genere e vanno provate.",
    ],
    stops: [
      "Portoferraio e la fortezza di San Giacomo, con il tramonto dal molo",
      "Marina di Campo e la spiaggia di Barberino, con la Fortezza di Montecristo in vista",
      "Cavoli e la Baia di Mola, le spiagge dell'est",
      "San Piero in Campo e le spiagge termali",
    ],
    faqs: [
      {
        question: "L'Elba si gira senza auto?",
        answer:
          "Si può fare una parte in treno e bus, ma le spiagge dell'est restano difficili: anche un'auto piccola sblocca metà isola.",
      },
      {
        question: "Da dove si parte per l'Elba?",
        answer:
          "Dal porto di Piombino con traghetto, quarantacinque minuti, o dalla Corsica. In estate i posti auto sul traghetto vanno prenotati e conviene partire al mattino.",
      },
      {
        question: "Quanti giorni servono?",
        answer:
          "Tre bastano per la parte principale, quattro se si vuole arrivare a Capraia o fare le spiagge termali senza correrci dentro.",
      },
    ],
    hooks: [
      "L'isola dove Napoleone ha atteso e poi è fuggito: la fortezza di San Giacomo è ancora lì.",
      "Il pino marittimo della Mola, una pianta secolare che per la sua posizione è la più bella dell'Asse.",
    ],
  },

  malta: {
    kind: "coast",
    tips: [
      "A Malta si va in bus, e va bene: la rete collega tutti i centri, e il mezzo pubblico costa una frazione del taxi anche quando il taxi sembra conveniente.",
      "Le spiagge di sabbia sono quasi solo a nord: Golden Bay e la baia di Għajn Ħadid sono le due vere, il resto è roccia.",
      "Mdina, la città silenziosa, si visita la mattina presto o dopo le sei: a metà giornata pullula di gruppi turistici.",
    ],
    stops: [
      "Valletta e le Tre Città",
      "Mdina e le catacombe",
      "Gozo e la città di Victoria",
      "Le spiagge a nord e le isole di Malta",
    ],
    faqs: [
      {
        question: "Malta è cara?",
        answer:
          "Comparativamente no, se si sceglie bene: mangiare fuori costa meno che sul continente italiano, e l'unica voce che pesa è il noleggio dell'auto, che si può evitare con i bus.",
      },
      {
        question: "Quanti giorni servono per Malta?",
        answer:
          "Tre per Malta e un quarto per Gozo, che ha una sua anima e va visitata come un'isola a parte.",
      },
      {
        question: "Si può arrivare in auto?",
        answer:
          "Il traghetto dalla Sicilia c'è, ma il collegamento con i veicoli è più raro e va prenotato con settimane di anticipo.",
      },
    ],
    hooks: [
      "Un labirinto di mura a picco sul mare, con un blu che non si vede in Italia.",
      "Il pastiz, una torta di timo e mandorle che si mangia stando in piedi.",
    ],
  },

  marocco: {
    kind: "mixed",
    tips: [
      "Da ottobre ad aprile il clima di Marrakech è perfetto; in estate le medine si svuotano e il caldo è da non vivere.",
      "Medina e kasbah vanno visitati senza bazar, che vuol dire al mattino presto, quando i negozi sono ancora chiusi e le porte aperte.",
      "Il deserto di Merzouga si raggiunge con tre giorni di viaggio, non con un'escursione: servono due notti fra il Vallo del Drâa e le dune.",
    ],
    stops: [
      "Marrakech: la medina, il Bahia e la Koutoubia",
      "Ait Ben Haddou, la città fortificata del Vallo del Drâa",
      "Merzouga e le dune dell'Erg Chebbi",
      "Fes, la medina medievale e la scuola di legno",
    ],
    faqs: [
      {
        question: "Il Marocco è sicuro?",
        answer:
          "Le città imperiali e turistiche sono sicure, e il Sud sahariano richiede invece organizzazione e guida locale. Con un tour organizzato il problema non si pone.",
      },
      {
        question: "Servono molti soldi?",
        answer:
          "Meno di altre mete esotiche, e si può stare in riad economiche in medina. Il costo principale, come sempre, sono i voli.",
      },
      {
        question: "Si può noleggiare l'auto?",
        answer:
          "In città no, e nel deserto assolutamente no. Per le tappe lunghe si va con driver e fuoristrada, che è anche il modo più sicuro.",
      },
    ],
    hooks: [
      "Il contrasto che regge tutta la regione: una città rossa e un deserto che non parla.",
      "Il tè alla menta, servito tre volte di fila, e il pane appena uscito dal forno.",
    ],
  },

  istanbul: {
    kind: "city",
    tips: [
      "Il traghetto fra Europa e Asia costa pochi centesimi e ci mette venti minuti: è il modo migliore per passare dal Corno d'Oro alla costa asiatica.",
      "Il Grand Bazaar e il Bazar delle Spezie chiudono per la preghiera del mezzogiorno e riaprono: meglio evitare l'ora di pranzo se si vuole comprare.",
      "Le moschee maggiori chiudono ai visitatori durante le preghiere: gli orari cambiano ogni giorno e vanno controllati la mattina stessa.",
    ],
    stops: [
      "Sultanahmet e la moschea di Santa Sofia",
      "Il Palazzo Topkapi e i giardini",
      "Galata e la Torre della Ghiotcia",
      "Kadıköy, il mercato del pesce sulla sponda asiatica",
    ],
    faqs: [
      {
        question: "Istanbul è una città sicura?",
        answer:
          "Nella zona turistica è molto tranquilla, anche se va evitato İstiklal, la strada con i locali economici dove le riprese sono sgradite.",
      },
      {
        question: "Quanti giorni servono?",
        answer:
          "Tre per la penisola europea, quattro se si aggiunge Kadıköy e un quinto per la città d'Asia sull'altra sponda.",
      },
      {
        question: "Meglio hotel sul Bosforo o nel centro?",
        answer:
          "Il centro, vicino a Sultanahmet, è più comodo e costa meno. Sul Bosforo si paga la vista, che non ripaga di più a piedi da Sultanahmet.",
      },
    ],
    hooks: [
      "Due continenti nella stessa città, separati da venti minuti di traghetto.",
      "Il tramonto sul Corno d'Oro, con le moschee in controluce come cartoline.",
    ],
  },

  "new york": {
    kind: "city",
    tips: [
      "New York si gira a piedi e in metro: il traffico di auto è un problema per chi arriva, non per chi visita.",
      "Il sabato e la domenica Central Park e Brooklyn Bridge chiudono alle auto e diventano ciclabili: è il momento migliore per vederli.",
      "Per l'alto New York servono più di due ore: salire al primo treno del mattino e scendere alle sei è la differenza fra vedere e fotografare code.",
    ],
    stops: [
      "Central Park e il Metropolitan Museum",
      "Times Square e il Rock Center",
      "Soho, il Nolita e le scale del vecchio Little Italy",
      "Brooklyn e il ponte, la sera",
    ],
    faqs: [
      {
        question: "New York è cara?",
        answer:
          "Molto meno di quanto sembri se si evitano gli hotel a Manhattan: la metro ha tariffa fissa e mangiare fuori conviene nei quartieri fuori dalla penisola.",
      },
      {
        question: "Quanto tempo servono?",
        answer:
          "Quattro giorni pieni sono il minimo, sette permettono di aggiungere i quartieri alti, che con i ritmi del sottosuolo richiedono una giornata intera ciascuno.",
      },
      {
        question: "Meggio hotel o ostello?",
        answer:
          "Dipende dal budget: a New York si dorme peggio che a Londra a parità di spesa, ma si va in posti che a Londra non esistono.",
      },
    ],
    hooks: [
      "Una città che si attraversa in otto minuti di metro e si vive in otto ore di traffico.",
      "Ogni palazzo ha un numero, e da quello si capisce il quartiere prima di arrivarci.",
    ],
  },

  parigi: {
    kind: "city",
    tips: [
      "Nei musei la prima ora è la meno affollata: aprono presto e alle dieci le code si allungano.",
      "Il giardino delle Tuileries e il cortile del Louvre si possono attraversare liberamente, e sono gli unici passaggi per passare da un rive all'altro.",
      "Sul treno per Versailles la prima classe vale la differenza: la seconda nei momenti di punta è al livello della piscina.",
    ],
    stops: [
      "Louvre e i giardini delle Tuileries",
      "Montmartre e il Sacré-Cœur, la mattina presto",
      "Le Marais e il quartiere latino",
      "Versailles, con la Galleria degli Specchi",
    ],
    faqs: [
      {
        question: "Parigi è visitabile in tre giorni?",
        answer:
          "Sì, accettando che siano tre giorni di maratona. Meglio quattro, con un giorno per Versailles, che non si fa insieme a tutto il resto.",
      },
      {
        question: "Conviene comprare il pass musei?",
        answer:
          "Solo per le mete minori, Orsay e Orangerie: Louvre e Versailles vanno comprati singolarmente, perché costano più di quanto copra il pass.",
      },
      {
        question: "La metro è complicata?",
        answer:
          "No, e funziona bene. Le linee 1, 4 e 6 passano dai siti principali, e l'ultima corsa è intorno all'una: le notti si organizzano prima.",
      },
    ],
    hooks: [
      "Il modo parigino di vivere una città: si sta fuori, e la città si guarda da lì.",
      "I boulevard, dove la città si allarga di colpo e la luce arriva per sei chilometri di fila.",
    ],
  },

  londra: {
    kind: "city",
    tips: [
      "La Underground funziona con la contactless, senza biglietto: è il modo più semplice e anche il più economico per spostarsi in città.",
      "I musei nazionali sono gratis: la National Gallery, la British Gallery e il Victoria and Albert si visitano senza acquistare nulla.",
      "A Londra si cammina molto e piove: un ombrello pieghevole e scarpe impermeabili cambiano la giornata più di qualsiasi programma.",
    ],
    stops: [
      "Westminster e il Big Ben, dal South Bank",
      "Il British Museum e Bloomsbury",
      "Tower of London e Tower Bridge",
      "Notting Hill, Portobello e i mercati",
    ],
    faqs: [
      {
        question: "Londra è cara?",
        answer:
          "Meno di quanto si temano sui musei, che sono gratis, ma molto sui voli e sull'hotel. La mobilità è la voce che pesa di più in assoluto.",
      },
      {
        question: "Quanto tempo servono?",
        answer:
          "Quattro giorni sono giusti per le parti essenziali, sei se si vuole aggiungere una gita fuori porta come Oxford o Bath.",
      },
      {
        question: "Serve la Tube?",
        answer:
          "Sì, e la Travelcard conviene solo se si usano molte tratte: con la contactless giornaliera si paga il massimo del giorno e spesso costa meno.",
      },
    ],
    hooks: [
      "Quattro contee che sono quattro città diverse dentro la stessa capitale.",
      "Il cielo di Londra è basso e rosso all'alba: metà città si sveglia guardandolo dal ponte.",
    ],
  },

  venezia: {
    kind: "city",
    tips: [
      "Venezia si visita in barca o a piedi: le auto non entrano nel centro storico e quelle ai parcheggi di Marghera sono un trucco.",
      "Il vaporetto, anche solo con il biglietto giornaliero, è il modo più economico di muoversi fra le isole: una giornata intera costa meno di un singolo water taxi.",
      "Basilica e Palazzo Ducale si vedono in un'ora e mezza se si prenota l'ingresso con orario: senza prenotazione si fa una fila di ore.",
    ],
    stops: [
      "San Marco e il Palazzo Ducale",
      "Il Cannaregio e i due Gesuiti",
      "Murano e Burano con il vaporetto",
      "La Giudecca e San Giorgio Maggiore",
    ],
    faqs: [
      {
        question: "Venezia conviene?",
        answer:
          "In estate i prezzi dei musei sono alti ma restano sotto altre città d'arte d'Europa. Fuori stagione è la città più bella da girare in assoluto.",
      },
      {
        question: "Serve comprare il vaporetto?",
        answer:
          "Sì, se si visitano anche le isole: il biglietto giornaliero illimitato copre la rete intera, mentre un traghetto singolo costa una cifra.",
      },
      {
        question: "Dove dormire?",
        answer:
          "Vicino a Cannaregio o Santa Croce, che hanno meno rumore notturno e prezzi più bassi di San Marco, che è bellissimo e caro.",
      },
    ],
    hooks: [
      "Una città senza strade: si attraversa l'acqua e si arriva solo con la barca.",
      "Le barche da carico di un'ora fa: Venezia è più lenta di quanto sembri alle dieci del mattino.",
    ],
  },
};

/**
 * Alias: nome con cui una destinazione arriva davvero → chiave della tabella.
 *
 * Non aggiungono contenuto: dicono solo che due nomi sono lo stesso posto, così
 * la forma breve di un nome non resta senza conoscenza.
 */
const ALIASES: Record<string, string> = {
  elba: "isola d'elba",
  "isola elba": "isola d'elba",
  // L'apostrofo: `normalizeForMatch` lo conserva, quindi un nome con
  // "d'Elba" va dichiarato anche nella forma senza, che è quella che arriva
  // quando la destinazione viene digitata o ripulita.
  "isola d elba": "isola d'elba",
  maiorca: "mallorca",
  menorca: "mallorca",
  "isola di menorca": "mallorca",
  candia: "creta",
  // La chiave è normalizzata come il nome che arriva: `normalizeForMatch`
  // toglie maiuscole e diacritici, quindi anche le chiavi degli alias vanno
  // scritte in minuscolo. Con "rodi Grecia" la voce era irraggiungibile — la
  // ricerca non la incontrava mai — e "Rodi Grecia" non trovava la conoscenza
  // del posto, restituendo i consigli generici su qualunque viaggio.
  "rodi grecia": "rodi",
  rhodes: "rodi",
  corfu: "corfù",
  kerkyra: "corfù",
  thira: "santorini",
  positano: "costiera amalfitana",
  amalfi: "costiera amalfitana",
  amalfiti: "costiera amalfitana",
  "valle d'itria": "puglia",
  trulli: "puglia",
  egadi: "sicilia",
  eolie: "sicilia",
  "isole eolie": "sicilia",
  palermo: "sicilia",
  catania: "sicilia",
  napoli: "sicilia",
  marrakech: "marocco",
  marrakesh: "marocco",
  tunisi: "marocco",
  nyc: "new york",
  "nuova york": "new york",
  newyork: "new york",
  paris: "parigi",
  london: "londra",
};

/**
 * La conoscenza di un luogo, o `null` se il luogo non è noto.
 *
 * `null` non è un errore: significa che la copy userà i dati commerciali
 * disponibili e i consigli sulla struttura del viaggio. È la risposta onesta per
 * le centinaia di destinazioni che un'agenzia può chiedere e che nessuna
 * tabella può coprire.
 */
export function knowledgeFor(place: string): DestinationKnowledge | null {
  const key = normalizeForMatch(place ?? "");
  if (!key) return null;

  const resolved = ALIASES[key] ?? key;
  const exact = KNOWLEDGE[resolved];
  if (exact) return exact;

  // Il nome che arriva qui non è sempre il nome del luogo: può avere davanti o
  // dietro un aggettivo ("i segreti di Formentera", "travel tips Formentera") o
  // il formato editoriale ("Mallorca itinerario"). Per questo, se la chiave
  // esatta non c'è, si cerca una destinazione nota che il nome **termini** con:
  // è la coda di una frase a nominare il posto, e la coda è la parte che
  // identifica.
  //
  // Si prende la corrispondenza più lunga, così "Isola d'Elba" vince su "Elba"
  // quando il nome contiene entrambi, e non viceversa.
  const tails = Object.keys(KNOWLEDGE)
    .filter((candidate) => key === candidate || key.endsWith(` ${candidate}`))
    .sort((a, b) => b.length - a.length);
  for (const tail of tails) {
    const entry = KNOWLEDGE[tail];
    if (entry) return entry;
  }
  return null;
}

/** `true` se il luogo ha una conoscenza curata. */
export function hasCuratedKnowledge(place: string): boolean {
  return knowledgeFor(place) !== null;
}

/**
 * Le destinazioni con una conoscenza curata.
 *
 * Serve ai test e al debug: permette di verificare la tabella intera senza
 * dover elencare a mano i posti su cui si vuole contare. Non è un elenco per
 * l'utente: la conoscenza si sceglie per nome, e un elenco a schermo
 * suggerirebbe che gli altri posti non si possono scrivere.
 */
export function curatedDestinations(): string[] {
  return Object.keys(KNOWLEDGE).sort();
}