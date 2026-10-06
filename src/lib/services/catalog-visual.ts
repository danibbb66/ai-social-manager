/**
 * Materializzazione del visuale di una proposta del Catalogo.
 *
 * Questo servizio esiste per una garanzia di ordine: il DRAFT nasce solo dopo
 * che il file del visuale è già a terra. La sequenza è
 *
 *   1. proposta già risolta e direzione visual già calcolata (le riceve, non le rifà);
 *   2. riuso, se la stessa materializzazione è già a terra;
 *   3. la fotografia del provider immagini, sul tema della destinazione;
 *   4. l'originale del catalogo scaricato come **provenienza**, quando esiste;
 *   5. la composizione del fotogramma con il template dell'agenzia;
 *   6. transazione unica: `Content` DRAFT + `ContentAsset` collegato;
 *   7. se la transazione fallisce, ogni file appena ottenuto viene eliminato.
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
 * proposta + prompt, mai il nome del file locale.
 *
 * ## Il visuale non è l'immagine del catalogo
 *
 * L'immagine ufficiale di una proposta è una locandina promozionale: contiene
 * il logo e la grafica del fornitore che ha costruito l'offerta. Allegarla al
 * DRAFT la farebbe diventare l'immagine del post, cioè un post dell'agenzia con
 * dentro il marchio di un altro, e per di più con un layout pensato per una
 * locandina e non per un quadrato social.
 *
 * Quindi l'originale non è mai il visuale e non viene neppure ritagliato: si
 * usa la sua provenienza (da quale proposta, da quale pagina, da quale
 * immagine) e si lascia in Media Library con `contentId` nullo e il ruolo di
 * fonte. Il visuale nasce da una fotografia generata sul tema della
 * destinazione, con il template dell'agenzia sopra, il suo marchio in alto a
 * destra e i dati dell'offerta in basso. `offer-creative` è il proprietario di
 * quelle scelte; qui ci sono solo l'orchestrazione, la provenienza e la scrittura.
 *
 * Il servizio non sa nulla dell'agent e non chiama il modello. Nessuna
 * modifica a Prisma: la provenienza del visuale vive nel `metadata` JSON
 * dell'asset, e il riuso si appoggia alla colonna indicizzata
 * `Content.catalogProposalId`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ContentAsset, ContentStatus, ContentType, Platform, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { deleteUploadedFile, uploadedFileExists } from "@/lib/uploads";
import { downloadRemoteImage, type RemoteImage } from "@/lib/images/remote";
import { getImageProvider } from "@/lib/images/factory";
import type { GeneratedImage } from "@/lib/images/provider";
import { finishJob, recordJob } from "@/lib/ai/generate";
import { getBrandMark } from "@/lib/services/brand";
import { assertValidPlatforms } from "@/lib/services/content";
import type { CatalogProposalDto } from "@/lib/services/catalog-ai";
import type { ContentFormat, VisualDirection } from "@/lib/ai/catalog-content";
import type { KnowledgeSource } from "@/lib/ai/travel-knowledge";
import { extractCommercial, type CommercialExtraction } from "@/lib/catalog/commercial-extraction";
import {
  composeOfferCreative,
  offerPhotoPrompt,
  photoDirectionFrom,
  printedTitleFrom,
  OFFER_CREATIVE_TEMPLATE,
  OFFER_PHOTO_ASPECT_RATIO,
  OFFER_PHOTO_RESOLUTION,
  OFFER_SOURCE_ORIGIN,
  OFFER_SOURCE_ROLE,
} from "@/lib/services/offer-creative";

/**
 * Origine registrata sull'asset che è il visuale del post.
 *
 * Distinta da quella dell'originale del fornitore perché i due file hanno
 * ruoli opposti: questo è il visuale, pubblicabile; quello è la provenienza,
 * tenuta fuori dal contenuto. Confonderli sarebbe lo stesso errore che
 * allegare la locandina al post.
 */
export const CATALOG_CREATIVE_ORIGIN = "catalog-social-creative" as const;

/** "Provider" del visuale: chi ha prodotto il fotogramma, e con quale base. */
export const CATALOG_CREATIVE_PROVIDER = "catalog-social-creative" as const;

