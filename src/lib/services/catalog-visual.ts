/**
 * Materializzazione del visuale di una proposta del Catalogo.
 *
 * Questo servizio esiste per una garanzia di ordine: il DRAFT nasce solo dopo
 * che il file del visuale è già a terra. La sequenza è
 *
 *   1. proposta già risolta e direzione visual già calcolata (le riceve, non le rifà);
 *   2. riuso, se la stessa materializzazione è già a terra;
 *   3. ottenimento del file: download dell'originale del catalogo, oppure
 *      generazione con il provider immagini quando l'originale non esiste;
 *   4. transazione unica: `Content` DRAFT + `ContentAsset` collegato;
 *   5. se la transazione fallisce, il file appena ottenuto viene eliminato.
 *
 * Perché quell'ordine e non il contrario. L'alternativa naturale sarebbe
 * creare il DRAFT e poi allegare l'immagine: lascerebbe un contenuto in
 * Bozza senza visual quando l'operazione fallisce, cioè esattamente il DRAFT
 * incoerente che questo progetto vieta. Con il file prima, ogni errore lascia
 * il sistema com'era: nessun contenuto, nessun asset, nessun file.
 *
 * Il riuso sta prima di ottenere il file per la stessa ragione: scaricare o
 * generare per poi scartare il risultato lascerebbe un file che nessuno usa e
 * che nessuno sa di dover cancellare. L'identità del visuale è la coppia
 * proposta + sorgente, mai il nome del file locale.
 *
 * ## Le due fonti del visuale
 *
 *   - `officialImage` presente: si scarica l'originale dal sito dell'agenzia.
 *     Magnific non viene chiamato.
 *   - `officialImage` assente: si genera con il provider immagini. Il prompt
 *     non è mai ricostruito qui: arriva da `visualPromptFromDirection`, quindi
 *     resta ancorato alla proposta reale.
 *   - `officialImage` presente ma download rifiutato: errore. Non si genera al
 *     posto dell'originale, perché un host fuori allowlist o un MIME sbagliato
 *     sono problemi di configurazione o di fonte, non un invito a sostituire
 *     l'originale con un'immagine inventata. Quella resta una decisione
 *     separata, e va presa guardando il motivo del fallimento.
 *
 * Il servizio non sa nulla dell'agent e non chiama il modello: il prompt lo
 * riceve già costruito e validato. Nessuna modifica a Prisma: la provenienza
 * del visuale vive nel `metadata` JSON dell'asset, e il riuso si appoggia alla
 * colonna indicizzata `Content.catalogProposalId`.
 */

