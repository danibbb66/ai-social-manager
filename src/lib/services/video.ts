import fs from "node:fs/promises";
import path from "node:path";
import type { MontageClip, VideoProvider } from "@/lib/video/provider";
import { getVideoProvider } from "@/lib/video/factory";
import { probeVideoDurationSec } from "@/lib/video/ffmpeg";
import { getStockVideoProvider } from "@/lib/video/stock";
import type { StockVideoProvider } from "@/lib/video/stock";
import { getPexelsVideoProvider } from "@/lib/video/pexels";
import { getPixabayVideoProvider } from "@/lib/video/pixabay";
import { curatedFolderSlug, landmarkQueries, videoSearch } from "@/lib/ai/travel-knowledge";
import { listCuratedVideos } from "@/lib/curated/media";
import { getStockProvider } from "@/lib/images/factory";
import { downloadRemoteImage } from "@/lib/images/remote";
import { deleteUploadedFile, saveUploadedFile, uploadedFileExists } from "@/lib/uploads";
import { materialize, publicUrlFor, isCloudStorage } from "@/lib/storage";
import { logAIError } from "@/lib/logger";
import { config } from "@/lib/env";
import { createAsset, linkAsset } from "@/lib/services/media";
import { getContent, getContentOrThrow } from "@/lib/services/content";
import { getBrand } from "@/lib/services/brand";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { friendlyMessage } from "@/lib/errors/user-message";

/** Esegue `fn` su ogni elemento con un tetto di concorrenza, preservando l'ordine. */
async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Servizio video: generazione del reel e locandina di copertina.
 *
 * Qui sta tutta l'orchestrazione che prima era dispersa nel tool AI: scelta
 * dei fotogrammi, materializzazione dei file locali (le immagini del catalogo
 * sono URL remoti e ffmpeg non può leggerle), creazione dell'asset VIDEO e
 * locandina di copertina. I tool AI orchestrano e basta, come per il visual
 * del catalogo: ripetere la logica nei tool darebbe due versioni della stessa
 * pipeline da tenere allineate.
 */

/** Una fonte di fotogramma trovata sul contenuto, prima della materializzazione. */
interface VideoFrameSource {
  url: string;
  /** Da dove arriva: `slide`, `asset`, `library`, `stock` o `curated`. Solo per audit. */
  origin: "slide" | "asset" | "library" | "stock" | "curated";
  /** true se l'immagine porta già l'overlay (titolo/logo) composto dal visual. */
  hasOverlay: boolean;
  /** Per le clip STOCK: l'URL remoto originale, usato per non ripetere la clip. */
  sourceUrl?: string | null;
  /** Per le clip STOCK: l'id risorsa del provider, stabile anche quando l'URL cambia. */
  resourceId?: number | null;
}

export type GenerateVideoResult =
  | {
      ok: true;
      url: string;
      durationSec: number;
      assetId: string;
      provider: string;
      posterAssetId: string | null;
    }
  | {
      ok: false;
      /** Frase già pronta per l'utente: niente dettagli interni. */
      reason: string;
    };

export type VideoPosterResult =
  | { ok: true; assetId: string; created: boolean }
  | { ok: false; reason: string };

function filenameFromUrl(url: string): string {
  const clean = url.split("?")[0];
  return clean.split("/").pop() || "video.mp4";
}

/**
 * Imposta il tipo VIDEO (e disarma la programmazione) senza toccare le
 * piattaforme.
 *
 * `updateContent` cancella SEMPRE le piattaforme del contenuto e le ricrea
 * solo se riceve l'elenco: una chiamata senza `platforms` le azzererebbe, e
 * il reel perderebbe la distribuzione dichiarata dall'utente. Il tipo si
 * cambia quindi con un update mirato.
 */
export async function markContentAsVideo(contentId: string): Promise<void> {
  await prisma.content.update({
    where: { id: contentId },
    data: { type: "VIDEO", scheduledDate: null },
  });
}

/**
 * Fotogrammi extra dalla Media Library, quando il contenuto ne ha pochi.
 *
 * Un reel con un solo fotogramma è una foto immobile: se la ricerca (per
 * token, come `findLocalStock` nel flusso visual) trova altre immagini
 * pertinenti già presenti in libreria, diventano scene aggiuntive dello
 * slideshow. Gli asset già usati come fonti vengono saltati, così come quelli
 * il cui file non esiste più su disco.
 */