/** Campi comuni a ogni provenienza di un visuale di catalogo. */
interface CatalogCreativeCommon {
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
export interface CatalogCreativeMetadata extends CatalogCreativeCommon {
  origin: typeof CATALOG_CREATIVE_ORIGIN;
  provider: typeof CATALOG_CREATIVE_PROVIDER;
  /** Il layout applicato al fotogramma. */
  template: typeof OFFER_CREATIVE_TEMPLATE;
  /**
   * L'originale del catalogo da cui derivano i dati dell'offerta.
   *
   * `localAssetId` è nullo quando la locandina non è stata scaricata: la
   * provenienza remota c'è comunque, perché la riga `CatalogImage` la
   * conserva e l'URL è ciò che rende l'offerta riconoscibile.
   */
  source: {
    catalogImageId: string | null;
    url: string | null;
    filename: string | null;
    localAssetId: string | null;
  };
  /** La fotografia generata che sta sotto al template. */
  generatedPhoto: {
    url: string;
    provider: string;
    prompt: string;
    aspectRatio: string;
    resolution: string;
  };
  /** Come sono arrivati i dati commerciali e quanto valgono. */
  extractionMethod: CommercialExtraction["extractionMethod"];
  commercialFields: CommercialExtraction["extractedFields"];
  commercialConfidence: CommercialExtraction["confidence"];
  commercialWarnings: CommercialExtraction["warnings"];
  /** Le righe commerciali realmente stampate sul fotogramma. */
  commercialLines: string[];
  /**
   * I punti stampati dentro la card: consigli o tappe.
   *
   * Vuoto per i formati che non li stampano. Dichiarato perché la presenza dei
   * punti cambia il fotogramma e la sua altezza, e un post di consigli senza
   * consigli stampati sarebbe un post che non mantiene la promessa del titolo.
   */
  printedPoints: string[];
  /**
   * Da dove viene il contenuto dei punti stampati.
   *
   * `curated` = fatti reali sulla destinazione; `derived` = costruito sui dati
   * del catalogo e sulla struttura del viaggio. Serve al team per capire quanto
   * il post sia affidabile quando non ha un dato di fornitore.
   */
  knowledgeSource: KnowledgeSource;
  /** Il titolo stampato: il nome pulito del luogo. */
  printedTitle: string;
  /** Il marchio dell'agenzia stampato: logo file, wordmark, o nessuno. */
  brandMark: "logo" | "wordmark" | null;
  width: number;
  height: number;
}

/** L'unica provenienza che esiste: la creatività composta. */
export type AnyCatalogVisualMetadata = CatalogCreativeMetadata;

export interface MaterializeCatalogVisualInput {
  /** Proposta già risolta e verificata utilizzabile. */
  proposal: CatalogProposalDto;
  /** Direzione visual già calcolata con `buildVisualDirection`. */
  direction: VisualDirection;
  /** Copy già derivata dalla proposta: il servizio non accetta testo libero. */
  copy: {
    title: string;
    caption: string;
    hashtags: string;
    /** Consigli o tappe da stampare dentro la card; vuoto se il formato non ne ha. */
    points?: readonly string[] | null;
    /** Provenienza del contenuto dei punti, per i metadata dell'asset. */
    knowledgeSource?: KnowledgeSource;
  };
  platforms?: Platform[];
  type?: ContentType;
  /**
   * true quando il chiamante ha fissato la proposta per id (`catalogProposalId`):
   * la richiesta è esatta e un DRAFT preesistente della stessa proposta è la sua
   * ripetizione idempotente, dichiarata in `reused`.
   *
   * false quando la proposta è stata risolta per destinazione: il DRAFT
   * preesistente viene restituito comunque (nessun duplicato, il contratto di
   * idempotenza resta valido), ma non è un riuso tra destinazioni diverse e
   * `reused` resta false.
   *
   * Assente: vale come true, perché la ripetizione di una richiesta esatta è
   * il contratto base del servizio.
   */
  pinnedById?: boolean;
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
  /** La proposta non ha un nome di luogo da stampare: niente fotogramma. */
  | "place_missing"
  /** La composizione è fallita. Nessun file lasciato. */
  | "render_failed"
  /** Il file c'era, ma la scrittura a database è fallita: il file è stato ripulito. */
  | "persist_failed";

export type MaterializeCatalogVisualResult =
  | {
      ok: true;
      /**
       * true: la stessa materializzazione era già a terra e nulla è stato
       * creato, e il chiamante aveva fissato la proposta per id: è una
       * ripetizione idempotente della stessa richiesta esatta.
       *
       * false: materializzazione appena eseguita, con una generazione e una
       * transazione; oppure DRAFT preesistente restituito senza duplicarlo, ma
       * con la proposta risolta per destinazione: in quel caso il DRAFT è
       * quello della destinazione richiesta, non il riuso di un'altra.
       *
       * Il contratto resta un'unica forma di successo perché il chiamante non
       * deve distinguere due casi per ottenere il contenuto: quello che cambia
       * è se può ripetere la richiesta, e `reused` glielo dice.
       */
      reused: boolean;
      /** La provenienza del file che è il visuale. */
      origin: typeof CATALOG_CREATIVE_ORIGIN;
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
      image: GeneratedImage | null;
      /**
       * L'originale del catalogo scaricato come provenienza, o `null` se la
       * proposta non ne ha. Vive in Media Library, fuori dagli asset del
       * contenuto: non è e non diventerà il visuale del post.
       */
      sourceAsset: ContentAsset | null;
      /** I dati dell'offerta, come sono stati stampati. */
      extraction: CommercialExtraction;
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
       * true quando la causa non è il file in sé, quindi il chiamante potrebbe
       * ancora riprovare. False per un download rifiutato: quel file esiste ed
       * è autorizzato, e sostituirlo nasconderebbe la configurazione rotta
       * invece di segnalarla.
       */
      needsGeneration: boolean;
      /** La direzione torna indietro anche in caso di fallimento. */
      direction: VisualDirection;
      /** I dati dell'offerta, quando sono stati calcolati. */
      extraction: CommercialExtraction | null;
      /** Codice di errore del downloader o del provider, per la diagnosi. */
      detail?: string;
    };

/** La provenienza del visuale: una sola, dichiarata come costante. */
export type CatalogVisualOrigin = typeof CATALOG_CREATIVE_ORIGIN;

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
 * Che cosa distingue una materializzazione da un'altra.
 *
 * La coppia (proposita, prompt fotografico): il prompt è l'identità del ramo
 * generato perché è ciò che è stato chiesto al provider, ed è derivato dalla
 * direzione. Se la direzione non cambia, il prompt non cambia e rifare la
 * fotografia sarebbe la stessa immagine pagata due volte.
 */
export interface CatalogVisualIdentity {
  catalogProposalId: string;
  prompt: string;
}

/** Come il metadata è stato letto e giudicato durante il riuso. */
type ExistingVisual =
  | {
      found: true;
      content: { id: string; title: string | null; status: ContentStatus };
      asset: ContentAsset;
      metadata: AnyCatalogVisualMetadata;
    }
  | { found: false; reason: "none" | "metadata_incomplete" | "file_missing" };

/** I campi che la provenienza deve dichiarare per essere credibile. */
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
 * Si riconosce l'origine, che è l'unico campo che il chiamante può usare per
 * capire cosa sta mostrando all'utente: se non è riconoscibile, l'asset non
 * viene riusato. In particolare un asset con un'origine sconosciuta non è un
 * visuale di questo servizio, e non viene trattato come se lo fosse.
 */
function parseCatalogVisualMetadata(raw: unknown): AnyCatalogVisualMetadata | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!hasCommonShape(m)) return null;