import type { ContentAsset, ContentStatus, ContentType, Platform, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { deleteUploadedFile, uploadedFileExists } from "@/lib/uploads";
import { downloadRemoteImage, type RemoteImage } from "@/lib/images/remote";
import { getImageProvider } from "@/lib/images/factory";
import type { GeneratedImage } from "@/lib/images/provider";
import { finishJob, recordJob } from "@/lib/ai/generate";
import { assertValidPlatforms } from "@/lib/services/content";
import type { CatalogProposalDto } from "@/lib/services/catalog-ai";
import {
  visualPromptFromDirection,
  type CatalogCopy,
  type ContentFormat,
  type VisualDirection,
} from "@/lib/ai/catalog-content";

/** Origine registrata nell'asset quando il file viene dal catalogo. */
export const CATALOG_VISUAL_ORIGIN = "catalog-official" as const;
/** "Provider" del visuale: chi ha prodotto il file è il sito dell'agenzia. */
export const CATALOG_VISUAL_PROVIDER = "catalog" as const;
/** Origine registrata nell'asset quando il file è stato generato. */
export const CATALOG_GENERATED_ORIGIN = "magnific" as const;

/**
 * Formato richiesto al provider per ogni formato editoriale.
 *
 * `square_1_1` è il default del progetto anche in `generateImage`, e per un post
 * social è la scelta che non sbaglia mai: si adatta a Instagram, Facebook e
 * LinkedIn senza ritagli. Le eccezioni sono quelle dove un formato diverso è
 * davvero più adatto, non un vezzo estetico.
 */
const ASPECT_RATIO_BY_FORMAT: Record<ContentFormat, string> = {
  // Il formato editoriale non dice quale piattaforma guarda il post, quindi non
  // c'è modo di giustificare un formato verticale: il quadrato resta la scorta
  // sicura per tutti i formati. Cambiarlo significa sapere dove va il post.
  HERO_DESTINATION: "square_1_1",
  ITINERARY: "square_1_1",
  TRAVEL_TIPS: "square_1_1",
  STORYTELLING: "square_1_1",
  OFFER: "square_1_1",
  INSPIRATION: "square_1_1",
  FAQ: "square_1_1",
};

/** Risoluzione di generazione: la stessa del default di `generateImage`. */
const CATALOG_VISUAL_RESOLUTION = "1k" as const;

/** Campi comuni a ogni provenienza di un visuale di catalogo. */
interface CatalogVisualCommon {
  catalogProposalId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Formato editoriale scelto dal flusso catalogo. */
  editorialFormat: ContentFormat;
  /** La direzione così com'era al momento della materializzazione. */
  visualDirection: VisualDirection;
}

/** Provenienza del visuale, serializzata nel `metadata` dell'asset. */
export interface CatalogVisualMetadata extends CatalogVisualCommon {
  origin: typeof CATALOG_VISUAL_ORIGIN;
  provider: typeof CATALOG_VISUAL_PROVIDER;
  sourceUrl: string;
  catalogProposalId: string;
  /** Presente solo se il DTO espone l'id della riga `CatalogImage`. */
  catalogImageId: string | null;
}

/** Provenienza del visuale quando il file è stato generato, non scaricato. */
export interface CatalogGeneratedVisualMetadata extends CatalogVisualCommon {
  origin: typeof CATALOG_GENERATED_ORIGIN;
  /** Il provider che ha prodotto il file, dal suo stesso nome. */
  provider: string;
  /**
   * L'URL del CDN da cui il provider ha scaricato il file, se lo ha
   * pubblicato. Non è la fonte del visuale: quella non esiste, il file è
   * stato creato. Per questo l'identità del ramo generato non usa `sourceUrl`.
   */
  sourceUrl: string | null;
  catalogProposalId: string;
  /** Sempre null: nessuna immagine del catalogo è coinvolta in questo ramo. */
  catalogImageId: null;
  /** Il prompt effettivamente inviato al provider. */
  prompt: string;
  aspectRatio: string;
  resolution: string;
}

/** Qualsiasi provenienza di un visuale di catalogo, discriminata da `origin`. */
export type AnyCatalogVisualMetadata = CatalogVisualMetadata | CatalogGeneratedVisualMetadata;

export interface MaterializeCatalogVisualInput {
  /** Proposta già risolta e verificata utilizzabile. */
  proposal: CatalogProposalDto;
  /** Direzione visual già calcolata con `buildVisualDirection`. */
  direction: VisualDirection;
  /** Copy già derivata dalla proposta: il servizio non accetta testo libero. */
  copy: CatalogCopy;
  platforms?: Platform[];
  type?: ContentType;
}

/** Perché la materializzazione non è avvenuta. */
export type CatalogVisualFailure =
  /**
   * Il DTO e la direzione sono in disaccordo: uno dice che c'è un'immagine
   * ufficiale, l'altro che non va usata. Qui non si sceglie da che parte stare.
   */
  | "no_official_image"
  /** Il download è stato rifiutato o è fallito. Nessun file lasciato. */
  | "download_failed"
  /** Il provider immagini non è in grado di generare (es. `manual`). */
  | "generation_unavailable"
  /** La generazione è stata tentata ed è fallita. Nessun file lasciato. */
  | "generation_failed"
  /** Il file c'era, ma la scrittura a database è fallita: il file è stato ripulito. */
  | "persist_failed";

export type MaterializeCatalogVisualResult =
  | {
      ok: true;
      /**
       * false: materializzazione appena eseguita, con un download o una
       * generazione e una transazione. true: la stessa materializzazione era
       * già a terra e nulla è stato creato.
       *
       * Il contratto resta un'unica forma di successo perché il chiamante non
       * deve distinguere due casi per ottenere il contenuto: quello che cambia
       * è se può ripetere la richiesta, e `reused` glielo dice.
       */
      reused: boolean;
      /**
       * Quale delle due fonti del visuale ha prodotto il file. Il chiamante ne
       * ha bisogno per spiegare all'utente cosa sta vedendo: l'originale
       * dell'agenzia o un'immagine generata non sono la stessa cosa, e
       * presentarli uguali sarebbe una bugia.
       */
      origin: CatalogVisualOrigin;
      /**
       * Il DRAFT appena creato. `status` è dichiarato come enum e non come
       * letterale perché è Prisma a produrlo: la verifica che valga `DRAFT` è
       * del test, non un'affermazione nel tipo.
       *
       * Nel ramo `reused` è il contenuto preesistente, che può essere
       * advanced: il tipo non promette `DRAFT` e il chiamante deve guardare
       * `status` prima di trattarlo come una bozza.
       */
      content: { id: string; title: string | null; status: ContentStatus };
      asset: ContentAsset;
      /**
       * Il file appena ottenuto. Vale `null` nel ramo `reused`: non è stato
       * prodotto niente, e inventare qui un oggetto somigliante sarebbe una
       * bugia.
       */
      image: RemoteImage | GeneratedImage | null;
      /**
       * La direzione della materializzazione. In `reused` è quella già
       * registrata, non quella passata adesso: se l'utente ne cambia, il
       * visuale a terra resta quello di prima e il servizio non finge il
       * contrario.
       */
      direction: VisualDirection;
      metadata: AnyCatalogVisualMetadata;
    }
  | {
      ok: false;
      reason: CatalogVisualFailure;
      /** Messaggio già pronto per il chiamante, senza segreti né URL interni. */
      message: string;
      /**
       * true quando la causa è l'assenza di un'immagine ufficiale, cioè quando
       * il chiamante potrebbe ancora provare a generare. False per un download
       * rifiutato: quel file esiste ed è autorizzato, sostituirlo con
       * un'immagine inventata non risolverebbe il problema che l'ha causato.
       */
      needsGeneration: boolean;
      /** La direzione torna indietro anche in caso di fallimento. */
      direction: VisualDirection;
      /** Codice di errore del downloader o del provider, per la diagnosi. */
      detail?: string;
    };

/** Le due fonti possibili del visuale, come const per il tipo del risultato. */
export type CatalogVisualOrigin = typeof CATALOG_VISUAL_ORIGIN | typeof CATALOG_GENERATED_ORIGIN;

/**
 * Un valore da mettere in `metadata` non ha un tipo JSON dichiarato.
 *
 * I metadata contengono la `VisualDirection`, che è un'interfaccia: TypeScript
 * non le assegna una firma implicita, quindi la conversione è dichiarata qui,
 * in un punto solo, e non sparsa nelle chiamate.
 */
function asInputJson(metadata: AnyCatalogVisualMetadata): Prisma.InputJsonValue {
  return metadata as unknown as Prisma.InputJsonValue;
}

/**
 * Che immagine del catalogo descrive questa materializzazione.
 *
 * È l'identità logica del visuale, non il file locale: `saveUploadedFile`
 * aggiunge timestamp e suffisso di unicità, quindi due scaricamenti della
 * stessa immagine hanno nomi diversi e il nome non distingue niente.
 */
/**
 * Che cosa distingue una materializzazione da un'altra.
 *
 * Sono due coppie diverse perché le due fonti del visuale non hanno la stessa
 * prova disponibile: l'originale ha un id di riga, il generato no.
 */
export type CatalogVisualIdentity =
  | {
      origin: typeof CATALOG_VISUAL_ORIGIN;
      catalogProposalId: string;
      catalogImageId: string | null;
      sourceUrl: string;
    }
  | {
      origin: typeof CATALOG_GENERATED_ORIGIN;
      catalogProposalId: string;
      /**
       * Il prompt è l'identità del ramo generato: è ciò che è stato chiesto al
       * provider, ed è derivato dalla direzione. Se la direzione non cambia, il
       * prompt non cambia e la generazione rifatta sarebbe la stessa immagine
       * pagata due volte.
       */
      prompt: string;
    };

/** Come il metadata è stato letto e giudicato durante il riuso. */
type ExistingVisual =
  | {
      found: true;
      content: { id: string; title: string | null; status: ContentStatus };
      asset: ContentAsset;
      metadata: AnyCatalogVisualMetadata;
    }
  | { found: false; reason: "none" | "metadata_incomplete" | "file_missing" };

/** I campi che ogni provenienza deve dichiarare per essere credibile. */
function hasCommonShape(m: Record<string, unknown>): boolean {
  return (
    typeof m.catalogProposalId === "string" &&
    !!m.catalogProposalId &&
    typeof m.filename === "string" &&
    typeof m.mimeType === "string" &&
    typeof m.size === "number" &&
    !!m.editorialFormat &&
    typeof m.visualDirection === "object" &&
    m.visualDirection !== null
  );
}

/**
 * Il metadata è un JSON non tipizzato: non ci si può fidare della sua forma.
 *
 * Si distinguono le due provenienza su `origin`, che è l'unico campo che il
 * chiamante può usare per capire cosa sta mostrando all'utente: se non è
 * riconoscibile, l'asset non viene riusato.
 */
function parseCatalogVisualMetadata(raw: unknown): AnyCatalogVisualMetadata | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!hasCommonShape(m)) return null;

  if (m.origin === CATALOG_VISUAL_ORIGIN) {
    if (typeof m.provider !== "string") return null;
    if (typeof m.sourceUrl !== "string" || !m.sourceUrl) return null;
    if (m.catalogImageId !== null && typeof m.catalogImageId !== "string") return null;
    return m as unknown as CatalogVisualMetadata;
  }
  if (m.origin === CATALOG_GENERATED_ORIGIN) {
    if (typeof m.provider !== "string" || !m.provider) return null;
    if (m.sourceUrl !== null && typeof m.sourceUrl !== "string") return null;
    // Il ramo generato non può dichiarare un'immagine del catalogo: se lo
    // facesse, la provenienza sarebbe contraddittoria e il riuso sbaglierebbe.
    if (m.catalogImageId !== null) return null;
    if (typeof m.prompt !== "string" || !m.prompt) return null;
    if (typeof m.aspectRatio !== "string" || !m.aspectRatio) return null;
    if (typeof m.resolution !== "string" || !m.resolution) return null;
    return m as unknown as CatalogGeneratedVisualMetadata;
  }
  return null;
}

