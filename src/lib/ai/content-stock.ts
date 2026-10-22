import path from "node:path";
import { getImageProvider, getStockProvider } from "@/lib/images/factory";
import { readFileBuffer } from "@/lib/storage";
import { renderSocialCreative } from "@/lib/images/social-creative";
import {
  COMMERCIAL_EXTRACTION_METHOD,
  type CommercialExtraction,
} from "@/lib/catalog/commercial-extraction";
import { getBrandMark } from "@/lib/services/brand";
import { placeNameFrom } from "@/lib/ai/place-name";
import { isSupplierOriginal } from "@/lib/services/offer-creative";
import { sceneForTopic, scenePromptFor } from "@/lib/ai/topic-visual";
import { kickerForFormat } from "@/lib/ai/format-kicker";
import { editorialPoints } from "@/lib/ai/editorial-matrix";
import { curatedFolderSlug, videoSearch } from "@/lib/ai/travel-knowledge";
import { listCuratedPhotos } from "@/lib/curated/media";
import { createAsset, linkAsset, listAssets } from "@/lib/services/media";
import { saveUploadedFile, sniffMediaMime, uploadedFileExists, deleteUploadedFile } from "@/lib/uploads";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { config } from "@/lib/env";

/**
 * Visual di un contenuto: ricerca nella libreria stock, applicazione del
 * layout/template, salvataggio in Media Library e associazione al Content.
 *
 * Regola che governa il file: la GENERAZIONE è l'ultimo gradino, non il primo.
 * Il visual viene cercato per destinazione nella libreria stock (Magnific) e, in
 * subordine, nella Media Library, poi il file reale passa dal template social
 * dell'app. Solo se la libreria non ha nulla per quella destinazione si chiede
 * una fotografia al provider immagini: un post generico non viene bloccato
 * perché il catalogo fotografico è vuoto, e il fatto che il visual sia generato
 * resta dichiarato sull'asset e nel messaggio al modello. Se nemmeno la
 * generazione riesce il chiamante deve abortire la creazione, non lasciare un
 * DRAFT a metà.
 */

/** Identificativo del layout applicato al foto stock, tracciato sull'asset. */
export const STOCK_VISUAL_TEMPLATE = "social-creative-v1";

/**
 * Formato e risoluzione chiesti al generatore: quadrato, come il template, e
 * alta risoluzione.
 *
 * "2k" e non "1k" per la stessa ragione che vale sui post nati da un'offerta:
 * il template compone su 1080 px e non ingrandisce mai, quindi una foto da
 * 1024 verrebbe ridimensionata a 1080 solo al costo di sfocarla. Su un
 * fotogramma quadrato il risultato sarebbe una striscia di foto più piccola
 * del fotogramma, cioè cornici nere. L'alta risoluzione è ciò che rende la
 * foto l'unica base reale del post.
 */
const FALLBACK_ASPECT_RATIO = "square_1_1";
const FALLBACK_RESOLUTION = "2k" as const;

/**
 * Prompt fotografico per il fallback alla generazione.
 *
 * La query arriva già ripulita da `stockQueryFrom` ("Maldive", "Isola d'Elba"):
 * qui diventa la scena, con le istruzioni che tengono la foto utilizzabile come
 * visual di un post. "no text, no logos" non è un vezzo stilistico: il template
 * sociale ci mette sopra il titolo, e un testo già stampato nell'immagine
 * produrrebbe due titoli sovrapposti illeggibili.
 *
 * `topic` serve solo quando è un tema astratto: "capitali europee" non è una
 * scena, e il generatore che lo riceve com'è produce una foto senza soggetto o
 * rifiuta la richiesta. In quel caso la scena arriva tradotta da
 * `scenePromptFor`, e il primo tentativo ha già una buona possibilità di
 * riuscire invece di fallire e costare un secondo giro.
 */
export function buildFallbackPhotoPrompt(query: string, topic?: string | null): string {
  const subject = scenePromptFor(topic, query).slice(0, 200);
  return (
    `${subject}, realistic photo, high resolution, natural light, ` +
    "professional travel photography, no text, no logos, no watermark"
  );
}