  if (m.origin !== CATALOG_CREATIVE_ORIGIN) return null;
  if (m.provider !== CATALOG_CREATIVE_PROVIDER) return null;
  if (typeof m.template !== "string" || !m.template) return null;
  if (typeof m.printedTitle !== "string" || !m.printedTitle) return null;
  if (typeof m.source !== "object" || m.source === null) return null;
  if (typeof m.generatedPhoto !== "object" || m.generatedPhoto === null) return null;
  const photo = m.generatedPhoto as Record<string, unknown>;
  if (typeof photo.url !== "string" || !photo.url) return null;
  if (typeof photo.prompt !== "string" || !photo.prompt) return null;
  if (typeof photo.aspectRatio !== "string" || !photo.aspectRatio) return null;
  if (typeof photo.resolution !== "string" || !photo.resolution) return null;
  return m as unknown as CatalogCreativeMetadata;
}

/** Due materializzazioni sono la stessa quando nascono dalla stessa foto richiesta. */
function sameVisual(metadata: AnyCatalogVisualMetadata, identity: CatalogVisualIdentity): boolean {
  if (metadata.catalogProposalId !== identity.catalogProposalId) return false;
  return metadata.generatedPhoto.prompt === identity.prompt;
}

/**
 * Cerca una materializzazione già valida della stessa proposta.
 *
 * Il filtro su `catalogProposalId` è l'unica parte che va a database: è una
 * colonna indicizzata e il suo insieme è minuscolo (i contenuti nati da una
 * proposta, non tutto il database). Il resto avviene in memoria perché i
 * metadata sono un JSON e SQLite non permette di filtrarli per chiave:
 * interrogare tutto il database per poi scartare il 99% delle righe sarebbe il
 * modo costoso di ottenere la stessa risposta.
 *
 * "Valida" vuol dire tre cose insieme: l'asset c'è, è nato da qui ed è della
 * stessa fotografia, e il file è ancora a terra. Un asset senza file è una riga
 * viva che punta al nulla: riusarlo consegnerebbe un contenuto con immagine
 * rotta, mentre rifare la foto è l'unica risposta onesta.
 */