/**
 * Due materializzazioni sono la stessa quando provengono dalla stessa proposta
 * E dalla stessa sorgente.
 *
 * Nel ramo ufficiale l'id della riga `CatalogImage` è la prova forte, e va
 * preferito quando c'è. Il confronto sull'URL resta per gli asset più vecchi,
 * scritti quando quell'id non era ancora disponibile: è più debole perché l'URL
 * del sito dell'agenzia può cambiare, ma è comunque più forte del nome locale.
 *
 * Nel ramo generato la prova è il prompt, non `sourceUrl`: l'URL del CDN non
 * identifica il visuale, ne è solo una copia ospitata da qualcun altro.
 */
function sameVisual(metadata: AnyCatalogVisualMetadata, identity: CatalogVisualIdentity): boolean {
  if (metadata.origin !== identity.origin) return false;
  if (metadata.catalogProposalId !== identity.catalogProposalId) return false;

  if (identity.origin === CATALOG_GENERATED_ORIGIN) {
    return (metadata as CatalogGeneratedVisualMetadata).prompt === identity.prompt;
  }
  const official = metadata as CatalogVisualMetadata;
  if (identity.catalogImageId && official.catalogImageId) {
    return official.catalogImageId === identity.catalogImageId;
  }
  return official.sourceUrl === identity.sourceUrl;
}