/** Parole che non portano informazione sulla destinazione da cercare. */
const QUERY_STOP_WORDS = new Set([
  "proposta",
  "post",
  "posts",
  "reel",
  "storia",
  "storie",
  "story",
  "stories",
  "carosello",
  "contenuto",
  "contenuti",
  "bozza",
  "bozze",
  "immagine",
  "immagini",
  "visual",
  "foto",
  "instagram",
  "facebook",
  "social",
  "crea",
  "creami",
  "scrivi",
  "scrivimi",
  "prepara",
  "vorrei",
  "vorremmo",
  "per",
  "su",
  "sulla",
  "sul",
  "sullo",
  "sulle",
  "nei",
  "nelle",
  "della",
  "del",
  "dei",
  "delle",
  "di",
  "il",
  "lo",
  "la",
  "i",
  "gli",
  "le",
  "un",
  "uno",
  "una",
  "e",
  "a",
  "da",
  "con",
  "che",
  "piu",
]);

/**
 * Parola chiave di ricerca stock, derivata da destinazione/topic/titolo.
 *
 * Toglie quantificatori, articoli e parole generiche: da "3 post sulla Grecia"
 * resta "Grecia", che è ciò che ha senso cercare in un catalogo fotografico.
 * Se non resta nulla si usa il testo originale: una ricerca imperfecta vale
 * meglio di nessuna ricerca.
 *
 * Se il topic è un tema astratto noto ("capitali europee"), la query è la scena
 * fotografabile che gli corrisponde: cercare il tema com'è non torna niente, e
 * il post si fermerebbe al primo tentativo. La traduzione vale solo per i
 * temi in mappa, quindi una destinazione reale non viene mai rimpiazzata.
 */
export function stockQueryFrom(
  destination?: string | null,
  topic?: string | null,
  title?: string | null
): string {
  // La destinazione resta la fonte prioritaria e non viene tradotta: è già un
  // luogo, e il nome del luogo è la parola migliore da cercare.
  const realPlace = (destination ?? "").trim();
  if (realPlace) return cleanQuery(realPlace, topic);

  const source = [topic, title]
    .map((value) => (value ?? "").trim())
    .find((value) => value.length > 0);
  if (!source) return "";

  // Un luogo passato come topic (non come destinazione esplicita) va cercato
  // comunque col landmark inglese: "zanzibar" da solo su un provider indicizzato
  // in inglese trova barche, non la spiaggia. Stesso criterio del ramo
  // destinazione, così "crea un post per zanzibar" e "destinazione Zanzibar"
  // cercano la stessa scena pertinente.
  const topicCurated = videoSearch(source);
  if (topicCurated) {
    return (topicCurated.landmarks[0] ?? topicCurated.name).trim().slice(0, 120);
  }

  const scene = sceneForTopic(source);
  if (scene) return scene.stock;

  const tokens = source
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !QUERY_STOP_WORDS.has(token.toLowerCase()));

  if (tokens.length === 0) return source.slice(0, 120);
  return tokens.join(" ").slice(0, 120);
}

/**
 * Ripulisce una destinazione già nota.
 *
 * La destinazione viene dal modello o dal catalogo e può avere le stesse
 * impurità del topic ("proposta Calabria"): le parole generiche si tolgono
 * anche qui, ma il risultato non viene mai sostituito da una scena.
 */
function cleanQuery(destination: string, topic?: string | null): string {
  // Destinazioni curate: la foto si cerca col LANDMARK iconico IN INGLESE
  // (es. "athens acropolis", "elafonissi beach crete", "maldives beach").
  // Pixabay indicizza in inglese e il nome italiano ("creta", "atene") trova
  // foto sbagliate (fiori, strade generiche, argilla). Il primo landmark è il
  // più rappresentativo della destinazione.
  const curated = videoSearch(destination);
  if (curated) {
    return (curated.landmarks[0] ?? curated.name).trim().slice(0, 120);
  }

  const tokens = destination
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !QUERY_STOP_WORDS.has(token.toLowerCase()));

  if (tokens.length === 0) return destination.slice(0, 120);
  // Il topic serve solo da confronto: se la destinazione è un tema astratto e
  // il topic lo ripete, la ricerca parte dalla scena e non dal tema.
  const scene = sceneForTopic(destination);
  if (scene && topic && sceneForTopic(topic)) return scene.stock;
  return tokens.join(" ").slice(0, 120);
}