async function findExistingVisual(identity: CatalogVisualIdentity): Promise<ExistingVisual> {
  const candidates = await prisma.contentAsset.findMany({
    where: {
      kind: "IMAGE",
      content: { catalogProposalId: identity.catalogProposalId, status: "DRAFT" },
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
 * Genera la fotografia su cui sarà composto il fotogramma.
 *
 * Il prompt non viene ricostruito qui: arriva già costruito da `offer-creative`
 * e dice solo che fotografia si vuole, senza dati commerciali e senza riferimenti
 * all'originale del catalogo. Ricostruirlo qui, a partire da caption o hashtag,
 * sarebbe il modo più rapido di far dire al generatore cose che la proposta non
 * dice.
 *
 * Il provider si ottiene dalla factory, come in tutto il resto dell'app: qui
 * non si sceglie un'implementazione, si chiede "chi genera le immagini adesso".
 * Il polling e il download li fa il provider, non questo modulo.
 */
async function generatePhoto(args: {
  prompt: string;
  proposal: CatalogProposalDto;
  direction: VisualDirection;
}): Promise<
  | { ok: true; image: GeneratedImage; jobId: string }
  | { ok: false; failure: Extract<MaterializeCatalogVisualResult, { ok: false }> }
> {
  const { prompt, proposal, direction } = args;

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
        extraction: null,
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
        extraction: null,
        detail: `provider:${provider.name}`,
        message:
          `Il provider immagini "${provider.name}" non sa generare: nessun contenuto è stato creato. ` +
          "La fotografia è l'unica base del visuale, quindi senza provider non c'è post.",
      },
    };
  }

  // Il job nasce solo ora, quando si sa che una generazione sta davvero
  // per partire: un job per una generazione che non avviene sarebbe una bugia
  // nella cronologia, e un riuso non deve produrre job nuovi.
  const job = await recordJob("IMAGE", {
    contentId: null,
    prompt,
    aspectRatio: OFFER_PHOTO_ASPECT_RATIO,
    resolution: OFFER_PHOTO_RESOLUTION,
    catalogProposalId: proposal.id,
    editorialFormat: direction.format,
  });

  let image: GeneratedImage;
  try {
    image = await provider.generateImage(prompt, {
      aspectRatio: OFFER_PHOTO_ASPECT_RATIO,
      resolution: OFFER_PHOTO_RESOLUTION,
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
        extraction: null,
        detail: `provider:${provider.name}`,
        message:
          `Generazione della fotografia fallita per la proposta "${proposal.name}" ` +
          `con "${provider.name}": nessun contenuto è stato creato. ${message}`,
      },
    };
  }

  // Un provider che risponde con un URL ma non scrive nulla lascerebbe un
  // DRAFT con immagine rotta: è la stessa incoerenza che il rollback evita
  // scrivendo il file prima. Il costo è una `stat` e vale la verifica.
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
        extraction: null,
        detail: "file_missing",
        message:
          `Il provider immagini ha dichiarato generato la fotografia della proposta ` +
          `"${proposal.name}" ma il file non è a terra: nessun contenuto è stato creato.`,
      },
    };
  }

  return { ok: true, jobId: job.id, image };
}