/**
 * Cerca una materializzazione già valida della stessa proposta/immagine.
 *
 * Il filtro su `catalogProposalId` è l'unica parte che va a database: è una
 * colonna indicizzata e il suo insieme è minuscolo (i contenuti nati da una
 * proposta, non tutto il database). Il confronto dell'immagine avviene in
 * memoria perché `metadata` è un JSON e SQLite non permette di filtrarlo per
 * chiave: interrogare tutto il database per poi scartare il 99% delle righe
 * sarebbe il modo costoso di ottenere la stessa risposta.
 *
 * "Valida" vuol dire tre cose insieme: l'asset c'è, è nato dal catalogo ed è
 * della stessa immagine, e il file è ancora a terra. Un asset senza file è
 * una riga viva che punta al nulla: riusarlo consegnerebbe un contenuto con
 * immagine rotta, mentre rifare il download è l'unica risposta onesta.
 */
async function findExistingVisual(identity: CatalogVisualIdentity): Promise<ExistingVisual> {
  const candidates = await prisma.contentAsset.findMany({
    where: {
      kind: "IMAGE",
      content: { catalogProposalId: identity.catalogProposalId },
    },
    orderBy: { createdAt: "asc" },
    include: { content: { select: { id: true, title: true, status: true } } },
  });

  let sawIncomplete = false;
  for (const asset of candidates) {
    // La relazione è opzionale nello schema: un asset senza contenuto non è
    // una materializzazione di niente, quindi non è riusabile.
    const content = asset.content;
    if (!asset.contentId || !content) continue;
    const metadata = parseCatalogVisualMetadata(asset.metadata);
    if (!metadata) {
      sawIncomplete = true;
      continue;
    }
    if (!sameVisual(metadata, identity)) continue;
    if (!(await uploadedFileExists(asset.url))) {
      // Riga e disco non vanno d'accordo: non è riusabile, ma nemmeno
      // distruttibile qui. Chi materializza di nuovo aggiornerà il contenuto.
      return { found: false, reason: "file_missing" };
    }
    return {
      found: true,
      content,
      asset: asset as ContentAsset,
      metadata,
    };
  }

  return { found: false, reason: sawIncomplete ? "metadata_incomplete" : "none" };
}