// La regola del titolo stampato vive in `place-name` perché la condividono i
// post generici e quelli nati da un'offerta di catalogo. Qui viene riesportata
// perché è il posto in cui il post generico la usa.
export { placeNameFrom } from "@/lib/ai/place-name";

/**
 * Estrazione commerciale neutra per il template.
 *
 * Nessun dato commerciale entra nel visual di un post generico: tutti i campi
 * restano null, quindi `commercialLines` non stampa righe e il template
 * compone solo titolo e sottotitolo. È la stessa garanzia del verticale
 * catalogo, applicata a un contenuto che non ha una locandina da cui derivare.
 */
function neutralExtraction(contentId: string, destination: string | null): CommercialExtraction {
  return {
    proposalId: contentId,
    destination,
    title: destination ?? "",
    price: null,
    priceTo: null,
    currency: null,
    departureCity: null,
    departureDate: null,
    returnDate: null,
    duration: null,
    accommodation: null,
    board: null,
    transport: null,
    sourceImageUrl: "",
    sourceImageId: null,
    sourceImageFilename: null,
    extractionMethod: COMMERCIAL_EXTRACTION_METHOD,
    extractedFields: [],
    confidence: 0,
    warnings: [],
  };
}

interface TemplatedImage {
  buffer: Buffer;
  mimeType: string;
  filename: string | null;
  applied: boolean;
  /** `true` solo se il marchio configurato è stato realmente stampato. */
  hasBrandLogo?: boolean;
  /** Quale marchio è stato stampato: logo file o wordmark. */
  brandMark?: "logo" | "wordmark" | null;
  /** La rubrica stampata sopra il titolo, se il formato ne ha una. */
  kicker?: string | null;
}

/**
 * Applica il layout/template social alla fotografia stock.
 *
 * Il template è quello già usato dal resto dell'app (quadrato, titolo in
 * evidenza, velatura per la leggibilità): lo stock entra nel post come
 * qualsiasi altra fotografia. Se la composizione non riesce (file corrotto,
 * rasterizzatore indisponibile) la foto resta comunque utilizzabile senza
 * overlay: un visual non applicato batte un visual mancante, e il risultato
 * viene dichiarato.
 *
 * Sul fotogramma si stampa il nome del luogo e il marchio dell'agenzia,
 * nient'altro di generico: il titolo non è il titolo del DRAFT (che porta con
 * sé il suffisso editoriale) e il sottotitolo non è l'etichetta del formato,
 * perché sul post servono il dove e il marchio, non la descrizione di come è
 * stato prodotto.
 *
 * L'occhiello è l'unica eccezione, e la sua eccezione è dichiarata: è la
 * rubrica che dice a che cosa serve il post ("Consigli di viaggio"). Non è una
 * descrizione di come è stato prodotto, è ciò che il post promette al lettore, e
 * senza di esso un post TRAVEL_TIPS sarebbe visivamente identico a un hero.
 */
async function applySocialTemplate(
  buffer: Buffer,
  input: {
    contentId: string;
    destination: string | null;
    topic: string | null;
    title: string | null;
    format?: string | null;
    callout?: string | null;
  }
): Promise<TemplatedImage> {
  // La destinazione vera e il topic restano distinti: il topic è la richiesta
  // ("proposta Maldive"), e trattarlo come nome del luogo stamperebbe sul post
  // la formula dell'utente invece di "Maldive".
  const title = placeNameFrom(input.destination, input.topic, input.title);
  if (!title || buffer.length === 0) {
    return {
      buffer,
      mimeType: sniffMediaMime(buffer) ?? "image/jpeg",
      filename: null,
      applied: false,
      hasBrandLogo: false,
      brandMark: null,
    };
  }

  const mark = await getBrandMark();
  const kicker = kickerForFormat(input.format);
  try {
    const rendered = await renderSocialCreative({
      photo: buffer,
      title,
      subtitle: null,
      kicker,
      callout: input.callout ?? null,
      orientation: "portrait",
      // I consigli e le tappe entrano dentro la card. In questo flusso non c'è
      // un catalogo da cui prendere i dati, quindi i punti vengono dalla
      // conoscenza della destinazione: è l'unica fonte che esiste qui, ed è
      // anche l'unica che ha qualcosa da dire del posto.
      points: editorialPoints(input.format ?? "", title),
      extraction: neutralExtraction(input.contentId, title),
      brandLogo: mark?.kind === "logo" ? mark : null,
      brandName: mark?.kind === "wordmark" ? mark.name : null,
    });
    return {
      buffer: rendered.buffer,
      mimeType: rendered.mimeType,
      filename: rendered.filename,
      applied: true,
      hasBrandLogo: rendered.hasBrandLogo,
      brandMark: rendered.brandMark,
      kicker,
    };
  } catch {
    return {
      buffer,
      mimeType: sniffMediaMime(buffer) ?? "image/jpeg",
      filename: null,
      applied: false,
      hasBrandLogo: false,
      brandMark: null,
    };
  }
}

