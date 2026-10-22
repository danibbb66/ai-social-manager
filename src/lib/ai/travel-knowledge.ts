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

  thailandia: {
    kind: "sea",
    tips: [
      "Il periodo migliore sul lato Andaman va da novembre ad aprile: il mare è calmo e le spiagge sono aperte, mentre da maggio a ottobre il monsone chiude molti approdi.",
      "Fra le isole ci si muove in long-tail boat o traghetto: i prezzi variano molto fra alta e bassa stagione e conviene confermare l'orario la sera prima.",
      "Sul mare serve una protezione solare resistente all'acqua: il sole equatoriale brucia anche in barca, dove il vento nasconde la scottatura.",
    ],
    stops: [
      "Krabi e le scogliere di Railay",
      "Phi Phi e la baia di Maya",
      "Phuket e la baia di Phang Nga",
      "Ko Samui e il parco marino di Ang Thong",
    ],
    faqs: [
      {
        question: "Qual è il periodo migliore per il mare in Thailandia?",
        answer:
          "Da novembre ad aprile sul lato Andaman (Krabi, Phi Phi, Phuket): il mare è calmo e l'acqua limpida. Da maggio a ottobre piove e molte escursioni in barca si fermano.",
      },
      {
        question: "Phi Phi o Phuket?",
        answer:
          "Phi Phi ha le baie più scenografiche ma poche spiagge grandi e molta presenza turistica; Phuket ha più servizi e spiagge accessibili. Krabi è il compromesso migliore.",
      },
      {
        question: "Serve prenotare le escursioni in barca?",
        answer:
          "In alta stagione sì: le barche verso Maya Bay e le isole si riempiono, e prenotando la sera prima si evita di perdere la mattinata.",
      },
    ],
    hooks: [
      "Acqua turchese sotto pareti di roccia, e barche lunghe che scivolano tra le isole.",
      "Il mare della Thailandia è un arcipelago: si va di baia in baia e ogni approdo è un'altra cartolina.",
    ],
  },

  kenya: {
    kind: "sea",
    tips: [
      "La costa keniota è calda tutto l'anno, ma il mare più calmo è da dicembre a marzo e da luglio a ottobre: sono i mesi migliori per le barche e lo snorkeling.",
      "Diani e Watamu hanno barriere coralline protette: si entra con la guida e si paga un piccolo ticket del parco marino, che conviene includere prima dell'escursione.",
      "Sulla costa serve la protezione solare e il repellente: le zanzare sono attive al tramonto e le prime ore del mattino.",
    ],
    stops: [
      "Diani Beach e la barriera corallina",
      "Watamu e il parco marino",
      "Mombasa e la città vecchia",
      "Lamu e l'arcipelago",
    ],
    faqs: [
      {
        question: "Qual è la spiaggia migliore in Kenya?",
        answer:
          "Diani Beach è la più lunga e attrezzata, Watamu è più tranquilla e vicina alla barriera corallina. Entrambe hanno mare caldo e sabbia bianca.",
      },
      {
        question: "Si può fare snorkeling in Kenya?",
        answer:
          "Sì, nei parchi marini di Watamu e Diani: la barriera è protetta e si entra accompagnati. Il periodo migliore è quando il mare è calmo, da dicembre a marzo.",
      },
      {
        question: "Costa o safari?",
        answer:
          "Sono due esperienze diverse: la costa è il mare e il relax, il safari è Maasai Mara. Molti abbinano i due con un volo interno, ma non si fanno nello stesso giorno.",
      },
    ],
    hooks: [
      "Sabbia bianca, acqua calda e la barriera a pochi bracciate dalla riva.",
      "La costa del Kenya è lunga e luminosa: mare aperto da una parte, palme e villaggi dall'altra.",
    ],
  },

  bali: {
    kind: "sea",
    tips: [
      "La stagione asciutta va da aprile a ottobre, che è anche il periodo col mare più limpido sul lato sud; da novembre il monsone porta pioggia e onde alte.",
      "Per gli spostamenti conviene noleggiare uno scooter con patente internazionale: le distanze sono brevi ma il traffico del sud è lento.",
      "Nusa Penida si raggiunge in traghetto da Sanur: la traversata dura circa mezz'ora e in alta stagione va prenotata il giorno prima.",
    ],
    stops: [
      "Nusa Penida e la spiaggia di Kelingking",
      "Uluwatu e il tempio sull'oceano",
      "Seminyak e le spiagge del sud",
      "Ubud e le risaie a terrazze",
    ],
    faqs: [
      {
        question: "Dov'è il mare più bello a Bali?",
        answer:
          "A Nusa Penida e Uluwatu: scogliere sul mare e baie dall'acqua limpida. Le spiagge del sud (Seminyak, Canggu) sono più attrezzate ma con onde da surf.",
      },
      {
        question: "Uluwatu o Nusa Penida?",
        answer:
          "Uluwatu ha il tempio sulla scogliera e i tramonti, Nusa Penida ha la spiaggia di Kelingking e le calette isolate. Se il mare è calmo, Nusa Penida vale il traghetto.",
      },
      {
        question: "Serve la patente internazionale per lo scooter?",
        answer:
          "Sì, e senza assicurazione adeguata i controlli fermano i turisti al primo posto di blocco. Meglio averla per noleggiare in sicurezza.",
      },
    ],
    hooks: [
      "Scogliere a picco sull'oceano e terrazze di riso che scendono verso il mare.",
      "Bali è fatta di contrasti: il blu dell'acqua, il verde del riso, il fuoco dei tramonti.",
    ],
  },

  maldive: {
    kind: "sea",
    tips: [
      "Ogni isola delle Maldive è un atollo raggiungibile solo in barca o idrovolante: il trasferimento dall'aeroporto va concordato con il resort prima di partire.",
      "La stagione asciutta va da novembre ad aprile, che è anche il periodo con l'acqua più trasparente e il mare più calmo per lo snorkeling.",
      "Il sole è quasi equatoriale: la protezione solare va riapplicata spesso, anche in acqua, perché la riflessione della laguna raddoppia l'esposizione.",
    ],
    stops: [
      "Malé e l'atollo di Ari",
      "L'atollo di Baa e la baia delle mante",
      "La laguna e la barriera corallina",
      "Le isole e le ville sull'acqua",
    ],
    faqs: [
      {
        question: "Qual è il periodo migliore per le Maldive?",
        answer:
          "Da novembre ad aprile: mare calmo, acqua trasparente e poco vento. Da maggio a ottobre può piovere, ma le isole restano visitabili con prezzi più bassi.",
      },
      {
        question: "Si può fare snorkeling dalla spiaggia?",
        answer:
          "Sì, in molti atolli la barriera corallina è a pochi passi dalla riva. Le mante dell'atollo di Baa si vedono meglio con un'escursione in barca.",
      },
      {
        question: "Come ci si sposta fra le isole?",
        answer:
          "Con barche veloci o idrovolante: le isole non hanno strade di collegamento. Il trasferimento si organizza quasi sempre tramite il resort.",
      },
    ],
    hooks: [
      "Lagune turchesi e ville sull'acqua: il mare che arriva fino alla porta.",
      "Alle Maldive l'acqua è così trasparente che la barriera si vede dalla spiaggia.",
    ],
  },

  zanzibar: {
    kind: "sea",
    tips: [
      "Il mare più limpido è a nord, a Nungwi e Kendwa: sabbia bianca, acqua turchese e quasi sempre calma.",
      "La marea conta: su molte spiagge dell'est (Paje, Jambiani) il mare si ritira per decine di metri, quindi l'ora del bagno si sceglie guardando le maree.",
      "Stone Town si gira a piedi, meglio al mattino presto o al tramonto, quando i vicoli sono freschi e il mercato delle spezie è vivo.",
    ],
    stops: [
      "Nungwi e Kendwa, le spiagge del nord",
      "Stone Town e il mercato delle spezie",
      "Paje e la laguna dell'est",
      "L'atollo di Mnemba e la barriera corallina",
    ],
    faqs: [
      {
        question: "Qual è il mare più bello a Zanzibar?",
        answer:
          "A nord, a Nungwi e Kendwa: sabbia bianca, acqua turchese e quasi sempre calma. A est, Paje e Jambiani hanno maree forti e lagune basse, belle per il kitesurf ma non per nuotare a tutte le ore.",
      },
      {
        question: "Quando andare a Zanzibar?",
        answer:
          "Da giugno a ottobre e da dicembre a febbraio: stagione asciutta, mare calmo e limpido. Le piogge lunghe cadono da marzo a maggio.",
      },
      {
        question: "Serve il visto o vaccini per Zanzibar?",
        answer:
          "Il visto si ottiene all'arrivo, e la profilassi antimalarica è consigliata per chi visita l'interno. Sulla costa il rischio è basso, ma la profilassi resta raccomandata.",
      },
    ],
    hooks: [
      "Acqua turchese che sfuma nel bianco della sabbia, e dhow a vela latina all'orizzonte.",
      "Zanzibar è l'isola delle spezie: il profumo di chiodi di garofano arriva prima ancora di scendere dal traghetto.",
    ],
  },

  amsterdam: {
    kind: "city",
    tips: [
      "Amsterdam si gira in bici o a piedi: i tram coprono il centro, ma i canali si attraversano meglio sul ciglio dell'acqua, lontano dal traffico.",
      "Il Rijksmuseum e il Van Gogh Museum richiedono la prenotazione online: senza si fa la fila solo per il biglietto, e in alta stagione si rischia il tutto esaurito.",
      "Le case galleggianti si vedono meglio da Prinsengracht e Keizersgracht, la mattina presto, quando i canali sono calmi e i riflessi sono più nitidi.",
    ],
    stops: [
      "Canali e case galleggianti",
      "Rijksmuseum e Museumplein",
      "Il quartiere Jordaan",
      "Mulini a vento e Zaanse Schans",
    ],
    faqs: [
      {
        question: "Amsterdam conviene girarla in bici?",
        answer:
          "Sì, è il mezzo più naturale: le piste ciclabili sono ovunque e il centro è piatto. Basta solo prestare attenzione ai tram e ai pedoni nelle vie più trafficate.",
      },
      {
        question: "Quanto tempo serve per Amsterdam?",
        answer:
          "Tre giorni bastano per la città vera: canali, musei e quartieri. Un quarto giorno permette la gita ai mulini di Zaanse Schans, a mezz'ora in treno.",
      },
      {
        question: "Amsterdam è solo coffee shop e vie a luci rosse?",
        answer:
          "No, sono una piccola parte del centro: il resto è fatto di canali, musei e quartieri residenziali tranquilli, che spesso chi resta due giorni non vede nemmeno.",
      },
    ],
    hooks: [
      "Una città dove l'acqua è una strada e la bici il modo naturale di percorrerla.",
      "I canali che al tramonto si accendono e riflettono le facciate strette delle case galleggianti.",
    ],
  },
  italia: {
    kind: "sea",
    tips: [
      "Il mare del Sud si divide in quattro mondi: Calabria (Costa degli Dei), Sicilia, Puglia (Salento) e Sardegna. Scegliete in base al lato che preferite di mare.",
      "Le spiagge più belle e meno affollate sono fuori dai borghi serviti: in Calabria e Salento l'auto serve per arrivare alle cale vere.",
      "Sardegna e Sicilia hanno l'acqua più trasparente; Puglia e Calabria le spiagge di sabbia più lunghe e accessibili.",
    ],
    stops: [
      "Calabria e la Costa degli Dei",
      "Sicilia e San Vito lo Capo",
      "Puglia e il Salento",
      "Sardegna e la Costa Smeralda",
    ],
    faqs: [
      {
        question: "Qual è il mare più bello del Sud Italia?",
        answer:
          "Dipende dai gusti: la Sardegna (Costa Smeralda, Chia) ha l'acqua più trasparente, la Sicilia le spiagge più scenografiche, la Puglia la sabbia più chiara e la Calabria le calette meno battute.",
      },
      {
        question: "Quando andare nel Sud Italia?",
        answer:
          "Da fine maggio a settembre; giugno e settembre sono l'ideale per evitare la folla e il caldo. Luglio e agosto restano belli ma pieni.",
      },
      {
        question: "Serve l'auto?",
        answer:
          "Per Calabria, Salento e Sardegna sì, per raggiungere le cale. In Sicilia e Puglia i treni coprono le città principali ma non le spiagge migliori.",
      },
    ],
    hooks: [
      "Quattro mari in uno: il Sud Italia cambia colore tra Tirreno, Ionio e Adriatico.",
      "Sabbia chiara, acqua scura e borghi sul mare: il profilo inconfondibile del Sud.",
    ],
  },

  barcellona: {
    kind: "city",
    tips: [
      "La Sagrada Familia si visita solo con biglietto prenotato online: senza si entra a orari impossibili o non si entra affatto.",
      "Park Güell va visto all'ora di apertura: dopo diventa una coda unica che sale con il sole.",
      "Le Ramblas e il Barrio Gótico sono turistici ma bellissimi: meglio al mattino presto, prima dei gruppi.",
    ],
    stops: [
      "Sagrada Familia",
      "Park Güell e i suoi mosaici",
      "Las Ramblas e il Barrio Gótico",
      "La spiaggia della Barceloneta",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Barcellona?",
        answer:
          "Tre giorni sono l'ideale: due per Gaudí e il centro, uno per le spiagge e i quartieri (Gràcia, El Born).",
      },
      {
        question: "Barcellona si gira a piedi?",
        answer:
          "In buona parte sì, ma la metro è comoda e veloce: le distanze tra Gaudí, il mare e Montjuïc sono più lunghe di quanto sembri.",
      },
      {
        question: "Ci sono belle spiagge in città?",
        answer:
          "La Barceloneta è comoda ma affollata; per sabbia migliore conviene Bogatell o una giornata fuori città (Sitges o Costa Brava).",
      },
    ],
    hooks: [
      "La città delle forme impossibili di Gaudí, dove il modernismo è ovunque guardi.",
      "Mediterraneo e viali alberati: Barcellona vive tra arte e mare.",
    ],
  },

  madrid: {
    kind: "city",
    tips: [
      "Il Museo del Prado va prenotato: le code sono sempre lunghe e il museo ha più sale di quante se ne vedano in un giorno.",
      "Il Parco del Retiro vale la mattina o il tramonto, quando i madrileni ci vanno davvero.",
      "La vita notturna e il cibo (tapas, churros) sono il cuore di Madrid: cenare tardi è la regola.",
    ],
    stops: [
      "Il Museo del Prado",
      "Il Palazzo Reale",
      "Plaza Mayor e la Puerta del Sol",
      "Il Parco del Retiro",
    ],
    faqs: [
      {
        question: "Madrid o Barcellona?",
        answer:
          "Madrid è arte, musei e vita di piazza; Barcellona è mare e architettura. Per un viaggio culturale Madrid, per il mare Barcellona.",
      },
      {
        question: "Quando andare a Madrid?",
        answer:
          "Primavera e autunno: l'estate è molto calda e ad agosto molti locali chiudono. L'inverno è mite ma secco.",
      },
      {
        question: "Quanto tempo serve?",
        answer:
          "Tre giorni bastano per i musei principali e il centro; un quarto se vuoi una gita a Toledo.",
      },
    ],
    hooks: [
      "La capitale che non dorme: musei enormi e piazze vive fino a tardi.",
      "Madrid è la Spagna che accoglie tutti, tra il Prado e le tapas.",
    ],
  },

  lisbona: {
    kind: "city",
    tips: [
      "Il tram 28 è iconico ma sempre pieno: meglio all'alba o in alternativa a piedi per i quartieri alti.",
      "Belém si raggiunge col tram 15: Torre di Belém e pastéis de nata vanno visti insieme.",
      "Lisbona è fatta di salite: scarpe comode e preparatevi a viste mozzafiato dai miradouros.",
    ],
    stops: [
      "Belém e la Torre",
      "L'Alfama e i suoi vicoli",
      "L'Elevador de Santa Justa",
      "Sintra e i suoi palazzi",
    ],
    faqs: [
      {
        question: "Lisbona è cara?",
        answer:
          "È una delle capitali europee più economiche: trasporti, cibo e vino costano meno che in gran parte d'Europa.",
      },
      {
        question: "Vale la pena Sintra?",
        answer:
          "Sì, è una gita da fare: palazzi colorati e Pena Palace meritano una giornata intera. Si arriva in treno in meno di un'ora.",
      },
      {
        question: "Come ci si sposta a Lisbona?",
        answer:
          "Tram, funicolari e metro funzionano bene; le colline rendono faticoso ma affascinante muoversi a piedi.",
      },
    ],
    hooks: [
      "La città dai sette colli e le piastrelle azzurre, tra tram gialli e fado.",
      "Lisbona guarda l'Atlantico da un'altura, e il fiume Tago la abbraccia.",
    ],
  },

  atene: {
    kind: "city",
    tips: [
      "L'Acropoli si visita all'apertura: a mezzogiorno il sole e le code sono insostenibili.",
      "Plaka e Anafiotika sono belle al mattino e alla sera, quando le stradine si svuotano.",
      "Il Museo dell'Acropoli chiude alcune sale per restauri: controllare gli orari prima.",
    ],
    stops: [
      "L'Acropoli e il Partenone",
      "Plaka e l'Anafiotika",
      "Il Museo dell'Acropoli",
      "Capo Sounion",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Atene?",
        answer:
          "Due giorni pieni per l'acropoli, i musei e Plaka; un terzo per Capo Sounion o una gita alle isole vicine.",
      },
      {
        question: "Atene è sicura?",
        answer:
          "Le zone turistiche sono sicure; come ovunque, attenzione a borseggiatori nei mezzi affollati e nelle zone più animate.",
      },
      {
        question: "Quando andare ad Atene?",
        answer:
          "Primavera e autunno: l'estate è caldissima e molto affollata. L'inverno è mite ma con più pioggia.",
      },
    ],
    hooks: [
      "La culla della civiltà occidentale, dove ogni pietra ha tremila anni.",
      "Il Partenone che domina la città, illuminato la sera come un faro.",
    ],
  },

  berlino: {
    kind: "city",
    tips: [
      "La Porta di Brandeburgo e l'Isola dei Musei si visitano a piedi, ma Berlino è grande: la metro serve.",
      "La East Side Gallery è il tratto di muro più noto; il Memoriale dell'Olocausto va visto con rispetto.",
      "Berlino è nota per la vita notturna e i mercati: il Mauerpark la domenica è imperdibile.",
    ],
    stops: [
      "La Porta di Brandeburgo",
      "L'Isola dei Musei",
      "Il Reichstag e la sua cupola",
      "La East Side Gallery",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Berlino?",
        answer:
          "Quattro giorni sono l'ideale: musei, muro, quartieri e un po' di vita notturna. Tre sono un minimo.",
      },
      {
        question: "Berlino è cara?",
        answer:
          "Meno di altre capitali europee: cibo, trasporti e ingresso ai musei sono abbordabili. Gli hotel in centro salgono.",
      },
      {
        question: "Quando andare a Berlino?",
        answer:
          "Da maggio a settembre il clima è piacevole; l'inverno è freddo ma i mercatini di Natale ripagano.",
      },
    ],
    hooks: [
      "La città della memoria e della rinascita, dove il muro è diventato arte.",
      "Berlino vive di contrasti: storia profonda e creatività fresca.",
    ],
  },

  praga: {
    kind: "city",
    tips: [
      "Il Ponte Carlo è bellissimo all'alba, quando è quasi vuoto; a mezzogiorno è una folla.",
      "Il Castello e la Cattedrale di San Vito richiedono tempo: prenotate e arrivate presto.",
      "Malá Strana e Staré Město si girano a piedi, ma attenzione ai sassi: scarpe comode.",
    ],
    stops: [
      "Il Ponte Carlo",
      "Il Castello e la Cattedrale di San Vito",
      "Piazza della Città Vecchia",
      "Il quartiere di Malá Strana",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Praga?",
        answer:
          "Tre giorni per il centro storico e il castello; un quarto per esplorare i quartieri fuori rotta.",
      },
      {
        question: "Praga è cara?",
        answer:
          "Cibo e birra sono economici; i prezzi salgono nelle zone più turistiche. Nel complesso è conveniente.",
      },
      {
        question: "Quando andare a Praga?",
        answer:
          "Primavera e autunno per il clima e meno folla; l'inverno è magico con i mercatini ma freddo.",
      },
    ],
    hooks: [
      "La città delle cento torri, dove il gotico si specchia nella Vltava.",
      "Praga è una fiaba in pietra, con l'orologio astronomico al centro.",
    ],
  },

  vienna: {
    kind: "city",
    tips: [
      "Il Palazzo Schönbrunn richiede mezza giornata: prenotate l'orario per le stanze imperiali.",
      "Il Duomo di Santo Stefano segna il centro: da lì i vicoli portano a caffè storici.",
      "Il Belvedere ospita Klimt: il bacio è il quadro più cercato, andate presto.",
    ],
    stops: [
      "Il Palazzo Schönbrunn",
      "Il Duomo di Santo Stefano",
      "Il Belvedere",
      "La Ringstrasse e l'Opera",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Vienna?",
        answer:
          "Tre giorni per palazzi, musei e caffè storici; un quarto se vuoi aggiungere un concerto o una gita sul Danubio.",
      },
      {
        question: "Vienna è cara?",
        answer:
          "Più di altre capitali dell'est ma meno di Parigi o Londra. I musei e l'opera valgono il prezzo.",
      },
      {
        question: "Quando andare a Vienna?",
        answer:
          "Maggio-giugno e settembre per il clima; dicembre per i mercatini di Natale, tra i più belli d'Europa.",
      },
    ],
    hooks: [
      "La capitale della musica e del caffè, elegante su ogni viale.",
      "Vienna vive tra palazzi imperiali e sale da concerto senza tempo.",
    ],
  },

  budapest: {
    kind: "city",
    tips: [
      "Il Parlamento sul Danubio si fotografa al meglio dall'altra sponda, di sera quando è illuminato.",
      "Le terme Széchenyi sono un rito: andate la mattina presto o fate il bagno serale.",
      "Il Bastione dei Pescatori regala la vista migliore su Pest: salite al tramonto.",
    ],
    stops: [
      "Il Parlamento sul Danubio",
      "Il Bastione dei Pescatori",
      "Le terme Széchenyi",
      "Il Ponte delle Catene",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Budapest?",
        answer:
          "Tre giorni: uno per Buda, uno per Pest e uno per le terme e i mercati.",
      },
      {
        question: "Budapest è economica?",
        answer:
          "Sì, è tra le capitali europee più convenienti: cibo, terme e trasporti costano poco.",
      },
      {
        question: "Quando andare a Budapest?",
        answer:
          "Primavera e autunno; l'inverno è freddo ma le terme al caldo sono il momento migliore per provarle.",
      },
    ],
    hooks: [
      "Due città in una, unite dal Danubio e dai ponti illuminati.",
      "Budapest è terme, architettura e tram gialli sul fiume.",
    ],
  },

  copenaghen: {
    kind: "city",
    tips: [
      "I Giardini di Tivoli sono belli anche solo passeggiando; la sera si accendono.",
      "Nyhavn è il porto colorato più fotografato: andate al mattino per le foto col canale calmo.",
      "La Sirenetta è piccola e piena di turisti: non aspettatevi molto, ma il lungomare vale.",
    ],
    stops: [
      "I Giardini di Tivoli",
      "Nyhavn e il porto colorato",
      "La Sirenetta",
      "Christiania",
    ],
    faqs: [
      {
        question: "Copenaghen è cara?",
        answer:
          "Sì, è una delle capitali più care d'Europa: alloggio e cibo pesano. Le bici e i musei aiutano a risparmiare.",
      },
      {
        question: "Quanto tempo serve?",
        answer:
          "Due-tre giorni per il centro, i canali e un giorno fuori porta (musei o parchi).",
      },
      {
        question: "Come ci si muove a Copenaghen?",
        answer:
          "In bici: è la città più bike-friendly del mondo, piatta e con piste ovunque.",
      },
    ],
    hooks: [
      "La capitale delle bici e del design, dove il colore è arredamento urbano.",
      "Copenaghen vive sull'acqua, tra canali e case colorate di Nyhavn.",
    ],
  },

  dublino: {
    kind: "city",
    tips: [
      "Il Trinity College e il Book of Kells vanno prenotati: è l'attrazione più richiesta.",
      "Il Temple Bar è caro e turistico: i pub veri sono fuori da quella zona.",
      "La Guinness Storehouse finisce con un panorama sulla città dal Gravity Bar.",
    ],
    stops: [
      "Il Trinity College e il Book of Kells",
      "Il Temple Bar",
      "La Guinness Storehouse",
      "Il Castello di Dublino",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Dublino?",
        answer:
          "Due-tre giorni per la città; un giorno in più se vuoi le scogliere di Moher o una gita fuori porta.",
      },
      {
        question: "Dublino piove sempre?",
        answer:
          "Il clima è mite e può piovere in ogni stagione: un ombrello pieghevole risolve tutto l'anno.",
      },
      {
        question: "Dublino è cara?",
        answer:
          "Gli alberghi salgono; cibo e pub sono nella media. I musei pubblici sono molti e gratuiti.",
      },
    ],
    hooks: [
      "La città della birra nera e della musica dal vivo in ogni pub.",
      "Dublino è accogliente, verdissima e piena di storie da ascoltare.",
    ],
  },

  tokyo: {
    kind: "city",
    tips: [
      "Shibuya e il suo incrocio sono l'immagine di Tokyo: il punto migliore per guardarlo è dall'alto.",
      "Asakusa e il Senso-ji si visitano al mattino presto, prima dei gruppi.",
      "La metro è perfetta ma complessa: la Suica/Pasmo semplifica ogni corsa.",
    ],
    stops: [
      "Shibuya e il suo incrocio",
      "Il Tempio di Senso-ji ad Asakusa",
      "Il Santuario Meiji",
      "Shinjuku e la Tokyo Tower",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Tokyo?",
        answer:
          "Quattro-cinque giorni per i quartieri principali; una settimana se vuoi aggiungere Kyoto o Osaka.",
      },
      {
        question: "Tokyo è cara?",
        answer:
          "Può esserlo negli hotel, ma cibo, trasporti e attrazioni sono alla portata. I convenience store e i ristoranti locali aiutano.",
      },
      {
        question: "Quando andare a Tokyo?",
        answer:
          "Marzo-aprile (ciliegi) e ottobre-novembre per il clima. L'estate è calda e umida.",
      },
    ],
    hooks: [
      "La metropoli dove il futuro convive con templi secolari.",
      "Tokyo è ordine perfetto e caos colorato, tra insegne e ciliegi.",
    ],
  },

  kyoto: {
    kind: "city",
    tips: [
      "Il Fushimi Inari è un tunnel infinito di torii rossi: andate all'alba per averlo quasi vuoto.",
      "Il Padiglione d'Oro Kinkaku-ji si riflette nell'acqua: la foto è da cartolina.",
      "Il bosco di bambù di Arashiyama è magico al mattino presto, prima della folla.",
    ],
    stops: [
      "Il Santuario Fushimi Inari",
      "Il Padiglione d'Oro Kinkaku-ji",
      "Il Bosco di Bambù di Arashiyama",
      "Il quartiere di Gion",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Kyoto?",
        answer:
          "Due-tre giorni per i templi principali e Gion; un giorno in più per Arashiyama con calma.",
      },
      {
        question: "Kyoto o Tokyo?",
        answer:
          "Kyoto è la città dei templi e delle geishe, Tokyo la metropoli. Per la cultura tradizionale Kyoto, per la modernità Tokyo.",
      },
      {
        question: "Quando andare a Kyoto?",
        answer:
          "In primavera per i ciliegi e in autunno per i colori; l'estate è umida e molto affollata.",
      },
    ],
    hooks: [
      "La città dei mille templi, dove il Giappone antico è ancora vivo.",
      "Kyoto è torii rossi, bambù e silenzio tra i giardini.",
    ],
  },

  bangkok: {
    kind: "city",
    tips: [
      "Il Palazzo Reale e il Wat Phra Kaew hanno un dress code rigoroso: coprite spalle e ginocchia.",
      "Il Wat Arun è splendido al tramonto, quando la porcellana brilla sulla riva del fiume.",
      "I mercati galleggianti sono fuori città: organizzate la gita con un tour la mattina presto.",
    ],
    stops: [
      "Il Palazzo Reale e il Wat Phra Kaew",
      "Il Wat Arun",
      "Il mercato galleggiante",
      "Il Wat Pho e il Buddha sdraiato",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Bangkok?",
        answer:
          "Tre-quattro giorni per i templi e i mercati; è spesso la porta d'ingresso per le spiagge thailandesi.",
      },
      {
        question: "Bangkok è sicura?",
        answer:
          "Sì per i turisti, con le normali attenzioni: taxi ufficiali, acqua in bottiglia e prudenza la sera tardi.",
      },
      {
        question: "Quando andare a Bangkok?",
        answer:
          "Da novembre a febbraio è il periodo migliore (più fresco e asciutto); da marzo fa molto caldo.",
      },
    ],
    hooks: [
      "La capitale dei templi dorati e del traffico infinito sul Chao Phraya.",
      "Bangkok è caos profumato di street food e luci dei mercati.",
    ],
  },

  singapore: {
    kind: "city",
    tips: [
      "Marina Bay Sands e i Gardens by the Bay sono il simbolo: lo spettacolo luminoso serale è gratuito.",
      "Il Merlion è una tappa breve: fotografatelo e proseguite verso Marina Bay.",
      "Singapore è pulitissima e molto ordinata: rispettate le regole, sono rigide.",
    ],
    stops: [
      "Marina Bay Sands",
      "I Gardens by the Bay",
      "Il Merlion sul lungomare",
      "Chinatown e Little India",
    ],
    faqs: [
      {
        question: "Singapore è cara?",
        answer:
          "Gli hotel sì; il cibo nei centri hawker è economico e ottimo. Il trasporto pubblico costa poco.",
      },
      {
        question: "Quanto tempo serve per Singapore?",
        answer:
          "Tre giorni bastano per la città; è una tappa perfetta prima o dopo il Sud-est asiatico.",
      },
      {
        question: "Quando andare a Singapore?",
        answer:
          "Tutto l'anno, è equatoriale: caldo e umido con piogge brevi. Febbraio-aprile è un po' più asciutto.",
      },
    ],
    hooks: [
      "La città-giardino del futuro, ordinata e spettacolare.",
      "Singapore è grattacieli che sfidano la giungla, tra superalberi luminosi.",
    ],
  },

  dubai: {
    kind: "city",
    tips: [
      "Il Burj Khalifa si prenota online: il tramonto dall'osservatorio è l'orario più richiesto.",
      "La Dubai Marina e i suoi canali sono belli di sera; il Burj Al Arab si guarda dalla spiaggia o da un punto panoramico.",
      "Il deserto è l'altra faccia: un safari tra le dune al tramonto è un'escursione da fare.",
    ],
    stops: [
      "Il Burj Khalifa",
      "La Dubai Marina",
      "Il Burj Al Arab",
      "Il deserto e le dune",
    ],
    faqs: [
      {
        question: "Dubai è cara?",
        answer:
          "Può esserlo per hotel e ristoranti di lusso, ma ci sono opzioni per tutte le tasche e molto è duty-free.",
      },
      {
        question: "Quando andare a Dubai?",
        answer:
          "Da novembre a marzo: temperature gradevoli. L'estate è torrida (oltre 40°C), si vive al chiuso.",
      },
      {
        question: "Serve il visto?",
        answer:
          "Per molti Paesi il visto all'arrivo è semplice; verificate le regole in base alla cittadinanza prima di partire.",
      },
    ],
    hooks: [
      "La città dei record, dove il deserto incontra i grattacieli.",
      "Dubai è lusso e futuro nel cuore delle dune.",
    ],
  },

  "hong kong": {
    kind: "city",
    tips: [
      "Victoria Peak si raggiunge col tram storico: la vista sul Victoria Harbour è la migliore della città.",
      "Il Victoria Harbour di sera ha lo spettacolo di luci Symphony of Lights.",
      "I mercati notturni (Temple Street) sono un altro mondo: contrattate con il sorriso.",
    ],
    stops: [
      "Victoria Peak e il tram",
      "Il Victoria Harbour",
      "Il Tempio di Man Mo",
      "Il mercato di Temple Street",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Hong Kong?",
        answer:
          "Tre-quattro giorni per l'isola e i mercati; è perfetta come tappa di un viaggio in Asia.",
      },
      {
        question: "Hong Kong è cara?",
        answer:
          "Gli hotel in centro sì; cibo di strada e dim sum sono economici. Il trasporto pubblico è ottimo e a buon prezzo.",
      },
      {
        question: "Quando andare a Hong Kong?",
        answer:
          "Da ottobre a dicembre è il periodo migliore; l'estate è calda e piovosa per il monsone.",
      },
    ],
    hooks: [
      "La città dove Oriente e Occidente si stringono sul porto più bello del mondo.",
      "Hong Kong è grattacieli, giunche e mercati che non dormono.",
    ],
  },

  seoul: {
    kind: "city",
    tips: [
      "Il Palazzo Gyeongbokgung è la visita classica; il cambio della guardia è uno spettacolo gratuito.",
      "La N Seoul Tower domina la città: salite al tramonto per la vista migliore.",
      "Bukchon Hanok è un villaggio di case tradizionali: rispettate chi ci vive.",
    ],
    stops: [
      "Il Palazzo Gyeongbokgung",
      "La N Seoul Tower",
      "Il quartiere di Bukchon Hanok",
      "Myeongdong e lo street food",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Seoul?",
        answer:
          "Tre-quattro giorni per palazzi, quartieri e street food; un giorno in più se vuoi una gita fuori porta.",
      },
      {
        question: "Seoul è cara?",
        answer:
          "Il cibo è economico e gli ingressi ai palazzi costano poco; gli hotel in centro sono nella media.",
      },
      {
        question: "Quando andare a Seoul?",
        answer:
          "Primavera (ciliegi) e autunno per il clima; l'inverno è freddo ma secco e limpido.",
      },
    ],
    hooks: [
      "La metropoli delle mille luci, tra palazzi imperiali e tecnologia.",
      "Seoul è K-cultura, street food e skyline che brilla di neon.",
    ],
  },

  sydney: {
    kind: "city",
    tips: [
      "L'Opera House e l'Harbour Bridge si attraversano insieme: il traghetto per Manly dà la vista migliore dal porto.",
      "Bondi Beach è la spiaggia simbolo: il percorso costiero fino a Coogee è una camminata imperdibile.",
      "Il Royal Botanic Garden è l'oasi verde col panorama sull'Opera.",
    ],
    stops: [
      "L'Opera House",
      "L'Harbour Bridge",
      "Bondi Beach",
      "Il Royal Botanic Garden",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Sydney?",
        answer:
          "Quattro giorni per il porto, le spiagge e i quartieri; una settimana se aggiungi le Blue Mountains.",
      },
      {
        question: "Sydney è cara?",
        answer:
          "Sì, è tra le città più care dell'emisfero sud: alloggio e cibo pesano, ma molte attrazioni sono gratuite.",
      },
      {
        question: "Quando andare a Sydney?",
        answer:
          "Il clima è buono tutto l'anno; la primavera e l'autunno (da noi invertiti) sono l'ideale.",
      },
    ],
    hooks: [
      "La città del porto perfetto, tra vela bianca e surf.",
      "Sydney è luce, oceano e una baia che abbraccia tutto.",
    ],
  },

  "los angeles": {
    kind: "city",
    tips: [
      "Hollywood e la Walk of Fame sono turistici ma da vedere una volta; il cartello si fotografa da lontano.",
      "Santa Monica Pier e Venice Beach sono il mare di LA: andate per il tramonto.",
      "L'auto è quasi obbligatoria: le distanze sono enormi e il traffico leggendario.",
    ],
    stops: [
      "Hollywood e la Walk of Fame",
      "Santa Monica Pier",
      "Le colline di Griffith e l'Osservatorio",
      "Venice Beach",
    ],
    faqs: [
      {
        question: "Quanto tempo serve per Los Angeles?",
        answer:
          "Quattro-cinque giorni per spiagge, Hollywood e un parco; l'auto è necessaria.",
      },
      {
        question: "LA è cara?",
        answer:
          "Gli hotel e il noleggio auto pesano; mangiare fuori ha opzioni per tutte le tasche.",
      },
      {
        question: "Quando andare a Los Angeles?",
        answer:
          "Quasi tutto l'anno: clima mite. L'estate è asciutta e piacevole, con il famoso 'June gloom' al mattino.",
      },
    ],
    hooks: [
      "La città del cinema e delle palme, stesa tra oceano e colline.",
      "Los Angeles è luci, autostrade e tramonti sul Pacifico.",
    ],
  },

  miami: {
    kind: "sea",
    tips: [
      "South Beach e Ocean Drive sono il cuore: l'art déco colorato va visto anche di sera.",
      "Wynwood Walls è il quartiere degli street art: murales giganti a ogni angolo.",
      "Little Havana profuma di caffè e sigari: la Calle Ocho è viva dal pomeriggio.",
    ],
    stops: [
      "South Beach e Ocean Drive",
      "Wynwood Walls",
      "Little Havana",
      "Key Biscayne",
    ],
    faqs: [
      {
        question: "Miami è solo spiagge?",
        answer:
          "No: arte (Wynwood), cultura latina (Little Havana) e design (art déco) fanno di Miami molto più che una meta balneare.",
      },
      {
        question: "Quando andare a Miami?",
        answer:
          "Da novembre ad aprile è il periodo migliore (asciutto e meno umido); l'estate è calda e piovosa.",
      },
      {
        question: "Serve l'auto a Miami?",
        answer:
          "Per South Beach no, ma per Wynwood, Key Biscayne e i dintorni è utile o si usa il ridesharing.",
      },
    ],
    hooks: [
      "La città del neon e delle palme, tra art déco e oceano turchese.",
      "Miami è il punto dove i Caraibi incontrano l'America.",
    ],
  },

  mykonos: {
    kind: "sea",
    tips: [
      "Mykonos Town e i mulini a vento sono il simbolo: Little Venice al tramonto è il momento migliore.",
      "Le spiagge variano: Paradise e Super Paradise per la vita, Elia e Agios Sostis per il relax.",
      "I vicoli bianchi del paese sono un labirinto: perdersi è parte del fascino.",
    ],
    stops: [
      "Mykonos Town e i mulini a vento",
      "Little Venice",
      "La spiaggia di Paradise",
      "La spiaggia di Elia",
    ],
    faqs: [
      {
        question: "Mykonos è cara?",
        answer:
          "Sì, è tra le isole greche più care: hotel e locali in alta stagione costano parecchio.",
      },
      {
        question: "Quando andare a Mykonos?",
        answer:
          "Da giugno a settembre; luglio-agosto è il pieno (e il più caro), settembre è perfetto con meno folla.",
      },
      {
        question: "Mykonos è solo festa?",
        answer:
          "No: il paese, i tramonti e le spiagge del nord sono tranquilli; la vita notturna è concentrata nelle zone note.",
      },
    ],
    hooks: [
      "L'isola bianca e blu, tra mulini a vento e vicoli da cartolina.",
      "Mykonos è il cuore glamour delle Cicladi, col vento sempre presente.",
    ],
  },

  seychelles: {
    kind: "sea",
    tips: [
      "Le spiagge di granito (Anse Source d'Argent, Anse Lazio) sono uniche al mondo: acqua bassa e rocce scolpite.",
      "La Vallée de Mai a Praslin ospita il coco de mer, la palma più famosa del pianeta.",
      "Ogni isola è un atollo raggiungibile in barca o volo interno: organizzate i trasferimenti con anticipo.",
    ],
    stops: [
      "La spiaggia di Anse Source d'Argent",
      "L'isola di Praslin",
      "La Vallée de Mai",
      "Le spiagge di Mahé",
    ],
    faqs: [
      {
        question: "Le Seychelles sono care?",
        answer:
          "Sì, è una meta di fascia alta: resort e trasferimenti pesano. Le guesthouse aiutano a contenere il budget.",
      },
      {
        question: "Quando andare alle Seychelles?",
        answer:
          "Tutto l'anno; aprile-maggio e ottobre-novembre sono i mesi con mare più calmo e meno vento.",
      },
      {
        question: "Ci vuole il visto?",
        answer:
          "Per molti Paesi no, l'ingresso turistico è agevolato. Verificate i requisiti per la vostra cittadinanza.",
      },
    ],
    hooks: [
      "Granito, palme e acqua così trasparente da sembrare irreale.",
      "Le Seychelles sono il paradiso di rocce scolpite dall'oceano.",
    ],
  },

  mauritius: {
    kind: "sea",
    tips: [
      "Le Morne Brabant è la montagna simbolo: la laguna sottostante è un colore da cartolina.",
      "Belle Mare e la costa est hanno sabbia fine e acque calme quasi tutto l'anno.",
      "Le cascate di Chamarel e le Terre dei Sette Colori sono una tappa interna sorprendente.",
    ],
    stops: [
      "Le Morne Brabant",
      "La spiaggia di Belle Mare",
      "Le cascate di Chamarel",
      "L'isola dei Cervi",
    ],
    faqs: [
      {
        question: "Mauritius è solo mare?",
        answer:
          "No: l'interno è verde con cascate e parchi; il mare è la star ma l'isola ha anche montagne e natura.",
      },
      {
        question: "Quando andare a Mauritius?",
        answer:
          "Da maggio a dicembre il clima è più gradevole; gennaio-aprile è più caldo e umido (stagione dei cicloni).",
      },
      {
        question: "Mauritius è cara?",
        answer:
          "Dipende dagli hotel: i resort sono cari, le guesthouse e i villaggi rendono il soggiorno accessibile.",
      },
    ],
    hooks: [
      "Sabbia bianca, laguna turchese e una montagna che domina l'orizzonte.",
      "Mauritius è l'isola dove ogni spiaggia è una cartolina diversa.",
    ],
  },

  cancun: {
    kind: "sea",
    tips: [
      "La Zona Hotelera è la striscia di resort e mare turchese: per spiagge più calme puntate su Isla Mujeres.",
      "Le rovine maya di Tulum sul mare sono una tappa culturale da non perdere.",
      "I cenotes (Dos Ojos, Gran Cenote) sono pozzi d'acqua dolce unici: nuotare in uno è un'esperienza.",
    ],
    stops: [
      "La Zona Hotelera",
      "Isla Mujeres",
      "Le rovine di Tulum",
      "Il Cenote Dos Ojos",
    ],
    faqs: [
      {
        question: "Cancún è solo resort?",
        answer:
          "No: cultura maya (Tulum, Chichén Itzá), cenotes e isole (Isla Mujeres, Cozumel) rendono la zona ricca.",
      },
      {
        question: "Quando andare a Cancún?",
        answer:
          "Da dicembre ad aprile è asciutto e ideale; l'estate è calda e può piovere (stagione degli uragani giu-nov).",
      },
      {
        question: "Serve il visto per il Messico?",
        answer:
          "Per molti Paesi niente visto turistico; verificate i requisiti attuali prima di partire.",
      },
    ],
    hooks: [
      "Acqua turchese, rovine maya e cenotes da sogno.",
      "Cancún è il Caribe messicano, tra mare e storia millenaria.",
    ],
  },

  cuba: {
    kind: "sea",
    tips: [
      "L'Avana Vecchia è un museo a cielo aperto: le auto d'epoca e i colori sono l'immagine di Cuba.",
      "Varadero è la spiaggia più famosa, lunga e di sabbia chiara; Trinidad e la sua architettura coloniale sono imperdibili.",
      "Viñales è la valle del tabacco: verdi mogotes e aria di altri tempi.",
    ],
    stops: [
      "L'Avana Vecchia",
      "Varadero e le sue spiagge",
      "Trinidad e le case coloniali",
      "Le valli di Viñales",
    ],
    faqs: [
      {
        question: "Cuba è sicura?",
        answer:
          "Sì per i turisti, è tra i Paesi più sicuri dei Caraibi. Attenzione alle norme locali e alla valuta.",
      },
      {
        question: "Quando andare a Cuba?",
        answer:
          "Da novembre ad aprile è la stagione asciutta e migliore; l'estate è calda e umida (uragani giu-nov).",
      },
      {
        question: "Cuba si visita senza tour?",
        answer:
          "Sì, con i casas particulares e i trasporti locali, ma la pianificazione è più complessa che altrove.",
      },
    ],
    hooks: [
      "Auto d'epoca, musica e colori: Cuba non assomiglia a nessun altro posto.",
      "L'isola dove il tempo sembra essersi fermato agli anni Cinquanta.",
    ],
  },

  "repubblica dominicana": {
    kind: "sea",
    tips: [
      "Punta Cana è il litorale di resort sulla sabbia bianca; la penisola di Samaná ha paesaggi più selvaggi.",
      "Santo Domingo e la Zona Colonial sono il cuore storico, patrimonio UNESCO.",
      "L'isola di Saona è la gita classica: spiagge da cartolina e palme sul mare.",
    ],
    stops: [
      "Punta Cana e le spiagge",
      "La penisola di Samaná",
      "Santo Domingo e la Zona Colonial",
      "L'isola di Saona",
    ],
    faqs: [
      {
        question: "Repubblica Dominicana o Messico?",
        answer:
          "La Repubblica Dominicana è più concentrata su spiagge e resort; il Messico offre anche cultura maya. Dipende dal tipo di vacanza.",
      },
      {
        question: "Quando andare?",
        answer:
          "Da dicembre ad aprile è asciutto; l'estate è più umida (stagione degli uragani).",
      },
      {
        question: "Serve il visto?",
        answer:
          "Per molti Paesi niente visto turistico; verificate prima di partire.",
      },
    ],
    hooks: [
      "Sabbia bianca e palme all'infinito: il classico paradiso caraibico.",
      "La Repubblica Dominicana è mare cristallino e storia coloniale.",
    ],
  },

  canarie: {
    kind: "sea",
    tips: [
      "Il Teide a Tenerife è la vetta più alta di Spagna: il paesaggio lunare è un'escursione imperdibile.",
      "Le dune di Maspalomas a Gran Canaria sembrano un deserto accanto all'oceano.",
      "Fuerteventura e Lanzarote hanno le spiagge più lunghe e l'acqua più calma dell'arcipelago.",
    ],
    stops: [
      "Il Teide a Tenerife",
      "Le dune di Maspalomas",
      "Le spiagge di Fuerteventura",
      "L'isola di Lanzarote",
    ],
    faqs: [
      {
        question: "Le Canarie in estate sono troppo calde?",
        answer:
          "Il clima è mite tutto l'anno: l'estate è piacevole grazie ai venti alisei, mai afosa come il continente.",
      },
      {
        question: "Quando andare alle Canarie?",
        answer:
          "Tutto l'anno è buono; l'inverno europeo è il periodo più gettonato per sfuggire al freddo.",
      },
      {
        question: "Quale isola scegliere?",
        answer:
          "Tenerife per natura e Teide, Gran Canaria per le dune, Fuerteventura e Lanzarote per le spiagge e il surf.",
      },
    ],
    hooks: [
      "Vulcani, dune e oceano: le Canarie sono l'Africa che incontra l'Europa.",
      "Primavera eterna e spiagge lunghe: l'arcipelago del buon clima.",
    ],
  },

  "sharm el sheikh": {
    kind: "sea",
    tips: [
      "Ras Mohammed e la barriera corallina sono tra i migliori fondali del mondo per lo snorkeling.",
      "Naama Bay è il cuore turistico; per spiagge più quiete cercate le baie fuori dal centro.",
      "Il deserto del Sinai offre gite in quad, cammello e la salita al monte Mosè all'alba.",
    ],
    stops: [
      "La barriera corallina e Ras Mohammed",
      "Naama Bay e il lungomare",
      "Le spiagge del Mar Rosso",
      "Il deserto del Sinai",
    ],
    faqs: [
      {
        question: "Sharm è adatta anche a chi non si immerge?",
        answer:
          "Sì: lo snorkeling dalla riva è spettacolare anche per principianti, e le spiagge sono attrezzate.",
      },
      {
        question: "Quando andare a Sharm?",
        answer:
          "Da ottobre a maggio è il periodo migliore; l'estate è torrida ma l'acqua resta fresca.",
      },
      {
        question: "Serve il visto per l'Egitto?",
        answer:
          "Sì, per molti Paesi il visto si ottiene all'arrivo; verificate i requisiti aggiornati prima di partire.",
      },
    ],
    hooks: [
      "Coralli a portata di maschera e un mare che sfuma in ogni blu.",
      "Sharm è il Mar Rosso nella sua forma più spettacolare.",
    ],
  },

  cipro: {
    kind: "sea",
    tips: [
      "Ayia Napa ha le spiagge più note e l'acqua più limpida; Protaras è l'alternativa più tranquilla.",
      "Paphos mescola mare e storia: i mosaici romani sono patrimonio UNESCO.",
      "L'isola è divisa: la parte sud è quella turistica, con Nicosia come confine suggestivo.",
    ],
    stops: [
      "Ayia Napa e le sue spiagge",
      "Paphos e i mosaici",
      "Le spiagge di Protaras",
      "Il sito di Kourion",
    ],
    faqs: [
      {
        question: "Cipro è cara?",
        answer:
          "Nella media mediterranea: mangiare e spostarsi costano meno che in gran parte d'Europa occidentale.",
      },
      {
        question: "Quando andare a Cipro?",
        answer:
          "Da maggio a ottobre per il mare; l'inverno è mite ma con più pioggia.",
      },
      {
        question: "Si guida a sinistra?",
        answer:
          "Sì, a Cipro si guida a sinistra, retaggio inglese: attenzione soprattutto nei primi giorni.",
      },
    ],
    hooks: [
      "L'isola di Afrodite, tra spiagge dorate e rovine romane.",
      "Cipro è il Mediterraneo in una versione soleggiata e ricca di storia.",
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
  maiorca: "mallorca",
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
  "valle d'itria": "puglia",
  trulli: "puglia",
  egadi: "sicilia",
  eolie: "sicilia",
  "isole eolie": "sicilia",
  palermo: "sicilia",
  catania: "sicilia",
  marrakech: "marocco",
  marrakesh: "marocco",
  nyc: "new york",
  "nuova york": "new york",
  newyork: "new york",
  paris: "parigi",
  london: "londra",
  italy: "italia",
  barcelona: "barcellona",
  lisbon: "lisbona",
  lisboa: "lisbona",
  athens: "atene",
  berlin: "berlino",
  prague: "praga",
  copenhagen: "copenaghen",
  dublin: "dublino",
  hongkong: "hong kong",
  "cancún": "cancun",
  varadero: "cuba",
  "punta cana": "repubblica dominicana",
  "dominican republic": "repubblica dominicana",
  tenerife: "canarie",
  "canary islands": "canarie",
  sharm: "sharm el sheikh",
  "sharm el-sheikh": "sharm el sheikh",
  cyprus: "cipro",
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
 * Nomi dei luoghi più riconoscibili di una destinazione, estratti dalle tappe
 * curate. Servono alla ricerca di clip video stock: cercare solo il nome della
 * destinazione restituisce anche riprese anonime (strade qualsiasi), mentre i
 * luoghi iconici ("Central Park", "Times Square") restituiscono riprese
 * identificabili. Ogni tappa nomina il luogo principale prima della
 * congiunzione o della virgola.
 *
 * Una destinazione SENZA conoscenza curata restituisce `[]`: il chiamante usa
 * il solo nome della destinazione, comportamento precedente immutato.
 */
export function landmarkQueries(place: string, max = 4): string[] {
  const knowledge = knowledgeFor(place);
  if (!knowledge) return [];
  const out: string[] = [];
  for (const stop of knowledge.stops) {
    // Il luogo principale è la parte prima della prima congiunzione/virgola.
    const lead = (stop.split(/,\s*|\s+e\s+|\s*:\s*/i)[0] ?? "").trim();
    const cleaned = lead
      .replace(/^(il|la|lo|l'|le|i|gli|un|una)\s+/i, "")
      .trim();
    if (cleaned.length >= 3 && !/^\d+$/.test(cleaned)) {
      const lower = cleaned.toLowerCase();
      if (!out.some((q) => q.toLowerCase() === lower)) out.push(cleaned);
    }
    if (out.length >= max) break;
  }
  return out;
}

function tokensOf(text: string, minLen = 3): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= minLen);
}

/**
 * Token "attesi" di una destinazione: il nome (anche nelle forme alias, es.
 * "barcelona" oltre a "barcellona", perché i titoli stock sono spesso in
 * inglese) e i luoghi delle tappe. Servono al filtro di pertinenza delle clip:
 * un titolo che non contiene NESSUNO di questi token è quasi certamente rumore
 * (strade, scarpe, case generiche) e va scartato.
 */
export function relevantPlaceTokens(place: string): string[] {
  const key = normalizeForMatch(place ?? "");
  const out = new Set<string>();
  for (const t of tokensOf(key)) out.add(t);
  const resolved = ALIASES[key] ?? key;
  for (const t of tokensOf(resolved)) out.add(t);
  // Tutte le forme alias che puntano alla stessa voce ("barcelona" → "barcellona").
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (target === resolved) for (const t of tokensOf(alias)) out.add(t);
  }
  const knowledge = KNOWLEDGE[resolved];
  if (knowledge) {
    for (const stop of knowledge.stops) for (const t of tokensOf(stop)) out.add(t);
  }
  return [...out];
}

/**
 * Le destinazioni con una conoscenza curata.
 *
 * Serve ai test e al debug: permette di verificare la tabella intera senza
 * dover elencare a mano i posti su cui si vuole contare. Non è un elenco per
 * l'utente: la conoscenza si sceglie per nome, e un elenco a schermo
 * suggerirebbe che gli altri posti non si possono scrivere.
 */
/**
 * Query di ricerca video stock IN INGLESE per ogni destinazione curata.
 *
 * I provider stock (Pexels, Pixabay, Magnific) indicizzano in inglese: la query
 * in italiano ("atene Acropoli", "amsterdam Canali") non trova quasi nulla,
 * mentre quella inglese ("athens acropolis", "amsterdam canals") restituisce
 * riprese vere e specifiche del luogo. `name` è il nome inglese per il filtro
 * di pertinenza + la query di riempimento col solo nome; `landmarks` sono le
 * tappe per la varietà del montaggio.
 */
export const VIDEO_SEARCH: Record<string, { name: string; landmarks: string[] }> = {
  // --- Città ---
  amsterdam: { name: "amsterdam", landmarks: ["amsterdam canals", "rijksmuseum amsterdam", "jordaan amsterdam", "zaanse schans windmills"] },
  atene: { name: "athens", landmarks: ["athens acropolis", "parthenon athens", "plaka athens", "temple of olympian zeus athens"] },
  barcellona: { name: "barcelona", landmarks: ["sagrada familia barcelona", "park guell barcelona", "las ramblas barcelona", "barceloneta beach barcelona"] },
  bangkok: { name: "bangkok", landmarks: ["grand palace bangkok", "wat arun bangkok", "bangkok floating market", "wat pho reclining buddha bangkok"] },
  berlino: { name: "berlin", landmarks: ["brandenburg gate berlin", "berlin museum island", "reichstag berlin", "east side gallery berlin"] },
  budapest: { name: "budapest", landmarks: ["budapest parliament danube", "fishermans bastion budapest", "szechenyi thermal bath", "chain bridge budapest"] },
  copenaghen: { name: "copenhagen", landmarks: ["copenhagen tivoli gardens", "nyhavn copenhagen", "little mermaid copenhagen", "christiania copenhagen"] },
  dubai: { name: "dubai", landmarks: ["burj khalifa dubai", "dubai marina", "burj al arab dubai", "dubai desert safari"] },
  dublino: { name: "dublin", landmarks: ["trinity college dublin", "temple bar dublin", "guinness storehouse dublin", "dublin castle"] },
  "hong kong": { name: "hong kong", landmarks: ["victoria peak hong kong", "victoria harbour hong kong", "hong kong street market", "hong kong skyline"] },
  istanbul: { name: "istanbul", landmarks: ["hagia sophia istanbul", "blue mosque istanbul", "bosphorus istanbul", "grand bazaar istanbul"] },
  kyoto: { name: "kyoto", landmarks: ["fushimi inari shrine kyoto", "kinkakuji golden pavilion kyoto", "arashiyama bamboo grove", "gion geisha district kyoto"] },
  lisbona: { name: "lisbon", landmarks: ["belem tower lisbon", "alfama lisbon", "santa justa lift lisbon", "sintra palacio da pena"] },
  londra: { name: "london", landmarks: ["big ben london", "tower bridge london", "london eye", "buckingham palace london"] },
  "los angeles": { name: "los angeles", landmarks: ["hollywood sign los angeles", "santa monica pier", "griffith observatory los angeles", "venice beach los angeles"] },
  madrid: { name: "madrid", landmarks: ["prado museum madrid", "royal palace madrid", "plaza mayor madrid", "retiro park madrid"] },
  "new york": { name: "new york", landmarks: ["times square new york", "central park new york", "statue of liberty new york", "brooklyn bridge new york"] },
  parigi: { name: "paris", landmarks: ["eiffel tower paris", "louvre museum paris", "notre dame paris", "arc de triomphe paris"] },
  praga: { name: "prague", landmarks: ["charles bridge prague", "prague castle", "old town square prague", "prague astronomical clock"] },
  seoul: { name: "seoul", landmarks: ["gyeongbokgung palace seoul", "n seoul tower", "bukchon hanok village seoul", "myeongdong seoul"] },
  singapore: { name: "singapore", landmarks: ["marina bay sands singapore", "gardens by the bay singapore", "merlion singapore", "chinatown singapore"] },
  sydney: { name: "sydney", landmarks: ["sydney opera house", "sydney harbour bridge", "bondi beach sydney", "royal botanic garden sydney"] },
  tokyo: { name: "tokyo", landmarks: ["shibuya crossing tokyo", "sensoji temple asakusa tokyo", "meiji shrine tokyo", "tokyo tower"] },
  vienna: { name: "vienna", landmarks: ["schonbrunn palace vienna", "st stephens cathedral vienna", "belvedere palace vienna", "vienna opera"] },

  // --- Mare e isole ---
  bali: { name: "bali", landmarks: ["bali rice terraces", "uluwatu temple bali", "bali beach", "bali waterfall"] },
  canarie: { name: "canary islands", landmarks: ["tenerife teide volcano", "maspalomas dunes gran canaria", "fuerteventura beach", "lanzarote volcanic landscape"] },
  cancun: { name: "cancun", landmarks: ["cancun beach", "isla mujeres cancun", "tulum mayan ruins", "cenote mexico"] },
  cipro: { name: "cyprus", landmarks: ["ayia napa beach cyprus", "paphos cyprus mosaics", "protaras beach cyprus", "cyprus mediterranean sea"] },
  corfù: { name: "corfu", landmarks: ["corfu old town", "corfu beach", "paleokastritsa corfu", "corfu canal damour"] },
  creta: { name: "crete", landmarks: ["elafonissi beach crete", "balos lagoon crete", "chania old town crete", "matala beach crete"] },
  cuba: { name: "cuba", landmarks: ["havana old town cuba", "varadero beach cuba", "trinidad cuba", "vinales valley cuba"] },
  formentera: { name: "formentera", landmarks: ["formentera beach", "ses salines formentera", "formentera cove", "formentera sunset"] },
  ibiza: { name: "ibiza", landmarks: ["ibiza beach turquoise water", "dalt vila ibiza", "ibiza cove", "ibiza sunset"] },
  kenya: { name: "kenya", landmarks: ["diani beach kenya", "watamu kenya beach", "mombasa kenya", "kenya coast"] },
  mallorca: { name: "mallorca", landmarks: ["palma cathedral mallorca", "soller mallorca", "cala mallorca beach", "serra de tramuntana mallorca"] },
  maldive: { name: "maldives", landmarks: ["maldives beach", "maldives overwater villa", "maldives atoll", "maldives snorkeling"] },
  mauritius: { name: "mauritius", landmarks: ["mauritius beach palm trees", "le morne brabant mauritius", "ile aux cerfs mauritius", "chamarel waterfall mauritius"] },
  miami: { name: "miami", landmarks: ["miami south beach", "ocean drive miami", "wynwood walls miami", "little havana miami"] },
  mykonos: { name: "mykonos", landmarks: ["mykonos windmills", "mykonos little venice", "mykonos beach", "mykonos town white houses"] },
  "repubblica dominicana": { name: "dominican republic", landmarks: ["punta cana beach", "samana peninsula dominican republic", "santo domingo colonial zone", "saona island dominican republic"] },
  rodi: { name: "rhodes", landmarks: ["rhodes old town", "rhodes beach", "lindos acropolis rhodes", "rhodes harbor"] },
  santorini: { name: "santorini", landmarks: ["santorini oia sunset", "santorini caldera", "santorini blue domes", "santorini black beach"] },
  seychelles: { name: "seychelles", landmarks: ["anse source dargent seychelles", "praslin island seychelles", "vallee de mai seychelles", "mahe beach seychelles"] },
  "sharm el sheikh": { name: "sharm el sheikh", landmarks: ["sharm el sheikh coral reef", "naama bay sharm el sheikh", "red sea snorkeling sharm", "sinai desert"] },
  thailandia: { name: "thailand", landmarks: ["phuket beach thailand", "krabi islands thailand", "phi phi islands thailand", "thailand longtail boat"] },
  zanzibar: { name: "zanzibar", landmarks: ["zanzibar beach white sand palm trees", "zanzibar stone town", "zanzibar kendwa beach", "zanzibar dhow sunset"] },

  // --- Italia (solo mare del Sud) ---
  calabria: { name: "calabria", landmarks: ["tropea beach calabria", "capo vaticano calabria", "costa degli dei italy", "calabria sea coast"] },
  puglia: { name: "puglia", landmarks: ["salento puglia beach", "alberobello trulli", "polignano a mare puglia", "otranto puglia sea"] },
  sardegna: { name: "sardinia", landmarks: ["costa smeralda sardinia", "sardinia beach", "golfo di orosei sardinia", "sardinia cala"] },
  sicilia: { name: "sicily", landmarks: ["taormina sicily", "san vito lo capo sicily", "ortigia syracuse sicily", "etna volcano sicily"] },
  italia: { name: "italy", landmarks: ["calabria sea italy", "sicily sea italy", "puglia sea italy", "sardinia sea italy"] },

  // --- Altre ---
  marocco: { name: "morocco", landmarks: ["marrakech morocco", "morocco sahara desert", "chefchaouen morocco", "essaouira morocco coast"] },
  malta: { name: "malta", landmarks: ["malta valletta", "mdina malta", "malta gozo", "malta blue lagoon"] },
};

/** Query video stock in inglese per una destinazione, o `null` se non mappata. */
export function videoSearch(place: string): { name: string; landmarks: string[] } | null {
  const key = normalizeForMatch(place ?? "");
  if (!key) return null;
  const resolved = ALIASES[key] ?? key;
  return VIDEO_SEARCH[resolved] ?? null;
}

const CURATED_SLUG_OVERRIDES: Record<string, string> = {
  italia: "mare_italia",
  calabria: "mare_italia",
  sicilia: "mare_italia",
  puglia: "mare_italia",
  sardegna: "mare_italia",
  // Il nome leggibile della cartella unica del Sud Italia risolve a sé stesso.
  "mare italia": "mare_italia",
};

/**
 * Slug della cartella `public/curated/<photos|videos>` per una destinazione.
 *
 * Le cartelle "curate" sono riempite a mano dall'utente (foto e clip video
 * selezionati per destinazione): il loro nome è il nome normalizzato del luogo
 * con gli spazi trasformati in underscore ("new_york", "sharm_el_sheikh").
 * L'Italia in tutte le sue forme (Italia, Calabria, Sicilia, Puglia, Sardegna)
 * vive in UN'UNICA cartella `mare_italia`, perché vendiamo solo il mare del Sud
 * come unico prodotto. Una destinazione NON curata restituisce `null`: il
 * chiamante ricade sulla ricerca stock del provider.
 */
export function curatedFolderSlug(place: string): string | null {
  const key = normalizeForMatch(place ?? "");
  if (!key) return null;
  const resolved = ALIASES[key] ?? key;
  const override = CURATED_SLUG_OVERRIDES[resolved];
  if (override) return override;
  if (!VIDEO_SEARCH[resolved]) return null;
  return normalizeForMatch(resolved).replace(/\s+/g, "_");
}

export function curatedDestinations(): string[] {
  return Object.keys(KNOWLEDGE).sort();
}