/**
 * Genera il visuale di una proposta che non ha immagine ufficiale.
 *
 * Il prompt non viene costruito qui: arriva da `visualPromptFromDirection`,
 * cioè dalla stessa funzione che il ramo ufficiale userebbe per descrivere
 * l'originale. Ricostruirlo qui, a partire da caption o hashtag, sarebbe il
 * modo più rapido di far dire al generatore cose che la proposta non dice.
 *
 * Il provider si ottiene dalla factory, come in tutto il resto dell'app: qui
 * non si sceglie un'implementazione, si chiede "chi genera le immagini adesso".
 * Il polling e il download li fa il provider, non questo modulo.
 */
async function generateVisual(args: {
  prompt: string;
  proposal: CatalogProposalDto;
  direction: VisualDirection;
}): Promise<
  | { ok: true; image: GeneratedImage; metadata: CatalogGeneratedVisualMetadata; jobId: string }
  | { ok: false; failure: Extract<MaterializeCatalogVisualResult, { ok: false }> }
> {
  const { prompt, proposal, direction } = args;
  const aspectRatio = ASPECT_RATIO_BY_FORMAT[direction.format] ?? "square_1_1";

  let provider;
  try {
    provider = getImageProvider();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAIError("catalog-visual.provider", { proposalId: proposal.id }, e);
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "generation_unavailable",
        needsGeneration: true,
        direction,
        detail: "provider_unavailable",
        message: `Generatore immagini non disponibile: nessun contenuto è stato creato. ${message}`,
      },
    };
  }

  if (!provider.canGenerate) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "generation_unavailable",
        needsGeneration: true,
        direction,
        detail: `provider:${provider.name}`,
        message:
          `La proposta "${proposal.name}" non ha immagine nel catalogo e il provider immagini ` +
          `("${provider.name}") non sa generare: nessun contenuto è stato creato.`,
      },
    };
  }

  // Il job nasce solo ora, quando si sa che una generazione sta davvero
  // per partire: un job per una generazione che non avviene sarebbe una bugia
  // nella cronologia, e un riuso non deve produrre job nuovi.
  const job = await recordJob("IMAGE", {
    contentId: null,
    prompt,
    aspectRatio,
    resolution: CATALOG_VISUAL_RESOLUTION,
    catalogProposalId: proposal.id,
    editorialFormat: direction.format,
  });

  let image: GeneratedImage;
  try {
    image = await provider.generateImage(prompt, {
      aspectRatio,
      resolution: CATALOG_VISUAL_RESOLUTION,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAIError("catalog-visual.generate", { proposalId: proposal.id, jobId: job.id }, e);
    await finishJob(job.id, false, undefined, message);
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "generation_failed",
        needsGeneration: true,
        direction,
        detail: `provider:${provider.name}`,
        message:
          `Generazione del visuale fallita per la proposta "${proposal.name}" ` +
          `con "${provider.name}": nessun contenuto è stato creato. ${message}`,
      },
    };
  }

  // Un provider che risponde con un URL ma non scrive nulla lascerebbe un
  // DRAFT con immagine rotta: è la stessa incoerenza che il ramo ufficiale
  // evita scrivendo il file prima. Il costo è una `stat` e vale la verifica.
  if (!(await uploadedFileExists(image.url))) {
    logAIError(
      "catalog-visual.generate",
      { proposalId: proposal.id, jobId: job.id, url: image.url },
      new Error("il provider ha dichiarato un file che non esiste")
    );
    await finishJob(job.id, false, undefined, `File generato assente: ${image.url}`);
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "generation_failed",
        needsGeneration: true,
        direction,
        detail: "file_missing",
        message:
          `Il provider immagini ha dichiarato generato il visuale della proposta ` +
          `"${proposal.name}" ma il file non è a terra: nessun contenuto è stato creato.`,
      },
    };
  }

  const filename = image.url.split("/").pop() ?? "magnific-image.png";
  return {
    ok: true,
    jobId: job.id,
    image,
    metadata: {
      origin: CATALOG_GENERATED_ORIGIN,
      provider: image.provider || provider.name,
      // Non è una sorgente: il file è stato creato, non copiato da un URL del
      // sito dell'agenzia. Resta null perché l'asset non pretende una provenienza
      // che non ha.
      sourceUrl: image.sourceUrl ?? null,
      catalogProposalId: proposal.id,
      catalogImageId: null,
      filename,
      mimeType: image.mimeType ?? "image/png",
      size: image.size ?? 0,
      editorialFormat: direction.format,
      visualDirection: direction,
      prompt,
      aspectRatio,
      resolution: CATALOG_VISUAL_RESOLUTION,
    },
  };
}