export type StockVisualOutcome =
  | {
      status: "attached";
      assetId: string;
      url: string;
      /**
       * Copia PULITA (senza titolo/logo) della stessa immagine, salvata in
       * Media Library come asset scollegato. Presente solo quando il chiamante
       * la chiede (`keepCleanScene`): è la scena da usare nelle clip successive
       * alla copertina, dove l'overlay non deve più comparire.
       */
      cleanSceneUrl?: string | null;
      /** Chi ha fornito il file: "magnific-stock", "media-library" o il generatore. */
      source: string;
      query: string;
      template: string;
      templateApplied: boolean;
      reused: boolean;
      /**
       * `true` solo se un marchio è stato realmente stampato sull'overlay. Il
       * marchio è quello configurato in `Brand.logoUrl` e, in sua assenza, il
       * wordmark con `Brand.name`: nessun segno viene inventato, e `brandMark`
       * dichiara quale dei due è finito sul fotogramma.
       */
      hasBrandLogo: boolean;
      /** Quale marchio è stato stampato: logo file, wordmark, o nessuno. */
      brandMark: "logo" | "wordmark" | null;
      /**
       * La rubrica stampata sopra il titolo, o `null` se il formato non ne ha
       * una. Vale "Consigli di viaggio" per TRAVEL_TIPS: è ciò che distingue il
       * fotogramma di un contenuto informativo da quello di un hero.
       */
      kicker: string | null;
      /**
       * true quando il file non era in libreria ed è stato generato. Vale come
       * avviso: un visual generato è una foto plausibile, non la foto reale del
       * posto, e il chiamante deve poterlo dichiarare.
       */
      generated: boolean;
    }
  | { status: "failed"; reason: string; query: string };

/** Legge un file già presente nello storage (uploads/…), o null se non esiste. */
async function readUploadedFile(url: string): Promise<Buffer | null> {
  try {
    return await readFileBuffer(url);
  } catch {
    return null;
  }
}

/**
 * Candidati della Media Library: immagini non assegnate a nessun contenuto il
 * cui nome o metadati contengono la destinazione.
 *
 * Due esclusioni, entrambe necessarie perché il file scelto qui può finire
 * allegato al post anche senza overlay:
 *
 *  - gli asset già legati a un contenuto: prenderne uno lascerebbe quel
 *    contenuto senza immagine, che è esattamente ciò che questa funzione deve
 *    impedire;
 *  - gli **originali del fornitore**: le locandine delle proposte di catalogo
 *    sono materiale promozionale di terzi, con il loro logo e la loro grafica,
 *    e sono libere per costruzione (vivono in Media Library con `contentId`
 *    nullo). Il loro nome contiene quasi sempre il nome della destinazione,
 *    quindi senza questo controllo un post "su Creta" avrebbe come visuale la
 *    locandina Creta di un fornitore. Non è una fotografia e non è nostra.
 */
async function findLocalStock(query: string) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return null;

  const assets = await listAssets({ kind: "IMAGE" });
  for (const asset of assets) {
    if (asset.contentId) continue;
    if (isSupplierOriginal(asset.metadata)) continue;
    if (!(await uploadedFileExists(asset.url))) continue;
    const haystack = `${asset.filename} ${JSON.stringify(asset.metadata ?? {})}`.toLowerCase();
    if (tokens.every((token) => haystack.includes(token))) return asset;
  }
  return null;
}