/**
 * Materializza il visuale della proposta: una fotografia nuova, composta con il
 * template dell'agenzia.
 *
 * Idempotente sulla coppia proposta + prompt fotografico: ripetere la richiesta
 * per la stessa coppia restituisce ciò che esiste già, senza riscaricare,
 * rigenerare, riscrivere o creare file. Non è una deduplicazione di intenti: se
 * il chiamante vuole davvero due post uguali, non può ottenerli da qui, e dovrà
 * chiederlo esplicitamente in uno step successivo.
 *
 * Non solleva eccezioni per i casi previsti: ogni fallimento torna come
 * risultato tipizzato, perché il chiamante deve poterlo trasformare in un
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
  // porsi è proprio "il catalogo e la direzione sono d'accordo?".
  if (official && !direction.useOfficialImage) {
    return {
      ok: false,
      reason: "no_official_image",
      needsGeneration: true,
      direction,
      extraction: null,
      message:
        `La proposta "${proposal.name}" ha un'immagine ufficiale nel catalogo ma la direzione ` +
        "visual non la usa: non viene creato alcun contenuto finché i due dati non concordano.",
    };
  }

  // I dati dell'offerta si calcolano una volta sola e girano in giro: sono ciò
  // che il fotogramma stampa e ciò che il chiamante riceve. Un campo che la
  // fonte non ha resta `null` e non viene stampato: un prezzo o una data
  // inventati su un'immagine social sono indistinguibili da quelli veri.
  const extraction = extractCommercial(proposal);

  // Il prompt fotografico è deterministico e non contiene dati commerciali né
  // riferimenti all'originale: è la fotografia della destinazione, non un
  // adattamento della locandina.
  const photoPrompt = offerPhotoPrompt(photoDirectionFrom(direction));
  const identity: CatalogVisualIdentity = { catalogProposalId: proposal.id, prompt: photoPrompt };

  // 1) riuso: questa stessa materializzazione è già a terra? Allora non si
  //    scarica, non si genera, non si scrive, non si duplica niente.
  const existing = await findExistingVisual(identity);
  if (existing.found) {
    return {
      ok: true,
      // Il DRAFT torna sempre, anche risolto per destinazione: due richieste per
      // la stessa proposta non devono produrre due bozze. Ma `reused` è la
      // dichiarazione di ripetizione idempotente, e solo chi ha fissato la
      // proposta per id sta ripetendo una richiesta esatta: chi ha chiesto per
      // destinazione riceve il DRAFT di quella destinazione, non il riuso di
      // un'altra.
      reused: input.pinnedById !== false,
      origin: CATALOG_CREATIVE_ORIGIN,
      content: existing.content,
      asset: existing.asset,
      image: null,
      // La fonte non viene riletta nel riuso: nel ramo riusato nessun file è
      // stato prodotto, quindi dichiararne uno sarebbe inventare.
      sourceAsset: null,
      extraction,
      direction: existing.metadata.visualDirection,
      metadata: existing.metadata,
    };
  }

  // 2) la fotografia: senza provider non c'è post, quindi è un fallimento
  //    dichiarato e non un post senza visuale.
  const generated = await generatePhoto({ prompt: photoPrompt, proposal, direction });
  if (!generated.ok) return generated.failure;
  const photo = generated.image;
  const jobId = generated.jobId;

  // 3) l'originale del catalogo, solo come provenienza. Non è il visuale e non
  //    verrà ritagliato: entra in Media Library con `contentId` nullo, e serve a
  //    sapere da quale immagine del catalogo sono tratti i dati dell'offerta.
  //    Un download rifiutato è un problema di configurazione o di fonte, non un
  //    invito a procedere senza sapere da dove arrivano i dati.
  let source: RemoteImage | null = null;
  if (official) {
    try {
      source = await downloadRemoteImage({
        url: official.url,
        // L'unica allowlist ammessa è il dominio della fonte già in catalogo.
        allowedDomains: [proposal.source.domain],
        originalName: official.filename,
      });
    } catch (e) {
      const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "unknown";
      logAIError("catalog-visual.download", { proposalId: proposal.id, code }, e);
      await deleteUploadedFile(photo.url).catch(() => undefined);
      await finishJob(jobId, false, undefined, `Locandina non scaricata (${code})`);
      return {
        ok: false,
        reason: "download_failed",
        // Un download rifiutato non diventa "generiamo un'immagine": quel file
        // esiste ed è autorizzato, sostituirlo nasconderebbe la configurazione
        // rotta invece di segnalarla.
        needsGeneration: false,
        direction,
        extraction,
        detail: code,
        message:
          `Impossibile scaricare l'immagine ufficiale della proposta "${proposal.name}" ` +
          `dal catalogo (${code}): non viene creato alcun contenuto.`,
      };
    }
  }

  // 4) composizione: il titolo è il nome pulito del luogo e i dati sono quelli
  //    dell'offerta. Un luogo non utilizzabile è un fallimento esplicito, non
  //    un fotogramma con un titolo inventato.
  const printedTitle = printedTitleFrom(extraction);
  if (!printedTitle) {
    await finishJob(jobId, false, undefined, "Luogo non utilizzabile per il titolo del visuale");
    await deleteUploadedFile(photo.url).catch(() => undefined);
    if (source) await deleteUploadedFile(source.url).catch(() => undefined);
    return {
      ok: false,
      reason: "place_missing",
      needsGeneration: false,
      direction,
      extraction,
      detail: "place_missing",
      message:
        `La proposta "${proposal.name}" non ha un nome di luogo utilizzabile per il visuale: ` +
        "non viene creato alcun contenuto.",
    };
  }

  let composed: Awaited<ReturnType<typeof composeOfferCreative>>;
  try {
    const photoBuffer = await fs.readFile(
      path.join(process.cwd(), "public", photo.url.replace(/^\//, ""))
    );
    composed = await composeOfferCreative({
      photo: photoBuffer,
      extraction,
      mark: await getBrandMark(),
      title: printedTitle,
      format: direction.format,
      // I consigli o le tappe stampati dentro la card: vengono dalla stessa
      // funzione che ha prodotto le righe della caption, quindi fotogramma e
      // testo non possono dire cose diverse.
      points: copy.points,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAIError("catalog-visual.render", { proposalId: proposal.id, jobId }, e);
    await finishJob(jobId, false, undefined, `Composizione fallita: ${message}`);
    await deleteUploadedFile(photo.url).catch(() => undefined);
    if (source) await deleteUploadedFile(source.url).catch(() => undefined);
    return {
      ok: false,
      reason: "render_failed",
      needsGeneration: false,
      direction,
      extraction,
      detail: message,
      message:
        `Composizione del visuale fallita per la proposta "${proposal.name}": ` +
        "non viene creato alcun contenuto.",
    };
  }
  const { rendered } = composed;

  // 5) scrittura: Content, visuale e fonte nella stessa transazione, così non
  //    esiste mai un DRAFT senza visuale né un file senza un asset che lo usa.
  const metadata: AnyCatalogVisualMetadata = {
    origin: CATALOG_CREATIVE_ORIGIN,
    provider: CATALOG_CREATIVE_PROVIDER,
    template: OFFER_CREATIVE_TEMPLATE,
    catalogProposalId: proposal.id,
    filename: composed.filename,
    mimeType: composed.mimeType,
    size: composed.size,
    editorialFormat: direction.format,
    visualDirection: direction,
    source: {
      catalogImageId: official?.id ?? null,
      url: official?.url ?? null,
      filename: official?.filename ?? null,
      // Compilato dopo la transazione: la riga dell'asset esiste solo lì dentro.
      localAssetId: null,
    },
    generatedPhoto: {
      url: photo.url,
      provider: photo.provider,
      prompt: photoPrompt,
      aspectRatio: OFFER_PHOTO_ASPECT_RATIO,
      resolution: OFFER_PHOTO_RESOLUTION,
    },
    extractionMethod: extraction.extractionMethod,
    commercialFields: extraction.extractedFields,
    commercialConfidence: extraction.confidence,
    commercialWarnings: extraction.warnings,
    commercialLines: rendered.commercialLines.map((l) => `${l.label}  ${l.value}`),
    // I punti stampati e la loro provenienza: il fotogramma con i consigli
    // dentro e quello senza non sono la stessa creatività, e il team deve poter
    // sapere se quei consigli erano fatti veri sul posto o no.
    printedPoints: rendered.printedPoints,
    knowledgeSource: copy.knowledgeSource ?? "derived",
    printedTitle,
    brandMark: rendered.brandMark,
    width: rendered.width,
    height: rendered.height,
  };

  try {
    const platforms = assertValidPlatforms(input.platforms);
    const type = input.type ?? "POST";

    const { content, asset, sourceAsset, metadata: storedMetadata } = await prisma.$transaction(
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

        // L'originale del fornitore non entra tra gli asset del contenuto:
        // `assets[0]` è il visuale che l'app mostra in anteprima e che la
        // pubblicazione userebbe, quindi allegarlo mostrerebbe la locandina
        // come immagine del post. Va in Media Library con il ruolo di fonte.
        let sourceRow: ContentAsset | null = null;
        if (source) {
          sourceRow = await tx.contentAsset.create({
            data: {
              kind: "IMAGE",
              contentId: null,
              url: source.url,
              filename: source.filename,
              mimeType: source.mimeType,
              size: source.size,
              metadata: asInputJson({
                ...metadata,
                origin: OFFER_SOURCE_ORIGIN,
                role: OFFER_SOURCE_ROLE,
                contentId: created.id,
              } as unknown as AnyCatalogVisualMetadata),
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
        }

        // Il visuale è l'unico asset allegato al contenuto: è ciò che l'app
        // mostra in anteprima e ciò che la pubblicazione userebbe.
        // L'id della fonte esiste solo ora, quindi i metadata scritti sono
        // quelli definitivi: restituirne altri significherebbe dichiarare al
        // chiamante una provenienza diversa da quella a terra.
        const finalMetadata: AnyCatalogVisualMetadata = sourceRow
          ? { ...metadata, source: { ...metadata.source, localAssetId: sourceRow.id } }
          : metadata;

        const createdAsset = await tx.contentAsset.create({
          // `filename`, `mimeType` e `size` arrivano dai metadata già
          // normalizzati: il provider può ometterli, e la colonna no.
          data: {
            kind: "IMAGE",
            contentId: created.id,
            url: composed.url,
            filename: finalMetadata.filename,
            mimeType: finalMetadata.mimeType,
            size: finalMetadata.size,
            metadata: asInputJson(finalMetadata),
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

        return {
          content: created,
          asset: createdAsset,
          sourceAsset: sourceRow as ContentAsset | null,
          metadata: finalMetadata,
        };
      },
      { timeout: 15_000 }
    );

    // L'audit sta fuori dalla transazione di proposito: nessun CONTENT_CREATED
    // senza l'asset che lo rende pubblicabile.
    await logAudit("CONTENT_CREATED", "Content", content.id, {
      status: content.status,
      title: content.title,
      catalogProposalId: proposal.id,
      visualOrigin: CATALOG_CREATIVE_ORIGIN,
    });
    await logAudit("ASSET_CREATED", "ContentAsset", asset.id, {
      filename: asset.filename,
      kind: asset.kind,
      contentId: asset.contentId,
      origin: CATALOG_CREATIVE_ORIGIN,
    });

    // Il job IMAGE si chiude qui: la generazione è avvenuta ed è stata composta.
    await finishJob(jobId, true, { url: composed.url, assetId: asset.id, contentId: content.id });

    return {
      ok: true,
      reused: false,
      origin: CATALOG_CREATIVE_ORIGIN,
      content,
      asset: asset as ContentAsset,
      image: photo,
      sourceAsset,
      extraction,
      direction,
      metadata: storedMetadata,
    };
  } catch (e) {
    // 6) il rollback ha già annullato Content e ContentAsset: qui si ripuliscono
    //    solo i file, che la transazione non può toccare. Tutti e tre: la
    //    fotografia, il fotogramma composto e l'originale scaricato.
    logAIError("catalog-visual.persist", { proposalId: proposal.id, url: composed.url }, e);
    await deleteUploadedFile(composed.url).catch(() => undefined);
    await deleteUploadedFile(photo.url).catch(() => undefined);
    if (source) {
      await deleteUploadedFile(source.url).catch((cleanupError: unknown) => {
        logAIError("catalog-visual.cleanup", { proposalId: proposal.id, url: source!.url }, cleanupError);
      });
    }

    // La generazione è avvenuta e i suoi file sono spariti: il job non deve
    // risultare riuscito, altrimenti resterebbe la traccia di un'immagine che
    // nessuno può più usare.
    await finishJob(jobId, false, undefined, `Salvataggio non riuscito: ${composed.url} rimosso`);

    return {
      ok: false,
      reason: "persist_failed",
      needsGeneration: false,
      direction,
      extraction,
      detail: "file_removed",
      message:
        `Salvataggio non riuscito per la proposta "${proposal.name}": ` +
        "nessun contenuto è stato creato.",
    };
  }
}