async function findLibraryFrames(
  query: string,
  excludeUrls: Set<string>,
  limit: number
): Promise<VideoFrameSource[]> {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return [];

  const assets = await prisma.contentAsset.findMany({
    where: { kind: "IMAGE" },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const out: VideoFrameSource[] = [];
  for (const asset of assets) {
    if (out.length >= limit) break;
    if (excludeUrls.has(asset.url)) continue;
    if (!(await uploadedFileExists(asset.url))) continue;
    const haystack = `${asset.filename} ${JSON.stringify(asset.metadata ?? {})}`.toLowerCase();
    if (tokens.every((t) => haystack.includes(t))) {
      out.push({ url: asset.url, origin: "library", hasOverlay: false });
    }
  }
  return out;
}

/**
 * Fotogrammi candidati, nell'ordine in cui li useremo:
 * prima le slide con immagine (sono la struttura pensata per il video),
 * poi gli asset IMAGE del contenuto (per esempio le immagini collegate da una
 * proposta del catalogo). Un URL ripetuto entra una volta sola.
 */
export async function collectVideoFrameSources(
  contentId: string
): Promise<VideoFrameSource[]> {
  const content = await getContent(contentId);
  if (!content) return [];

  const sources: VideoFrameSource[] = [];
  const seen = new Set<string>();
  for (const slide of content.slides) {
    if (slide.imageUrl && !seen.has(slide.imageUrl)) {
      seen.add(slide.imageUrl);
      sources.push({ url: slide.imageUrl, origin: "slide", hasOverlay: false });
    }
  }
  for (const asset of content.assets) {
    if (asset.kind === "IMAGE" && !seen.has(asset.url)) {
      seen.add(asset.url);
      const metadata = (asset.metadata ?? {}) as { templateApplied?: boolean };
      sources.push({
        url: asset.url,
        origin: "asset",
        hasOverlay: metadata.templateApplied === true,
      });
    }
  }
  return sources;
}

/**
 * Clip video REALI dalla RICERCA STOCK del provider (Magnific / stock video).
 *
 * È la PRIMA fonte interpellata per le clip: il provider viene interrogato
 * con la query esatta (es. "Bali"), i video restituiti vengono scaricati e
 * messi a terra in /uploads/videos così ffmpeg può tagliarli. La Media
 * Library locale non è un requisito: è solo il ripiego successivo.
 */
/** Identità delle clip stock già scaricate nei video precedenti (dai metadati
 *  degli asset VIDEO): URL remoto, id risorsa E percorso locale su disco.
 *  L'URL può cambiare (CDN firmati), l'id risorsa è stabile: con entrambi
 *  riusiamo i file già a terra invece di riscaricarli, risparmiando crediti
 *  (Magnific ~10 download/giorno) e non ingrossando /uploads/videos. */
async function usedStockIdentity(): Promise<{ urls: Set<string>; ids: Set<number>; localById: Map<number, string> }> {
  const urls = new Set<string>();
  const ids = new Set<number>();
  const localById = new Map<number, string>();
  try {
    const assets = await prisma.contentAsset.findMany({
      where: { kind: "VIDEO" },
      select: { metadata: true },
      take: 200,
    });
    for (const a of assets) {
      const meta = (a.metadata ?? {}) as {
        stockSourceUrls?: unknown;
        stockSourceIds?: unknown;
        stockLocalPaths?: unknown;
      };
      if (Array.isArray(meta.stockSourceUrls)) {
        for (const u of meta.stockSourceUrls) {
          if (typeof u === "string" && u) urls.add(u);
        }
      }
      if (Array.isArray(meta.stockSourceIds)) {
        for (const id of meta.stockSourceIds) {
          if (typeof id === "number") ids.add(id);
        }
      }
      // Mappa id risorsa -> percorso locale già scaricato, per il riuso.
      if (meta.stockLocalPaths && typeof meta.stockLocalPaths === "object") {
        for (const [id, url] of Object.entries(meta.stockLocalPaths as Record<string, unknown>)) {
          const num = Number(id);
          if (Number.isFinite(num) && typeof url === "string" && url) localById.set(num, url);
        }
      }
    }
  } catch {
    // errore di lettura: nessun filtro/riuso, il video si genera comunque
  }
  return { urls, ids, localById };
}

/**
 * Descrittori generici che compaiono in quasi OGNI titolo di clip stock e non
 * distinguono una ripresa dall'altra ("beach", "ocean", "aerial", "sunset"...).
 * Vengono scartati quando si estraggono i "soggetti" di un titolo, così due
 * spiagge diverse non vengono scambiate per duplicati, ma due clip della stessa
 * canoa sì.
 */
const VIDEO_TITLE_STOPWORDS = new Set([
  "aerial", "amazing", "background", "beach", "beautiful", "blue", "boat",
  "broll", "camera", "cinematic", "city", "clip", "clips", "close", "clouds",
  "coast", "colorful", "drone", "footage", "hd", "holiday", "holidays",
  "island", "landscape", "leisure", "motion", "nature", "ocean", "outdoor",
  "outdoors", "palm", "panorama", "paradise", "people", "person", "relax",
  "relaxing", "resort", "sand", "scene", "sea", "shore", "sky", "slow",
  "stock", "summer", "sun", "sunrise", "sunset", "tour", "tourism", "tourist",
  "tourists", "travel", "tree", "trees", "trip", "tropical", "vacation",
  "video", "view", "views", "water", "wave", "waves", "woman",
  // Colori e aggettivi di qualità: compaiono in quasi ogni titolo stock
  // ("white sand", "turquoise water", "clear sea") e NON distinguono una clip
  // dall'altra. Vanno scartati, altrimenti due spiagge diverse che condividono
  // l'aggettivo verrebbero scambiate per duplicati.
  "amber", "aqua", "azure", "black", "breathtaking", "bright", "brown",
  "calm", "clear", "clean", "crystal", "cyan", "deep", "deserted",
  "emerald", "empty", "endless", "expansive", "fresh", "gentle", "golden",
  "gray", "green", "grey", "idyllic", "incredible", "indigo", "lush",
  "magnificent", "natural", "peaceful", "perfect", "pink", "pristine",
  "pure", "purple", "quiet", "red", "scenic", "serene", "shallow",
  "silver", "smooth", "soft", "spectacular", "stunning", "sunny", "teal",
  "tranquil", "turquoise", "vibrant", "violet", "vivid", "warm", "white",
  "wild", "yellow",
  // Function word inglesi (lunghezza >= 4): puro rumore in un titolo stock.
  "about", "after", "along", "also", "around", "before", "being", "between",
  "during", "from", "have", "into", "just", "like", "more", "most", "near",
  "onto", "over", "some", "still", "that", "than", "their", "them", "then",
  "there", "these", "they", "this", "those", "under", "upon", "using", "very",
  "were", "what", "when", "where", "which", "while", "will", "with", "without",
  "would", "your",
  // Nomi di Paese, nazionalità e continenti: compaiono in QUASI ogni tag di
  // Pixabay/Pexels per la stessa destinazione ("netherlands", "japan", "greek").
  // Non sono "soggetti" distintivi: se contassero, due clip diverse della stessa
  // città condiviverebbero il Paese e verrebbero scartate come quasi-duplicati,
  // lasciando il reel con 1-2 clip ripetute (il bug dei video con 2 scene sole).
  "africa", "african", "africans", "america", "american", "americans", "arab",
  "argentina", "argentinian", "asia", "asian", "australia", "australian",
  "austria", "austrian", "brazil", "brazilian", "britain", "british",
  "canada", "canadian", "caribbean", "china", "chinese", "colombia",
  "croatia", "croatian", "cuba", "cuban", "cyprus", "czech", "czechia",
  "denmark", "danish", "dominican", "dutch", "egypt", "egyptian", "emirati",
  "england", "english", "europe", "european", "europeans", "finland",
  "finnish", "france", "french", "german", "germany", "greece", "greek",
  "holland", "hungarian", "hungary", "iceland", "icelandic", "indonesia",
  "indonesian", "ireland", "irish", "italian", "italy", "japan", "japanese",
  "kenya", "kenyan", "korea", "korean", "maldives", "malta", "maltese",
  "mauritius", "mediterranean", "mexican", "mexico", "moroccan", "morocco",
  "netherlands", "norway", "norwegian", "peru", "peruvian", "poland",
  "polish", "portugal", "portuguese", "russia", "russian", "seychelles",
  "singapore", "spain", "spanish", "sweden", "swedish", "swiss",
  "switzerland", "tanzania", "tanzanian", "thai", "thailand", "turkish",
  "turkey", "uae", "united", "states", "world",

  // Descrittori urbani/geografici generici: presenti in molti titoli di clip
  // della stessa destinazione senza distinguere una ripresa dall'altra
  // ("building", "street", "river", "bridge", "canal"...). Scartarli evita di
  // confondere due clip diverse per quasi-duplicati. I soggetti VERAMENTE
  // distintivi ("canoe", "windmill", "reef", "safari", "tulip") restano fuori.
  "ancient", "architecture", "architectural", "building", "buildings", "bridge",
  "bridges", "canal", "canals", "channel", "church", "cityscape", "coastline",
  "concrete", "crowd", "crowds", "downtown", "facade", "facades", "fountain",
  "garden", "gardens", "gate", "harbor", "harbour", "historic", "historical",
  "landmark", "landmarks", "lane", "lighthouse", "marina", "monument",
  "monuments", "mosque", "museum", "neighborhood", "neighbourhood", "old",
  "park", "parks", "pier", "plaza", "port", "reflect", "reflection",
  "reflections", "river", "rivers", "road", "roads", "ruin", "ruins",
  "skyscraper", "skyscrapers", "square", "statue", "statues", "street",
  "streets", "temple", "temples", "tower", "towers", "town", "traffic",
  "urban", "vehicle", "vehicles", "village",

  // Momenti della giornata e termini d'acqua generici: appaiono in molti
  // titoli stock senza distinguere la ripresa ("morning", "waterway").
  "afternoon", "dawn", "daytime", "dusk", "evening", "midday", "morning",
  "night", "nighttime", "noon", "underwater", "waterway", "waterways",
]);

/** Stem leggero: riduce "canoeing"/"canoes" a "canoe" per confrontare i soggetti
 *  senza un POS tagger. Abbastanza per unire le flessioni più comuni. */
function englishLightStem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** True se il titolo della clip nomina la destinazione o un suo luogo atteso. */
function titleRelatesTo(title: string | null | undefined, expected: Set<string>): boolean {
  if (!title) return true;
  for (const t of title.toLowerCase().split(/[^a-z]+/)) {
    if (t.length >= 3 && expected.has(t)) return true;
  }
  return false;
}

/**
 * I "soggetti" distintivi di un titolo di clip stock: i token che restano dopo
 * aver tolto stopword, funzione e i token della destinazione/luoghi. Un titolo
 * senza soggetti (troppo generico) restituisce un insieme vuoto: non si può
 * giudicare la similarità, e la clip passa.
 */
function significantTitleSubjects(
  title: string | null | undefined,
  ignored: Set<string>
): Set<string> {
  const out = new Set<string>();
  if (!title) return out;
  for (const raw of title.toLowerCase().split(/[^a-z]+/)) {
    const tok = raw.trim();
    if (tok.length < 4) continue;
    if (VIDEO_TITLE_STOPWORDS.has(tok)) continue;
    if (ignored.has(tok)) continue;
    const stemmed = englishLightStem(tok);
    if (VIDEO_TITLE_STOPWORDS.has(stemmed)) continue;
    if (ignored.has(stemmed)) continue;
    out.add(stemmed);
  }
  return out;
}

/**
 * Clip video CURATE (file messi a mano dall'utente in public/curated/videos/<slug>).
 *
 * Sono la PRIMA fonte per le clip del reel: l'utente ha già selezionato i file,
 * quindi sono pertinenti e approvati. Si usano direttamente come clip reali del
 * montaggio (il motore ffmpeg le taglia in segmenti da ~3s). Una cartella vuota
 * (o una destinazione non curata) non blocca nulla: si ricade sulla ricerca stock.
 */
async function collectCuratedVideoClips(
  query: string | null | undefined,
  limit: number
): Promise<VideoFrameSource[]> {
  if (!query?.trim()) return [];
  const slug = curatedFolderSlug(query);
  if (!slug) return [];
  const files = await listCuratedVideos(slug);
  const out: VideoFrameSource[] = [];
  for (const file of files) {
    if (out.length >= limit) break;
    out.push({ url: file, origin: "curated", hasOverlay: false });
  }
  return out;
}

async function resolveStockVideoClips(
  query: string | null | undefined,
  limit: number
): Promise<VideoFrameSource[]> {
  if (!query?.trim()) return [];

  const base = query.trim();

  // Clips già usate in passato, da saltare così ogni video mostra scene nuove.
  const used = await usedStockIdentity();

  // Provider di clip video: Pexels e Pixabay (gratuiti, nessun limite
  // giornaliero, clip anche verticali). Magnific è DISATTIVATO di default
  // (crediti limitati ~10/giorno, condivisi con le FOTO; il download esaurito
  // risponde 402): resta qui solo per chi imposta `VIDEO_USE_MAGNIFIC=true`.
  const providers: StockVideoProvider[] = [
    getPexelsVideoProvider(),
    getPixabayVideoProvider(),
    getStockVideoProvider(),
  ].filter((p): p is StockVideoProvider => p !== null);

  // Una clip per ogni LUOGO ICONICO (dalle tappe curate), poi il nome della
  // destinazione completa il resto. Cercare solo il nome restituisce anche
  // riprese anonime (strade qualsiasi); l'unione "destinazione + luogo" evita
  // anche i falsi positivi (un "Central Park" generico non è per forza quello
  // di New York). Una destinazione senza conoscenza curata usa il solo nome.
  // Più clip per LUOGO: `n` non è il numero di clip che finiscono nel reel, ma
  // quante ne chiediamo per avere margine. Con `n: 1` una clip già usata (o un
  // download fallito) svuotava l'intero luogo e il reel restava con 2 clip
  // ripetute. Con `n: 3` ogni luogo ha tre candidati per saltare i già usati.
  // Token della destinazione e dei luoghi iconici: compaiono legittimamente in
  // quasi tutti i titoli delle clip trovate, quindi NON contano come "soggetti"
  // nella dedup di similarità. Solo ciò che resta (canoa, barriera, mercato...)
  // distingue davvero una ripresa dall'altra.
  // Query INGLESI dalle tappe curate (VIDEO_SEARCH): i provider stock
  // (Pexels/Pixabay/Magnific) indicizzano in inglese, quindi "athens acropolis"
  // trova riprese vere, mentre "atene Acropoli" non trova quasi nulla.
  const curated = videoSearch(base);
  const landmarks = curated ? [] : landmarkQueries(base);
  const ignoredTokens = new Set<string>();
  for (const t of base.toLowerCase().split(/[^a-z]+/)) {
    if (t.length >= 3) ignoredTokens.add(t);
  }
  for (const lm of curated ? curated.landmarks : landmarks) {
    for (const t of lm.toLowerCase().split(/[^a-z]+/)) {
      if (t.length >= 3) ignoredTokens.add(t);
    }
  }

  // Filtro di pertinenza PER-QUERY: ogni tappa ha i SUOI token specifici (la
  // query senza il nome della destinazione). Il titolo della clip deve
  // contenerne almeno uno, così "big ben london" restituisce davvero Big Ben
  // (e non una strada generica di Londra), "maldives beach" restituisce
  // spiagge (e non un interno anonimo). La query col solo nome resta come
  // riempimento finale e richiede solo il nome della destinazione.
  const nameTokens = new Set<string>();
  if (curated) {
    for (const t of curated.name.toLowerCase().split(/[^a-z]+/)) {
      if (t.length >= 3) nameTokens.add(t);
    }
  }
  const makeSpecific = (q: string): Set<string> => {
    const specific = new Set<string>();
    for (const t of q.toLowerCase().split(/[^a-z]+/)) {
      if (t.length >= 3 && !nameTokens.has(t)) specific.add(t);
    }
    return specific;
  };

  // Per le destinazioni CURATE le tappe iconiche inglesi forniscono varietà e
  // pertinenza. `n: 2` per tappa (non 3) distribuisce le 6 clip su 3-4 luoghi
  // diversi invece di svuotare il primo (per es. Maldive: spiaggia + villaggi
  // overwater + atollo, non 3 volte la stessa spiaggia). Per quelle NON curate
  // (destinazioni inventate nei test) resta il solo nome con filtro permissivo.
  const wants: { q: string; n: number; strict: boolean; specific: Set<string> }[] = curated
    ? [
        ...curated.landmarks.map((q) => ({ q, n: 2, strict: true, specific: makeSpecific(q) })),
        { q: curated.name, n: 2, strict: true, specific: new Set<string>() },
      ]
    : [
        ...landmarks.map((q) => ({ q: `${base} ${q}`, n: 3, strict: false, specific: new Set<string>() })),
        { q: base, n: limit, strict: false, specific: new Set<string>() },
      ];

  const out: VideoFrameSource[] = [];
  const seenUrls = new Set<string>();
  /** Soggetti distintivi già accettati: una clip che li ripete è un duplicato. */
  const seenSubjects = new Set<string>();
  /** Contatori di scarto, per capire al volo perché poche clip sopravvivono. */
  const rejected: Record<string, number> = {};
  const bump = (k: string) => { rejected[k] = (rejected[k] ?? 0) + 1; };
  console.log(`[video] clip stock già usate in passato da escludere: ${used.urls.size} url, ${used.ids.size} id`);
  for (const want of wants) {
    if (out.length >= limit) break;
    const q = want.q.trim().slice(0, 120);
    for (const provider of providers) {
      if (out.length >= limit) break;
      // Chiediamo più candidati di quanti ne accettiamo: quelli già usati o
      // quasi-duplicati vengono scartati qui sotto, quindi serve margine per
      // scendere oltre i primi risultati popolari (che a ogni giro tornano gli
      // stessi) e trovare scene nuove. L'accettazione resta limitata a `want.n`
      // per non svuotare un solo luogo a scapito degli altri.
      const request = Math.min(Math.max(want.n * 3, 9), 20);
      const found = await provider.searchVideo({ query: q, limit: request });
      let acceptedHere = 0;
      for (const video of found) {
        if (out.length >= limit) break;
        if (acceptedHere >= want.n) break;
        if (seenUrls.has(video.sourceUrl)) continue;

        // RIUTILIZZO: se la clip è già stata scaricata in passato e il file è
        // ancora su disco, la riusiamo invece di riscaricarla. Solo l'id
        // risorsa conta (l'URL CDN può cambiare tra una chiamata e l'altra).
        let localUrl: string | null = null;
        if (video.resourceId !== null && video.resourceId !== undefined) {
          const candidate = used.localById.get(video.resourceId);
          if (candidate && (await uploadedFileExists(candidate))) localUrl = candidate;
        }
        if (!localUrl) {
          if (used.urls.has(video.sourceUrl)) { bump("già usata (url)"); continue; }
          if (video.resourceId !== null && used.ids.has(video.resourceId)) { bump("già usata (id)"); continue; }
        }

        // Pertinenza: il titolo deve nominare la destinazione o, per le tappe
        // specifiche, il loro landmark (token `specific`), non una qualunque
        // ripresa che nomina solo la città. Le tappe col solo nome richiedono
        // appunto il nome della destinazione.
        if (want.strict) {
          const expected = want.specific.size > 0 ? want.specific : nameTokens;
          if (!titleRelatesTo(video.title, expected)) { bump("fuori tema (titolo)"); continue; }
        }

        // Dedup visiva: salta una clip se il suo titolo condivide un "soggetto"
        // distintivo con una clip già accettata (es. tre inquadrature della
        // stessa canoa). I soggetti si registrano solo DOPO che la clip è stata
        // davvero scaricata e salvata, così un download fallito non blocca una
        // clip simile ma valida successiva.
        const subjects = significantTitleSubjects(video.title, ignoredTokens);
        let duplicate = false;
        for (const s of subjects) {
          if (seenSubjects.has(s)) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) { bump("quasi-duplicato"); continue; }

        if (localUrl) {
          // Riuso diretto del file già a terra: nessun download, nessun credito.
          seenUrls.add(video.sourceUrl);
          seenUrls.add(localUrl);
          out.push({
            url: localUrl,
            origin: "stock",
            hasOverlay: false,
            sourceUrl: video.sourceUrl,
            resourceId: video.resourceId,
          });
          acceptedHere += 1;
          for (const s of subjects) seenSubjects.add(s);
          bump("riusata da disco");
          continue;
        }

        seenUrls.add(video.sourceUrl);
        const downloaded = await provider.downloadVideo(video);
        if (!downloaded) { bump("download fallito"); continue; }
        try {
          const saved = await saveUploadedFile({
            buffer: downloaded.buffer,
            originalName: `stock-${video.resourceId ?? "clip"}.mp4`,
            mimeType: downloaded.mimeType,
          });
          out.push({
            url: saved.url,
            origin: "stock",
            hasOverlay: false,
            sourceUrl: video.sourceUrl,
            resourceId: video.resourceId,
          });
          acceptedHere += 1;
          for (const s of subjects) seenSubjects.add(s);
        } catch (e) {
          bump("salvataggio fallito");
          logAIError("stock-video.save", { sourceUrl: video.sourceUrl }, e);
        }
      }
    }
  }
  console.log(`[video] clip stock risolte: ${out.length} distinte`);
  if (Object.keys(rejected).length > 0) {
    console.log(`[video] clip scartate: ${Object.entries(rejected).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }
  return out;
}

/**
 * Fotografie reali della destinazione dalla ricerca FOTO stock (Magnific).
 *
 * Il provider stock è un archivio di FOTOGRAFIE, non di video: quando la
 * destinazione non ha clip video reali, queste immagini diventano i fotogrammi
 * del montaggio Ken Burns (titolo/logo solo sulla copertina). È la fonte
 * visiva che fa produrre sempre un reel utilizzabile da "crea un video per X"
 * senza caricare nulla a mano.
 */
async function resolveStockPhotoFrames(
  query: string | null | undefined,
  limit: number
): Promise<VideoFrameSource[]> {
  if (!query?.trim()) return [];
  const provider = getStockProvider();
  if (typeof provider.searchImages !== "function") return [];

  const images = await provider.searchImages({ query: query.trim().slice(0, 120), limit });
  const out: VideoFrameSource[] = [];
  for (const image of images) {
    if (out.length >= limit) break;
    try {
      const saved = await saveUploadedFile({
        buffer: image.buffer,
        originalName: image.filename || `stock-${image.resourceId ?? "frame"}.jpg`,
        mimeType: image.mimeType,
      });
      out.push({ url: saved.url, origin: "stock", hasOverlay: false });
    } catch (e) {
      logAIError("stock-photo.save", { sourceUrl: image.sourceUrl }, e);
    }
  }
  return out;
}

/**
 * Clip video LOCALI (ripiego): gli asset VIDEO del contenuto per primi, poi
 * quelli della Media Library pertinenti alla query (ricerca per token). Un
 * file assente dal disco non è una clip.
 */
async function collectLocalVideoClips(
  contentId: string,
  query: string | null | undefined,
  limit: number
): Promise<VideoFrameSource[]> {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);

  const out: VideoFrameSource[] = [];
  const seen = new Set<string>();

  const candidates = await prisma.contentAsset.findMany({
    where: { kind: "VIDEO" },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const contentFirst = [
    ...candidates.filter((a) => a.contentId === contentId),
    ...candidates.filter((a) => a.contentId !== contentId),
  ];

  for (const asset of contentFirst) {
    if (out.length >= limit) break;
    if (seen.has(asset.url)) continue;
    if (!(await uploadedFileExists(asset.url))) continue;
    if (tokens.length > 0 && asset.contentId !== contentId) {
      const haystack = `${asset.filename} ${JSON.stringify(asset.metadata ?? {})}`.toLowerCase();
      if (!tokens.every((t) => haystack.includes(t))) continue;
    }
    seen.add(asset.url);
    out.push({ url: asset.url, origin: "asset", hasOverlay: false });
  }
  return out;
}

/**
 * Porta un URL di fotogramma a un file locale leggibile da ffmpeg.
 *
 * I file sotto /uploads devono esistere davvero: un asset che punta a un file
 * sparito viene saltato, non fa fallire tutta la generazione. Gli URL remoti
 * vengono scaricati solo dentro l'allowlist della fonte di catalogo del
 * contenuto: è la stessa difesa del visual del catalogo, e senza allowlist il
 * download viene rifiutato dal modulo remoto.
 */
async function materializeLocalFrame(
  source: VideoFrameSource,
  allowedDomains: string[]
): Promise<string | null> {
  if (source.url.startsWith("/")) {
    return (await uploadedFileExists(source.url)) ? source.url : null;
  }
  if (!/^https?:\/\//i.test(source.url)) return null;
  if (allowedDomains.length === 0) return null;
  try {
    const saved = await downloadRemoteImage({
      url: source.url,
      allowedDomains,
      originalName: filenameFromUrl(source.url),
    });
    return saved.url;
  } catch {
    // Un fotogramma scaricato male non deve abortire il reel: si salta e si
    // procede con gli altri. Se nessuno è materializzabile, il chiamante lo
    // dichiara con un messaggio suo.
    return null;
  }
}

/**
 * Genera il video (slideshow) per un contenuto e lo collega come asset VIDEO.
 *
 * Non dipende da slide o asset già materializzati: le immagini remote della
 * proposta vengono scaricate negli upload prima di chiamare il provider, così
 * la generazione richiesta dall'utente parte anche quando il contenuto è nato
 * dal catalogo e nessuno ha caricato file a mano.
 */
/**
 * Pianificazione del montaggio.
 *
 * Il reel finale dura tra 15 e 20 secondi con una scena ogni ~3 secondi
 * (5-6 scene). La prima scena è la COPERTINA: l'immagine con eventuale
 * overlay (titolo/logo) composto dal flusso visual. Le scene successive
 * usano solo immagini PULITE: il titolo e il logo vivono nei primi ~3
 * secondi e scompaiono del tutto dal resto del video.
 *
 * Con poche immagini si ricicla/alterna: la copertina una volta sola, poi
 * le pulite in ciclo con il Ken Burns alternato del provider, così la
 * durata è coperta anche con due sole foto senza bloccare la generazione.
 */
const SCENE_SECONDS = 3;
const MIN_TOTAL_SECONDS = 15;
const MAX_TOTAL_SECONDS = 20;

/**
 * Costruisce le clip del montaggio.
 *
 * 1. copertina: l'immagine del visual (eventuale overlay già composto); se
 *    NON ha overlay, il montaggio glielo imprime (drawtext + logo) — solo qui;
 * 2. segmenti video: per ogni clip reale, tutti i tagli da 3s che la durata
 *    vera (ffprobe) consente, nell'ordine;
 * 3. riciclo dei segmenti finché il minimo di scene (15s) non è coperto;
 * 4. riempimento con scene pulite a immagini (Ken Burns) se i video finiscono.
 */
/**
 * Risolve l'input di una clip per ffmpeg/ffprobe.
 *
 * In cloud (Vercel) la clip si passa come URL pubblico di R2: ffmpeg/ffprobe
 * leggono via HTTP con richieste "range", scaricando solo i ~3s necessari
 * invece dell'intero file (le clip curate arrivano anche a 140MB). In locale
 * resta il materialize sul percorso del disco.
 */
async function clipInputPath(ref: string): Promise<string> {
  if (isCloudStorage()) return publicUrlFor(ref);
  return materialize(ref);
}

async function buildMontageClips(input: {
  coverFrame: string | null;
  coverHasOverlay: boolean;
  title: string;
  cleanFrames: string[];
  videoClips: VideoFrameSource[];
}): Promise<MontageClip[]> {
  const maxScenes = Math.floor(MAX_TOTAL_SECONDS / SCENE_SECONDS); // 6
  const minScenes = Math.ceil(MIN_TOTAL_SECONDS / SCENE_SECONDS); // 5

  const logoPath = await brandLogoPath();
  const title = input.title.trim();
  const coverOverlay =
    input.coverHasOverlay || (!title && !logoPath)
      ? null
      : { title, logoPath };

  const scenes: MontageClip[] = [];

  // Segmenti: ogni clip reale fornisce tutti i tagli da 3s che la sua durata
  // (ffprobe) consente — mai un taglio oltre la fine del sorgente. I segmenti
  // vengono poi INTERLEAVED (round-robin), un taglio per clip sorgente per
  // volta: il reel alterna i luoghi invece di svuotare un solo clip (che
  // apparirebbe come un'unica lunga ripresa) prima del successivo.
  // Download + probe in PARALLELO (tetto di concorrenza 3): su Vercel le clip
  // vivono su R2 e il download sequenziale di 6 file (anche >100MB l'uno per
  // le riprese 1080p/60fps) è il collo di bottiglia dominante. Concorrenza
  // limitata a 3 per non esaurire la RAM del piano Hobby.
  const perClip: { path: string; trimStartSec: number }[][] = await mapLimit(
    input.videoClips,
    3,
    async (clip): Promise<{ path: string; trimStartSec: number }[]> => {
      const abs = await clipInputPath(clip.url);
      const duration = await probeVideoDurationSec(abs);
      const usable = Math.max(1, duration ? Math.floor(duration / SCENE_SECONDS) : 1);
      const list: { path: string; trimStartSec: number }[] = [];
      for (let k = 0; k < usable; k += 1) {
        list.push({ path: abs, trimStartSec: k * SCENE_SECONDS });
      }
      return list;
    }
  );
  const segments: { path: string; trimStartSec: number }[] = [];
  const maxRounds = perClip.reduce((m, l) => Math.max(m, l.length), 0);
  for (let round = 0; round < maxRounds; round += 1) {
    for (const list of perClip) {
      if (round < list.length) segments.push(list[round]);
    }
  }

  // COPERTINA: quando ci sono clip video reali, il reel apre su una CLIP VIDEO
  // (non su una foto zoomata) — è lei a ricevere titolo e logo. L'immagine del
  // visual resta SOLO come ripiego per lo slideshow, quando di video non ce ne
  // sono affatto. "Crea un video per X" non deve mai partire da un fermo immagine.
  if (segments.length > 0) {
    const first = segments.shift()!;
    scenes.push({
      path: first.path,
      type: "video",
      trimStartSec: first.trimStartSec,
      sceneSeconds: SCENE_SECONDS,
      overlay: coverOverlay,
    });
  } else if (input.coverFrame) {
    scenes.push({
      path: await materialize(input.coverFrame),
      type: "image",
      sceneSeconds: SCENE_SECONDS,
      overlay: coverOverlay,
    });
  }

  // Una sola scena per clip sorgente, finché i luoghi distinti lo consentono:
  // mai la stessa ripresa due volte (in testa o in coda al reel). Solo quando
  // le clip distinte NON bastano a coprire il minimo (15s) si riusa un taglio
  // più avanzato della stessa clip (stesso luogo, inquadratura diversa).
  const usedSources = new Set<string>();
  const usedExact = new Set<string>();
  for (const s of scenes) {
    usedSources.add(s.path);
    usedExact.add(`${s.path}@${s.trimStartSec ?? 0}`);
  }

  // 1) una scena per ogni clip DISTINTA, nell'ordine alternato del round-robin.
  let si = 0;
  while (scenes.length < maxScenes && si < segments.length) {
    const segment = segments[si];
    if (!usedSources.has(segment.path)) {
      scenes.push({
        path: segment.path,
        type: "video",
        trimStartSec: segment.trimStartSec,
        sceneSeconds: SCENE_SECONDS,
      });
      usedSources.add(segment.path);
      usedExact.add(`${segment.path}@${segment.trimStartSec}`);
    }
    si += 1;
  }

  // 2) se il minimo (15s) non è ancora coperto, riusa tagli più avanti nello
  // stesso sorgente (mai lo stesso identico taglio).
  let ri = 0;
  while (scenes.length < minScenes && ri < segments.length) {
    const segment = segments[ri];
    const key = `${segment.path}@${segment.trimStartSec}`;
    if (!usedExact.has(key)) {
      scenes.push({
        path: segment.path,
        type: "video",
        trimStartSec: segment.trimStartSec,
        sceneSeconds: SCENE_SECONDS,
      });
      usedExact.add(key);
    }
    ri += 1;
  }

  // 3) ultimo riempimento con scene pulite a immagini (Ken Burns), mai con la
  // copertina (che porterebbe l'overlay).
  let ci = 0;
  while (scenes.length < minScenes && input.cleanFrames.length > 0) {
    scenes.push({
      path: await materialize(input.cleanFrames[ci % input.cleanFrames.length]),
      type: "image",
      sceneSeconds: SCENE_SECONDS,
    });
    ci += 1;
  }
  return scenes;
}

/** Percorso locale del logo del brand, se caricato in Media Library. */
async function brandLogoPath(): Promise<string | null> {
  try {
    const brand = await getBrand();
    const logoUrl = brand?.logoUrl?.trim();
    if (!logoUrl) return null;
    if (!(await uploadedFileExists(logoUrl))) return null;
    return await materialize(logoUrl);
  } catch {
    return null;
  }
}

function planScenes(frames: string[]): { imagePath: string; durationSec: number }[] {
  if (frames.length === 0) return [];
  const maxScenes = Math.floor(MAX_TOTAL_SECONDS / SCENE_SECONDS); // 6
  const minScenes = Math.ceil(MIN_TOTAL_SECONDS / SCENE_SECONDS); // 5
  const cover = frames[0];
  const clean = frames.slice(1);
  const uniqueScenes = 1 + clean.length;
  const sceneCount = Math.min(maxScenes, Math.max(minScenes, uniqueScenes));
  const sceneImages: string[] = [cover];
  for (let i = 1; i < sceneCount; i += 1) {
    // Riciclo solo delle PULITE: la copertina (con overlay) non torna mai
    // dopo la prima scena. Senza pulite disponibili non resta che riuse la
    // copertina, dichiarato qui: è l'unico caso in cui l'overlay riaffiora.
    sceneImages.push(clean.length > 0 ? clean[(i - 1) % clean.length] : cover);
  }
  return sceneImages.map((imagePath) => ({ imagePath, durationSec: SCENE_SECONDS }));
}

/**
 * Traccia musicale per il sottofondo del reel, se disponibile.
 *
 * Ordine di risoluzione:
 * 1. `VIDEO_MUSIC_FILE` (percorso assoluto o `/uploads/...`), se esiste;
 * 2. il primo asset `AUDIO` in Media Library con file ancora su disco;
 * 3. `null` → video senza audio (il provider degrada a `-an`).
 *
 * Nessuna musica viene scaricata da Internet né hardcodata: senza una fonte
 * l'audio viene semplicemente omesso, senza rompere la generazione. La
 * risoluzione non deve MAI far fallire il reel: ogni errore interno ricade su
 * `null`.
 */
async function resolveBackgroundMusic(): Promise<{ path: string | null; volume: number }> {
  const rawVolume = Number(process.env.VIDEO_MUSIC_VOLUME ?? "0.2");
  const volume = Number.isFinite(rawVolume) ? Math.min(1, Math.max(0, rawVolume)) : 0.2;

  const envFile = process.env.VIDEO_MUSIC_FILE?.trim();
  if (envFile) {
    try {
      const abs = await materialize(envFile);
      await fs.access(abs);
      return { path: abs, volume };
    } catch {
      console.warn(`[video] VIDEO_MUSIC_FILE non trovato su disco: ${envFile}`);
    }
  }

  try {
    const audios = await prisma.contentAsset.findMany({
      where: { kind: "AUDIO" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const asset of audios) {
      if (!(await uploadedFileExists(asset.url))) continue;
      return { path: await materialize(asset.url), volume };
    }
  } catch (e) {
    logAIError("video.audio.resolve", {}, e);
  }

  // Colonne sonore multiple: si usano TUTTI i file audio presenti in
  // public/audio/. Oggi c'è una sola traccia, ma basta aggiungere file
  // .mp3/.m4a/.wav a quella cartella per avere più melodie, scelte a caso a
  // ogni video, senza toccare il codice.
  try {
    const dir = path.join(process.cwd(), "public", "audio");
    const tracks = (await fs.readdir(dir))
      .filter((f) => /\.(m4a|mp3|wav|aac|ogg)$/i.test(f))
      .map((f) => path.join(dir, f));
    if (tracks.length > 0) {
      const picked = tracks[Math.floor(Math.random() * tracks.length)];
      return { path: picked, volume };
    }
  } catch {
    // cartella assente: si prosegue senza audio
  }

  return { path: null, volume };
}

export async function generateVideoForContent(input: {
  contentId: string;
  /** Iniettabile nei test: di default è il provider configurato. */
  provider?: VideoProvider;
  /**
   * Parole chiave della destinazione: con pochi fotogrammi sul contenuto,
   * la Media Library viene cercata per aggiungere scene allo slideshow.
   */
  query?: string | null;
  /**
   * URL della copia pulita (senza titolo/logo) della copertina, prodotto dal
   * flusso visual (`keepCleanScene`): diventa la scena delle clip successive
   * alla prima, garantendo che l'overlay viva solo nei primi ~3 secondi.
   */
  cleanSceneUrl?: string | null;
}): Promise<GenerateVideoResult> {
  const content = await getContentOrThrow(input.contentId);

  let sources = await collectVideoFrameSources(content.id);

  // Un reel di una sola immagine è una foto ferma: se la libreria ha altre
  // immagini pertinenti alla destinazione, diventano scene in più (ogni
  // fotogramma è comunque animato con Ken Burns lato provider).
  if (sources.length < 4 && input.query?.trim()) {
    const usedUrls = new Set(sources.map((s) => s.url));
    const extra = await findLibraryFrames(input.query, usedUrls, 4 - sources.length);
    sources.push(...extra);
  }

  // La scena pulita (stessa foto, senza il template del post) diventa la
  // COPERTINA del video: il montaggio stampa da sé il titolo (solo il nome
  // della destinazione) + logo in modo elegante. L'immagine con il template
  // già composto (banner + rubrica del formato editoriale) NON entra nel
  // reel: resta solo come locandina/anteprima nell'interfaccia.
  if (input.cleanSceneUrl) {
    sources = sources.filter((s) => !s.hasOverlay);
    const idx = sources.findIndex((s) => s.url === input.cleanSceneUrl);
    if (idx === -1) {
      sources.unshift({ url: input.cleanSceneUrl, origin: "library", hasOverlay: false });
    } else if (idx > 0) {
      const [clean] = sources.splice(idx, 1);
      sources.unshift(clean);
    }
  }

  // Allowlist per il download dei fotogrammi remoti: solo il dominio della
  // fonte da cui la proposta è arrivata in catalogo.
  const allowedDomains: string[] = [];
  if (content.catalogProposalId) {
    const proposal = await prisma.catalogProposal.findUnique({
      where: { id: content.catalogProposalId },
      select: { source: { select: { domain: true } } },
    });
    if (proposal?.source?.domain) allowedDomains.push(proposal.source.domain);
  }

  const frames: string[] = [];
  for (const source of sources) {
    const local = await materializeLocalFrame(source, allowedDomains);
    if (local) frames.push(local);
  }

  const provider = input.provider ?? getVideoProvider();
  let slidePlan = planScenes(frames);

  // Traccia musicale di sottofondo (o `null` se assente). La risoluzione è
  // difensiva e non fa fallire la generazione.
  const audio = await resolveBackgroundMusic();

  // Clip CURATE (file dell'utente) come PRIMA fonte, poi la ricerca stock, poi
  // la Media Library locale. Se la cartella curata ha già clip a sufficienza, la
  // ricerca stock non viene nemmeno interrogata (risparmio di chiamate/crediti);
  // altrimenti Pixabay/Pexels completano fino a 6 clip. Magnific entra solo come
  // integrazione, mai come fonte primaria (crediti limitati).
  // Con CURATED_MEDIA_ONLY=true il reel usa ESCLUSIVAMENTE le clip curate:
  // Pixabay/Pexels/Magnific e la Media Library non vengono toccati.
  const curatedClips = await collectCuratedVideoClips(input.query, 6);
  const stockClips =
    config.curatedMediaOnly || curatedClips.length >= 6
      ? []
      : await resolveStockVideoClips(input.query, 6 - curatedClips.length);
  const localClips = config.curatedMediaOnly
    ? []
    : await collectLocalVideoClips(content.id, input.query, 4);
  const seenUrls = new Set<string>();
  const videoClips: VideoFrameSource[] = [];
  for (const clip of [...curatedClips, ...stockClips, ...localClips]) {
    if (seenUrls.has(clip.url)) continue;
    seenUrls.add(clip.url);
    videoClips.push(clip);
  }

  // Identità delle clip stock usate in questo montaggio. URL remoto, id risorsa
  // E percorso locale su disco: le generazioni successive li riusano (file già
  // scaricato) invece di riscaricarli, risparmiando crediti e spazio su disco.
  const usedStockUrls = videoClips
    .filter((c) => c.origin === "stock" && c.sourceUrl)
    .map((c) => c.sourceUrl as string);
  const usedStockIds = videoClips
    .filter((c) => c.origin === "stock" && c.resourceId !== null && c.resourceId !== undefined)
    .map((c) => c.resourceId as number);
  const stockLocalPaths: Record<string, string> = {};
  for (const c of videoClips) {
    if (c.origin === "stock" && c.resourceId !== null && c.resourceId !== undefined && c.url) {
      stockLocalPaths[String(c.resourceId)] = c.url;
    }
  }

  // Fallback fotografico: quando non ci sono clip video reali (Magnific è un
  // archivio di FOTO), le fotografie della destinazione diventano i fotogrammi
  // del montaggio Ken Burns. La ricerca stock parte SEMPRE dal provider esterno.
  // Solo quando il contenuto è nato SENZA immagini (caso "crea video per X"):
  // non deve arricchire contenuti che hanno già i loro fotogrammi, per non
  // mescolare le fonti e per non toccare la rete nei test che iniettano query
  // su contenuti con immagini già presenti.
  if (
    !config.curatedMediaOnly &&
    videoClips.length === 0 &&
    frames.length === 0 &&
    input.query?.trim()
  ) {
    const stockPhotos = await resolveStockPhotoFrames(input.query, 6);
    for (const p of stockPhotos) frames.push(p.url);
    slidePlan = planScenes(frames);
  }

  const canMontage =
    typeof provider.generateMontage === "function" &&
    (videoClips.length > 0 || frames.length > 0);
  if (videoClips.length > 0 && !provider.generateMontage) {
    console.error(
      `[video] il provider "${provider.name}" non supporta il montaggio: si ricade sullo slideshow a immagini.`
    );
  }

  let generated;
  try {
    if (canMontage) {
      const montageClips = await buildMontageClips({
        coverFrame: frames[0] ?? null,
        coverHasOverlay: sources[0]?.hasOverlay === true,
        title: content.title ?? "",
        cleanFrames: frames.slice(1),
        videoClips,
      });
      console.log(
        `[video] montaggio pianificato: ${montageClips.length} clip, ${montageClips.reduce((a, c) => a + c.sceneSeconds, 0)}s`
      );
      generated = await provider.generateMontage!(montageClips, {
        width: 1080,
        height: 1920,
        fps: 25,
        audioPath: audio.path,
        audioVolume: audio.volume,
      });
    } else if (frames.length > 0) {
      generated = await provider.generateSlideshow(slidePlan, {
        width: 1080,
        height: 1920,
        fps: 25,
        audioPath: audio.path,
        audioVolume: audio.volume,
      });
    } else {
      // Né clip video (stock/locali) né immagini: niente da montare.
      const reason = input.query?.trim()
        ? config.curatedMediaOnly
          ? `Nessuna clip video selezionata per "${input.query.trim()}" in public/curated/videos: aggiungi i file alla cartella della destinazione oppure disattiva CURATED_MEDIA_ONLY.`
          : "Nessuna clip video trovata dalla ricerca stock per questa destinazione e nessuna immagine disponibile: la generazione non può partire."
        : "Nessuna clip video né immagine disponibile per generare il reel.";
      return { ok: false, reason };
    }
  } catch (e) {
    // Il "provider non configurato" (ffmpeg assente) è uno stato dichiarato,
    // non un guasto da nascondere: l'errore completo (incluso lo stderr di
    // ffmpeg, che il provider porta nel messaggio) va nel log strutturato e
    // il fallimento nell'audit, così la bozza non resta un mistero.
    logAIError("video.generate", {
      contentId: content.id,
      provider: provider.name,
      frames: frames.length,
      scenes: slidePlan.length,
      plannedSeconds: slidePlan.reduce((acc, s) => acc + s.durationSec, 0),
    }, e);
    await logAudit("VIDEO_GENERATION_FAILED", "Content", content.id, {
      phase: "render",
      frames: frames.length,
      reason: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: friendlyMessage(e) };
  }

  // Il provider dichiara successo, ma il file deve esistere davvero sul disco:
  // un asset VIDEO che punta a un file assente è esattamente la "bozza vuota
  // con il video" da evitare. Qui non è ancora stata scritta nessuna riga.
  if (!(await uploadedFileExists(generated.url))) {
    logAIError(
      "video.verify",
      { contentId: content.id, url: generated.url, provider: generated.provider },
      new Error("il provider ha dichiarato successo ma il file di output non esiste")
    );
    await logAudit("VIDEO_GENERATION_FAILED", "Content", content.id, {
      phase: "verify",
      url: generated.url,
      detail: "file di output assente dopo il rendering",
    });
    return {
      ok: false,
      reason: "La generazione non ha prodotto un file utilizzabile: nulla è stato salvato. Riprova.",
    };
  }

  // Persistenza con rollback: se l'asset o l'aggiornamento del tipo falliscono,
  // si ripulisce asset e file invece di lasciare una bozza incoerente (asset
  // VIDEO su un contenuto non VIDEO, o un file orfano in /uploads/videos).
  let asset;
  try {
    asset = await createAsset({
      url: generated.url,
      filename: filenameFromUrl(generated.url),
      mimeType: "video/mp4",
      kind: "VIDEO",
      contentId: content.id,
      metadata:
        usedStockUrls.length > 0 || usedStockIds.length > 0 || Object.keys(stockLocalPaths).length > 0
          ? {
              ...(usedStockUrls.length > 0 ? { stockSourceUrls: usedStockUrls } : {}),
              ...(usedStockIds.length > 0 ? { stockSourceIds: usedStockIds } : {}),
              ...(Object.keys(stockLocalPaths).length > 0 ? { stockLocalPaths } : {}),
            }
          : undefined,
    });

    await markContentAsVideo(content.id);
  } catch (e) {
    if (asset) {
      await prisma.contentAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    }
    await deleteUploadedFile(generated.url).catch(() => undefined);
    logAIError("video.persist", { contentId: content.id, url: generated.url }, e);
    await logAudit("VIDEO_GENERATION_FAILED", "Content", content.id, {
      phase: "persist",
      detail: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      reason: "Salvataggio del video non riuscito: nessun asset è stato scritto. Riprova.",
    };
  }

  const poster = await ensureVideoPoster(content.id);

  await logAudit("VIDEO_GENERATED", "ContentAsset", asset.id, {
    contentId: content.id,
    durationSec: generated.durationSec,
    frames: frames.length,
    posterAssetId: poster.ok ? poster.assetId : null,
  });

  return {
    ok: true,
    url: generated.url,
    durationSec: generated.durationSec,
    assetId: asset.id,
    provider: generated.provider,
    posterAssetId: poster.ok ? poster.assetId : null,
  };
}

/**
 * Assicura che il contenuto VIDEO abbia una locandina (copertina) IMAGE.
 *
 * Instagram e le anteprime dell'interfaccia mostrano un fotogramma statico:
 * un VIDEO senza locandina nasce "cieco". La locandina non viene generata con
 * provider esterni: è la prima immagine già disponibile sul contenuto, oppure
 * la prima immagine della proposta di catalogo collegata, creata come asset
 * IMAGE con `metadata.role: "POSTER"`. Se il contenuto ha già un'immagine
 * quella fa da locandina e non viene scritto nulla.
 */
export async function ensureVideoPoster(contentId: string): Promise<VideoPosterResult> {
  const content = await getContent(contentId);
  if (!content) throw new Error(`Contenuto non trovato (${contentId}).`);

  const existingImage = content.assets.find((a) => a.kind === "IMAGE");
  if (existingImage) {
    return { ok: true, assetId: existingImage.id, created: false };
  }

  // La locandina è un abbellimento, non una garanzia: un errore qui non deve
  // risalire fino a far sembrare fallita una generazione riuscita. Si logga e
  // si dichiara, il chiamante decide.
  try {
    return await ensureVideoPosterInner(content);
  } catch (e) {
    logAIError("video.poster", { contentId }, e);
    return {
      ok: false,
      reason: "Collegamento della locandina non riuscito: vedi i log server-side.",
    };
  }
}

async function ensureVideoPosterInner(
  content: NonNullable<Awaited<ReturnType<typeof getContent>>>
): Promise<VideoPosterResult> {
  const usedUrls = new Set(content.assets.map((a) => a.url));
  const candidates: { url: string; filename: string; origin: string; id?: string }[] = [];

  for (const slide of content.slides) {
    if (slide.imageUrl && !usedUrls.has(slide.imageUrl)) {
      usedUrls.add(slide.imageUrl);
      candidates.push({
        url: slide.imageUrl,
        filename: slide.imageUrl.split("/").pop() || "poster.jpg",
        origin: "slide",
      });
    }
  }

  if (content.catalogProposalId) {
    const proposal = await prisma.catalogProposal.findUnique({
      where: { id: content.catalogProposalId },
      include: { images: { orderBy: { acquiredAt: "asc" as const } } },
    });
    for (const image of proposal?.images ?? []) {
      if (!usedUrls.has(image.url)) {
        usedUrls.add(image.url);
        candidates.push({
          url: image.url,
          filename: image.filename,
          origin: "catalog-proposal",
          id: image.id,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        "Nessuna immagine disponibile per la locandina: carica una copertina o collega una proposta del catalogo.",
    };
  }

  const poster = candidates[0];

  // Se lo stesso file è già in Media Library come asset scollegato, lo si
  // collega invece di creare una riga gemella: un file, un asset.
  const reusable = await prisma.contentAsset.findFirst({
    where: { url: poster.url, contentId: null },
    select: { id: true },
  });
  if (reusable) {
    const linked = await linkAsset(reusable.id, content.id);
    await logAudit("VIDEO_POSTER_SET", "ContentAsset", linked.id, {
      contentId: content.id,
      source: poster.origin,
      reused: true,
    });
    return { ok: true, assetId: linked.id, created: true };
  }

  const created = await createAsset({
    url: poster.url,
    filename: poster.filename,
    kind: "IMAGE",
    contentId: content.id,
    metadata: {
      role: "POSTER",
      source: poster.origin,
      ...(poster.id ? { catalogImageId: poster.id } : {}),
    },
  });
  await logAudit("VIDEO_POSTER_SET", "ContentAsset", created.id, {
    contentId: content.id,
    source: poster.origin,
  });
  return { ok: true, assetId: created.id, created: true };
}