/**
 * Terzo gradino della catena: nessuna immagine in libreria, quindi il visual
 * viene generato. Restituisce il buffer e la provenienza, oppure `null` con il
 * motivo per cui la generazione non è avvenuta.
 *
 * Non genera nulla e non lascia file: se il provider non sa generare, se
 * dichiara un file che non è a terra o se la chiamata fallisce, il file
 * eventuale viene rimosso e si torna al chiamante. Un DRAFT senza visuale resta
 * uno stato non valido, quindi è preferibile dichiararlo che mostrarlo a metà.
 */
async function generateFallbackPhoto(
  query: string,
  contentId: string,
  topic?: string | null
): Promise<{
  buffer: Buffer;
  source: string;
  sourceUrl: string | null;
  originalFilename: string | null;
  prompt: string;
} | null> {
  const provider = getImageProvider();
  if (!provider.canGenerate) return null;

  const prompt = buildFallbackPhotoPrompt(query, topic);
  let generatedUrl: string | null = null;
  try {
    const image = await provider.generateImage(prompt, {
      contentId,
      aspectRatio: FALLBACK_ASPECT_RATIO,
      resolution: FALLBACK_RESOLUTION,
    });
    generatedUrl = image.url;

    // Un provider che dichiara un file e non scrive nulla produrrebbe un
    // DRAFT con un asset che punta al vuoto.
    if (!(await uploadedFileExists(image.url))) {
      await deleteUploadedFile(image.url).catch(() => {});
      return null;
    }
    const buffer = await readUploadedFile(image.url);
    if (!buffer || buffer.length === 0) {
      await deleteUploadedFile(image.url).catch(() => {});
      return null;
    }

    return {
      buffer,
      source: provider.name,
      sourceUrl: image.sourceUrl ?? null,
      originalFilename: image.url.split("/").pop() ?? null,
      prompt,
    };
  } catch {
    if (generatedUrl) await deleteUploadedFile(generatedUrl).catch(() => {});
    return null;
  }
}

/**
 * Cerca il visual del contenuto e lo collega: ricerca prima, generazione solo
 * come ultima risorsa.
 *
 * Ordine e garanzie:
 * 1. libreria stock Magnific per destinazione (foto reali, mai AI-generated);
 * 2. Media Library: un file già caricato che corrisponde alla destinazione;
 * 3. generazione con il provider immagini, su prompt fotografico ricavato dalla
 *    stessa query: un post generico non viene bloccato perché la libreria è
 *    vuota, e il fatto che il visual sia generato resta dichiarato;
 * 4. nessuno dei tre → `failed`, e il chiamante NON deve creare il post.
 *
 * Il file trovato o generato passa dal layout/template e solo poi diventa un
 * asset del contenuto. Se il salvataggio o la scrittura dell'asset falliscono il
 * file appena scritto viene rimosso: non restano mezzi asset né file orfani.
 */