/**
 * Materializza il visuale della proposta: originale del catalogo se esiste,
 * generato dal provider immagini altrimenti.
 *
 * Idempotente sulla coppia proposta + sorgente del visuale: ripetere la
 * richiesta per la stessa coppia restituisce ciò che esiste già, senza
 * riscaricare, rigenerare, riscrivere o creare file. Non è una deduplicazione
 * di intenti: se il chiamante vuole davvero due post uguali, non può
 * ottenerli da qui, e dovrà chiederlo esplicitamente in uno step successivo.
 *
 * Non solleva eccezioni per i casi previsti: ogni fallimento torna come
 * risultato tipizzato, perché il chiamante deve poter trasformarlo in un
 * messaggio per l'utente e non in uno stack trace. Un'eccezione sarebbe
 * comunque un bug (per esempio una transazione che non si chiude), non un
 * esito atteso.
 */
export async function materializeCatalogVisual(
  input: MaterializeCatalogVisualInput
): Promise<MaterializeCatalogVisualResult> {
  const { proposal, direction, copy } = input;
  const official = proposal.officialImage;

  // Le due fonti di verità devono concordare. Se il DTO ha un'immagine ma la
  // direzione dice che non va usata, non si decide qui quale delle due abbia
  // ragione: non si materializza nulla e si rimanda al chiamante, che è l'unico
  // posto dove si può sapere se l'originale è stato scelto o escluso per
  // sbaglio. `needsGeneration` resta true perché al chiamante la domanda da
  // porsi è proprio "genero o risolvo il disaccordo?".
  if (official && !direction.useOfficialImage) {
    return {
      ok: false,
      reason: "no_official_image",
      needsGeneration: true,
      direction,
      message:
        `La proposta "${proposal.name}" ha un'immagine ufficiale nel catalogo ma la direzione ` +
        "visual non la usa: non viene creato alcun contenuto finché i due dati non concordano.",
    };
  }

  const generate = official === null;

  // 1) riuso: questa stessa materializzazione è già a terra? Allora non si
  //    scarica, non si genera, non si scrive, non si duplica niente.
  //
  //    Il controllo sta prima di ottenere il file per una ragione che non è
  //    solo di efficienza: scaricare o generare per poi scartare il risultato
  //    lascerebbe un file che nessuno usa e che nessuno sa di dover cancellare.
  //    Nel ramo generato il prompt è calcolato qui, una volta sola, e serve sia
  //    all'identità sia alla generazione: ricalcolarlo dopo il rischio di un
  //    lookup aprirebbe la porta a una coppia di prompt diversi.
  const prompt = generate ? visualPromptFromDirection(direction) : "";
  const identity: CatalogVisualIdentity = generate
    ? { origin: CATALOG_GENERATED_ORIGIN, catalogProposalId: proposal.id, prompt }
    : {
        origin: CATALOG_VISUAL_ORIGIN,
        catalogProposalId: proposal.id,
        catalogImageId: official.id ?? null,
        sourceUrl: official.url,
      };
  const existing = await findExistingVisual(identity);
  if (existing.found) {
    return {
      ok: true,
      reused: true,
      origin: identity.origin,
      content: existing.content,
      asset: existing.asset,
      image: null,
      direction: existing.metadata.visualDirection,
      metadata: existing.metadata,
    };
  }

  // 2) ottenere il file: prima di qualsiasi scrittura a database.
  let image: RemoteImage | GeneratedImage;
  let metadata: AnyCatalogVisualMetadata;
  /** Presente solo nel ramo generato: serve a chiudere il job anche in errore. */
  let jobId: string | null = null;

  if (generate) {
    const outcome = await generateVisual({ prompt, proposal, direction });
    if (!outcome.ok) return outcome.failure;
    image = outcome.image;
    metadata = outcome.metadata;
    jobId = outcome.jobId;
  } else {
    let downloaded: RemoteImage;
    try {
      downloaded = await downloadRemoteImage({
        url: official.url,
        // L'unica allowlist ammessa è il dominio della fonte già in catalogo.
        allowedDomains: [proposal.source.domain],
        originalName: official.filename,
      });
    } catch (e) {
      const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "unknown";
      logAIError("catalog-visual.download", { proposalId: proposal.id, code }, e);
      return {
        ok: false,
        reason: "download_failed",
        // Un download rifiutato non diventa "generiamo un'immagine": l'originale
        // esiste ed è autorizzato, sostituirlo nasconderebbe la configurazione
        // rotta invece di segnalarla.
        needsGeneration: false,
        direction,
        detail: code,
        message:
          `Impossibile scaricare l'immagine ufficiale della proposta "${proposal.name}" ` +
          `dal catalogo (${code}): non viene creato alcun contenuto.`,
      };
    }
    image = downloaded;
    metadata = {
      origin: CATALOG_VISUAL_ORIGIN,
      provider: CATALOG_VISUAL_PROVIDER,
      sourceUrl: downloaded.sourceUrl,
      catalogProposalId: proposal.id,
      catalogImageId: official.id ?? null,
      filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      size: downloaded.size,
      editorialFormat: direction.format,
      visualDirection: direction,
    };
  }

  // 3) scrittura: Content e ContentAsset nella stessa transazione, così non
  //    esiste mai un DRAFT senza visual o un asset orfano.
  try {
    const platforms = assertValidPlatforms(input.platforms);
    const type = input.type ?? "POST";

    const { content, asset } = await prisma.$transaction(
      async (tx) => {
        const created = await tx.content.create({
          data: {
            type,
            title: copy.title,
            caption: copy.caption,
            hashtags: copy.hashtags || null,
            status: "DRAFT",
            catalogProposalId: proposal.id,
            platforms: {
              create: platforms.map((p) => ({ platform: p, accountId: null })),
            },
          },
          select: { id: true, title: true, status: true },
        });

        const createdAsset = await tx.contentAsset.create({
          // `filename`, `mimeType` e `size` arrivano dai metadata già
          // normalizzati: il provider può ometterli, e la colonna no.
          data: {
            kind: "IMAGE",
            contentId: created.id,
            url: image.url,
            filename: metadata.filename,
            mimeType: metadata.mimeType,
            size: metadata.size,
            metadata: asInputJson(metadata),
          },
          select: {
            id: true,
            kind: true,
            contentId: true,
            url: true,
            filename: true,
            mimeType: true,
            size: true,
            metadata: true,
            createdAt: true,
          },
        });

        return { content: created, asset: createdAsset };
      },
      { timeout: 15_000 }
    );

    // L'audit sta fuori dalla transazione di proposito: nessun CONTENT_CREATED
    // senza l'asset che lo rende pubblicabile.
    await logAudit("CONTENT_CREATED", "Content", content.id, {
      status: content.status,
      title: content.title,
      catalogProposalId: proposal.id,
      visualOrigin: identity.origin,
    });
    await logAudit("ASSET_CREATED", "ContentAsset", asset.id, {
      filename: asset.filename,
      kind: asset.kind,
      contentId: asset.contentId,
      origin: identity.origin,
    });

    // Il job IMAGE si chiude qui: la generazione è avvenuta ed è stata salvata.
    if (jobId) {
      await finishJob(jobId, true, { url: image.url, assetId: asset.id, contentId: content.id });
    }

    return {
      ok: true,
      reused: false,
      origin: identity.origin,
      content,
      asset: asset as ContentAsset,
      image,
      direction,
      metadata,
    };
  } catch (e) {
    // 4) il rollback ha già annullato Content e ContentAsset: qui si ripulisce
    //    solo il file, che la transazione non può toccare.
    logAIError("catalog-visual.persist", { proposalId: proposal.id, url: image.url }, e);
    const removed = await deleteUploadedFile(image.url).catch((cleanupError: unknown) => {
      logAIError("catalog-visual.cleanup", { proposalId: proposal.id, url: image.url }, cleanupError);
      return false;
    });

    // La generazione è avvenuta e il suo file è sparito: il job non deve
    // risultare riuscito, altrimenti resterebbe la traccia di un'immagine che
    // nessuno può più usare.
    if (jobId) {
      await finishJob(jobId, false, undefined, `Salvataggio non riuscito: ${image.url} rimosso`);
    }

    return {
      ok: false,
      reason: "persist_failed",
      needsGeneration: false,
      direction,
      detail: removed ? "file_removed" : "file_cleanup_failed",
      message:
        `Salvataggio non riuscito per la proposta "${proposal.name}": ` +
        "nessun contenuto è stato creato.",
    };
  }
}
