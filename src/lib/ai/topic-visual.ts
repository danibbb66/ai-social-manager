/**
 * Dagli argomenti astratti alle parole che un generatore capisce.
 *
 * Una libreria fotografica e un generatore di immagini rispondono a una scena,
 * non a un tema. "Post sulle capitali europee" è un'intenzione, non qualcosa che
 * si può fotografare: cercata così com'è non torna niente, e il primo tentativo
 * fallisce. Il rimedio non è ritentare, è tradurre: "capitali europee" diventa
 * una skyline di città europee, cioè un soggetto che esiste in fotografia.
 *
 * ## Perché qui e non nel prompt
 *
 * La traduzione serve a due chiamate diverse con lo stesso identico problema:
 * la ricerca nella libreria stock e il prompt del generatore. Se stesse in una
 * delle due, l'altra continuerebbe a mandare "capitali europee" e a fallire. Un
 * posto solo, e le due chiamate leggono la stessa risposta.
 *
 * ## Perché una mappa e non un modello
 *
 * La mappa è esplicita, ispezionabile e non costa niente. Un elenco di temi
 * non è esaustivo e non può esserlo, ma un tema non mappato non viene
 * manomesso: viene cercato come arriva. Il rischio di una traduzione sbagliata
 * (un posto tranquillo cercato come una metropoli) è peggio di una ricerca
 * imperfetta, quindi la mappa agisce solo su parole che non nominano un luogo.
 */

/** Una scena fotografabile, in inglese come il resto dei prompt. */
export interface VisualScene {
  /** Query per la libreria stock: nomi di soggetto, non temi. */
  stock: string;
  /** Frase di scena per il prompt del generatore. */
  scene: string;
}

/**
 * Temi astratti e il soggetto che li rende fotografabili.
 *
 * `when` guarda l'argomento dell'utente; `scene` dice cosa fotografare.
 *
 * I pattern nominano solo **temi**, mai luoghi. "Maldive" non è un tema: è il
 * nome di un posto, e il nome di un posto è già la parola migliore da cercare in
 * una libreria stock. Tradurlo in "isola tropicale" farebbe perdere la
 * precisione che il nome vero dà, quindi qui non compare e non deve comparare.
 *
 * Le query stock sono in inglese perché la libreria a valle lo è: cercare
 * "ancient greek temple" restituisce risultati, "templi greci antichi" quasi
 * nessuno. Le scene per il generatore restano in italiano, che è la lingua dei
 * prompt già in uso nel progetto.
 */
const THEMES: { when: RegExp; scene: VisualScene }[] = [
  {
    when: /\b(capital|capitali|citta capitali|metropoli)\b|\beuropee?\b.*\bcapitali?\b|\bcapitale\b/i,
    scene: {
      stock: "european capital city skyline historic architecture",
      scene: "skyline di una città europea, tetti storici e campanili in controluce",
    },
  },
  {
    when: /\b(isole|islands?|tropical\w*|atolls?|arcipelag[oi]|seicell[ae]|laguna|barriera corallina|reef)\b/i,
    scene: {
      stock: "tropical island turquoise sea white sand beach palm trees",
      scene: "isola tropicale, acqua turchese, spiaggia bianca e palme",
    },
  },
  {
    when: /\b(citta d.arte|borghi|paesi|centri storici|medievali|gettoni)\b/i,
    scene: {
      stock: "italian hilltop village stone houses narrow street",
      scene: "borgo storico su collina, pietra e tetti in cotto",
    },
  },
  {
    when: /\b(spiagg[ei]|litorale|marittim[oa]|mare)\b/i,
    scene: {
      stock: "mediterranean beach coastline turquoise water cliffs",
      scene: "costa mediterranea, acqua turchese e scogli",
    },
  },
  {
    when: /\b(montagna|montagne|alpi|dolomit|pirenei|trekking|escursionismo|sentieri)\b/i,
    scene: {
      stock: "alpine mountain peaks snow landscape hiking trail",
      scene: "creste alpine innevate, cielo aperto e sentiero",
    },
  },
  {
    when: /\b(musei|museo|gallerie|arte|pittur[ae]|sculture|architettura roman[ao])\b/i,
    scene: {
      stock: "art museum interior paintings gallery sculptures",
      scene: "galleria d'arte, tele e sculture in luce radente",
    },
  },
  {
    when: /\b(enogastronom|wine|vini|culinari|gastronom|food)\b/i,
    scene: {
      stock: "italian vineyard wine cellar tuscan landscape",
      scene: "vigneto e cantina, botti e paesaggio collinare",
    },
  },
  {
    when: /\b(safari|masai|savana|animali della savana|wildlife)\b/i,
    scene: {
      stock: "african savanna safari elephants acacia sunset",
      scene: "savana africana, acacie e animali al tramonto",
    },
  },
  {
    when: /\b(nordic[hi]|aurora|notte polare|glaciar[io]|luce del nord|inverno artico)\b/i,
    scene: {
      stock: "northern lights aurora borealis snow mountains winter",
      scene: "aurora boreale sopra un paesaggio ghiacciato",
    },
  },
  {
    when: /\b(terme|spa|benessere|wellness|idroterapi)\b/i,
    scene: {
      stock: "thermal spa pool stone architecture relaxing",
      scene: "terme naturali in pietra, vapore e acqua ferma",
    },
  },
  {
    when: /\b(centri urbani|citta grandi|grandi citta|metropoli|vivere in citta)\b/i,
    scene: {
      stock: "city street view architecture people walking",
      scene: "strada di una città, facciate prospettiche e gente",
    },
  },
];

/**
 * Il tema di un argomento, o `null` se non è un tema noto.
 *
 * L'ordine conta: le voci più specifiche stanno prima delle generali, perché
 * "capitali europee" deve prendere la skyline e non la strada urbana. Senza
 * questo, "città" vincerebbe su tutto e ogni tema diventerebbe una via urbana.
 */
export function sceneForTopic(topic: string | null | undefined): VisualScene | null {
  const text = (topic ?? "").trim();
  if (!text) return null;
  for (const theme of THEMES) {
    if (theme.when.test(text)) return theme.scene;
  }
  return null;
}

/**
 * La scena da mettere nel prompt, per un argomento che potrebbe essere astratto.
 *
 * Stessa regola della query stock: la traduzione vale solo per i temi noti, e il
 * fallback è il testo di partenza, a cui il chiamante aggiunge la descrizione
 * fotografica standard.
 */
export function scenePromptFor(topic: string | null | undefined, fallback: string): string {
  const text = (topic ?? "").trim() || fallback;
  const scene = sceneForTopic(text);
  return scene ? scene.scene : text;
}