export async function attachStockVisual(input: {
  contentId: string;
  destination?: string | null;
  topic?: string | null;
  title?: string | null;
  format?: string | null;
  /** Testo "gancio" centrato sul post, fornito dall'utente in chat. */
  callout?: string | null;
  /**
   * Salva anche la copia pulita (senza overlay) come asset scollegato: la usa
   * la pipeline video per le clip successive alla copertina.
   */
  keepCleanScene?: boolean;
}): Promise<StockVisualOutcome> {
  const query = stockQueryFrom(input.destination, input.topic, input.title);
  if (!query) {
    return {
      status: "failed",
      query,
      reason:
        "nessuna destinazione o argomento con cui cercare un'immagine nella libreria stock.",
    };
  }

  const destination = (input.destination ?? input.topic ?? "").trim() || null;
  const provider = getStockProvider();

  let buffer: Buffer | null = null;
  let source = provider.name;
  let sourceUrl: string | null = null;
  let pageUrl: string | null = null;
  let resourceId: number | null = null;
  let originalFilename: string | null = null;
  let reusedLocalAssetId: string | null = null;
  let generated = false;
  let generatedPrompt: string | null = null;

  // 0. Visual CURATO (foto selezionate a mano dall'utente): priorità assoluta
  //    sul provider stock. L'utente riempie public/curated/photos/<slug> con le
  //    foto approvate; se la cartella ha file, uno di questi è il visual, senza
  //    interrogare Pixabay/Pexels e senza il rischio di foto sbagliate.
  const curatedSlug = curatedFolderSlug(
    placeNameFrom(input.destination, input.topic, input.title) ||
      input.destination ||
      input.topic ||
      ""
  );
  if (!buffer && curatedSlug) {
    const curatedPhotos = await listCuratedPhotos(curatedSlug);
    if (curatedPhotos.length > 0) {
      const picked = curatedPhotos[Math.floor(Math.random() * curatedPhotos.length)];
      try {
        buffer = await readFileBuffer(picked);
        source = "curated";
        originalFilename = path.basename(picked);
      } catch (e) {
        logAIError("curated.photo.read", { slug: curatedSlug, path: picked }, e);
      }
    }
  }

  // 1-2. Ricerca stock (Pixabay/Magnific) e Media Library SOLO se il visual
  //    curato non ha già fornito una foto E se la modalità "solo curato" non è
  //    attiva. Con CURATED_MEDIA_ONLY=true ogni foto arriva esclusivamente
  //    dalle cartelle public/curated/photos/<slug>, mai dai provider esterni.
  if (!buffer && !config.curatedMediaOnly) {
    const stock = await provider.searchImage({ query, orientation: "portrait" });
    if (stock) {
      buffer = stock.buffer;
      source = stock.provider;
      sourceUrl = stock.sourceUrl;
      pageUrl = stock.pageUrl;
      resourceId = stock.resourceId;
      originalFilename = stock.filename;
    } else {
      const local = await findLocalStock(query);
      if (local) {
        const file = await readUploadedFile(local.url);
        if (file && file.length > 0) {
          buffer = file;
          source = "media-library";
          sourceUrl = local.url;
          originalFilename = local.filename;
          reusedLocalAssetId = local.id;
        }
      }
    }
  }

  // 3. La libreria non ha nulla per questa destinazione: invece di lasciare il
  //    post senza visuale, si genera una fotografia. È l'ultimo gradino, quindi
  //    vale solo quando stock e Media Library hanno già detto di no. In
  //    modalità "solo curato" non si genera nulla: una destinazione senza foto
  //    selezionate resta senza post.
  if (!buffer && !config.curatedMediaOnly) {
    const fallback = await generateFallbackPhoto(query, input.contentId, input.topic);
    if (fallback) {
      buffer = fallback.buffer;
      source = fallback.source;
      sourceUrl = fallback.sourceUrl;
      originalFilename = fallback.originalFilename;
      generated = true;
      generatedPrompt = fallback.prompt;
    }
  }

  if (!buffer) {
    return {
      status: "failed",
      query,
      reason: config.curatedMediaOnly
        ? `nessuna foto selezionata per "${query}": aggiungi le immagini in public/curated/photos/<destinazione> oppure disattiva CURATED_MEDIA_ONLY.`
        : `nessuna immagine trovata nella libreria stock per "${query}" ` +
          "(né in Magnific né nella Media Library) e il provider immagini non ha " +
          "potuto generarla.",
    };
  }

  const templated = await applySocialTemplate(buffer, {
    contentId: input.contentId,
    // Qui la destinazione vera, non quella composta sopra per la ricerca: il
    // topic ("proposta Maldive") è la richiesta, e `placeNameFrom` dà la
    // precedenza alla destinazione perché non ha mai ricevuto un suffisso.
    // Passargli il topic travestito da destinazione stamperebbe la formula
    // dell'utente al posto del nome del luogo.
    destination: (input.destination ?? "").trim() || null,
    topic: (input.topic ?? "").trim() || null,
    title: input.title ?? null,
    format: input.format,
    callout: input.callout ?? null,
  });

  // Un asset già presente in Media Library, senza template applicabile, viene
  // solo collegato: duplicare il file non aggiunge nulla e perderebbe la
  // tracciabilità dell'originale. Il ramo generato non ci passa mai: quel file
  // è nuovo e va salvato con il layout.
  if (reusedLocalAssetId && !templated.applied) {
    try {
      const linked = await linkAsset(reusedLocalAssetId, input.contentId);
      await logAudit("STOCK_VISUAL_ATTACHED", "ContentAsset", linked.id, {
        contentId: input.contentId,
        source,
        query,
        template: STOCK_VISUAL_TEMPLATE,
        templateApplied: false,
        reused: true,
        hasBrandLogo: false,
        brandMark: null,
        kicker: null,
        generated,
      });
      return {
        status: "attached",
        assetId: linked.id,
        url: linked.url,
        // Senza template applicato il visual È pulito: la stessa immagine fa
        // da copertina e da scena, se il chiamante la chiede per il video.
        cleanSceneUrl: input.keepCleanScene ? linked.url : null,
        source,
        query,
        template: STOCK_VISUAL_TEMPLATE,
        templateApplied: false,
        reused: true,
        hasBrandLogo: false,
        brandMark: null,
        kicker: null,
        generated,
      };
    } catch (e) {
      return {
        status: "failed",
        query,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const originalName =
    templated.filename ??
    originalFilename ??
    `stock-${query.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 40)}.jpg`;

  let saved: { url: string; mimeType: string; size: number } | null = null;
  try {
    saved = await saveUploadedFile({
      buffer: templated.buffer,
      originalName,
      mimeType: templated.mimeType,
    });
  } catch (e) {
    return {
      status: "failed",
      query,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  let asset;
  try {
    asset = await createAsset({
      url: saved.url,
      filename: saved.url.split("/").pop() ?? originalName,
      mimeType: saved.mimeType,
      size: saved.size,
      kind: "IMAGE",
      contentId: input.contentId,
      metadata: {
        origin: generated ? "generated-visual" : "stock-visual",
        provider: source,
        query,
        template: STOCK_VISUAL_TEMPLATE,
        templateApplied: templated.applied,
        destination,
        format: input.format ?? null,
        sourceUrl,
        pageUrl,
        resourceId,
        originalFilename,
        reusedLocalAssetId,
        // La generazione è dichiarata, non nascosta: sull'asset e nel messaggio
        // al modello si deve poter distinguere una foto reale da una generata.
        generated,
        generatedPrompt,
        // Il marchio è stampato su ogni post: `brandMark` dichiara quale dei
        // due è entrato nell'overlay, perché un post con il logo file e un
        // post con il wordmark non sono la stessa creatività.
        hasBrandLogo: templated.hasBrandLogo ?? false,
        brandMark: templated.brandMark ?? null,
        // La rubrica dichiarata con l'asset: un post di consigli e un hero sullo
        // stesso posto hanno lo stesso titolo e un fotogramma diverso.
        kicker: templated.kicker ?? null,
      },
    });
  } catch (e) {
    await deleteUploadedFile(saved.url).catch(() => {});
    return {
      status: "failed",
      query,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  await logAudit("STOCK_VISUAL_ATTACHED", "ContentAsset", asset.id, {
    contentId: input.contentId,
    source,
    query,
    template: STOCK_VISUAL_TEMPLATE,
    templateApplied: templated.applied,
    generated,
  });

  // Copia pulita per la pipeline video: le clip successive alla copertina
  // devono mostrare l'immagine in movimento SENZA titolo né logo. L'originale
  // (pre-template) è già in mano qui: si salva una volta, scollegato, con la
  // provenienza dichiarata. Best-effort: se fallisce, il video resta
  // renderizzabile e il chiamante vede cleanSceneUrl null.
  let cleanSceneUrl: string | null = null;
  if (input.keepCleanScene && buffer.length > 0) {
    try {
      const cleanSaved = await saveUploadedFile({
        buffer,
        originalName: `scene-${originalName ?? `stock-${query}`}`,
        mimeType: templated.mimeType,
      });
      const cleanAsset = await createAsset({
        url: cleanSaved.url,
        filename: cleanSaved.url.split("/").pop() ?? "scene.jpg",
        mimeType: cleanSaved.mimeType,
        size: cleanSaved.size,
        kind: "IMAGE",
        contentId: null,
        metadata: {
          origin: "video-scene",
          query,
          source,
          coverAssetId: asset.id,
        },
      });
      cleanSceneUrl = cleanAsset.url;
    } catch (e) {
      logAIError("content-stock.cleanScene", { contentId: input.contentId }, e);
    }
  }

  return {
    status: "attached",
    assetId: asset.id,
    url: asset.url,
    cleanSceneUrl,
    source,
    query,
    template: STOCK_VISUAL_TEMPLATE,
    templateApplied: templated.applied,
    reused: false,
    hasBrandLogo: templated.hasBrandLogo ?? false,
    brandMark: templated.brandMark ?? null,
    kicker: templated.kicker ?? null,
    generated,
  };
}
