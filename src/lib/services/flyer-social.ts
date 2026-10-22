/**
 * Verticale: locandina commerciale → dati estratti → fotografia generata →
 * NUOVA creatività sociale → DRAFT.
 *
 * È l'unico percorso che mette in fila le quattro fonti del progetto senza
 * confonderle. Ogni passaggio ha un solo proprietario:
 *
 *  1. **estrazione** (`commercial-extraction`): la locandina dice cosa costa,
 *     quando parte, dove si parte. Se non lo dice, il campo è `null`.
 *  2. **fotografia** (provider immagini configurato, Magnific in produzione):
 *     una foto di viaggio coerente con la destinazione. Solo foto: il prompt è
 *     costruito qui e non contiene prezzo, date, servizi né testo della
 *     locandina, perché sono dati di un altro strato.
 *  3. **creatività** (`social-creative`): un'immagine nuova, composta a partire
 *     dalla fotografia e dai dati estratti. La locandina non viene riusata né
 *     ritagliata: resta la fonte, non il visuale.
 *  4. **DRAFT**: un contenuto in stato di bozza, mai approvato, mai pubblicato.
 *
 * Sul riuso: la coppia (proposta, versione del verticale) identifica il
 * risultato. Ripetere la richiesta restituisce ciò che esiste senza generare,
 * scaricare, comporre o scrivere di nuovo. È idempotenza, non deduplicazione di
 * intenti.
 *
 * Sul fallimento: non esiste mai un DRAFT senza la sua creatività, né un file
 * senza un asset che lo usa. La transazione scrive contenuto e asset insieme, e
 * ogni file ottenuto prima viene rimosso se la scrittura non va a terra.
 */

import { readFileBuffer } from "@/lib/storage";
import type { ContentAsset, ContentStatus, ContentType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { getImageProvider } from "@/lib/images/factory";
import { downloadRemoteImage } from "@/lib/images/remote";
import { SOCIAL_CREATIVE_SIZE } from "@/lib/images/social-creative";
import { deleteUploadedFile, uploadedFileExists } from "@/lib/uploads";
import { getBrandMark } from "@/lib/services/brand";
import { finishJob, recordJob } from "@/lib/ai/generate";
import { assertValidPlatforms } from "@/lib/services/content";
import { getCatalogProposalForAi, type CatalogProposalDto } from "@/lib/services/catalog-ai";
import {
  buildVisualDirection,
  catalogCopyFromProposal,
  pickEditorialFormat,
  type CreativeLayers,
  type VisualDirection,
} from "@/lib/ai/catalog-content";
import { commercialLines, extractCommercial, type CommercialExtraction } from "@/lib/catalog/commercial-extraction";
import {
  composeOfferCreative,
  offerPhotoPrompt,
  OFFER_PHOTO_ASPECT_RATIO,
  OFFER_PHOTO_RESOLUTION,
  OFFER_SOURCE_ORIGIN,
  photoDirectionFrom,
  printedTitleFrom,
} from "@/lib/services/offer-creative";

/** Versione del verticale: entra nell'identità e rende il riuso esplicito. */
export const FLYER_SOCIAL_VERTICAL = "flyer-social-v1";

/** Provenienza dell'asset che è la creatività finale. */
export const FLYER_SOCIAL_CREATIVE_ORIGIN = "flyer-social-creative" as const;

/**
 * Provenienza della locandina originale.
 *
 * Vive in Media Library con `contentId` nullo, non tra gli asset del contenuto.
 * Non è un dettaglio: `assets[0]` è il visuale che l'app mostra in anteprima e
 * che la pubblicazione userebbe, quindi allegare la locandina al DRAFT
 * mostrerebbe la locandina come immagine del post. È anche ciò che tiene
 * l'originale del fornitore fuori dai visual dei post generici.
 */
export const FLYER_SOCIAL_SOURCE_ORIGIN = OFFER_SOURCE_ORIGIN;

/**
 * Prompt fotografico del verticale.
 *
 * La costruzione è quella condivisa da tutti i post nati da un'offerta di
 * catalogo: solo fotografia, nessun dato commerciale, nessuna grafica. Qui è
 * riesportata con il nome che il verticale usa da prima, perché il chiamante e
 * i test parlano di "il prompt di questo verticale".
 */
export { offerPhotoPrompt as buildPhotoPrompt } from "@/lib/services/offer-creative";

/** Formato e risoluzione del generatore: quadrato e ad alta risoluzione. */
const PHOTO_ASPECT_RATIO = OFFER_PHOTO_ASPECT_RATIO;
const PHOTO_RESOLUTION = OFFER_PHOTO_RESOLUTION;

export interface FlyerSocialInput {
  proposalId: string;
  platforms?: string[];
  type?: ContentType;
  /** Formato editoriale forzato; se non è utilizzabile si sceglie da soli. */
  format?: string | null;
}

export type FlyerSocialFailureReason =
  | "proposal_unavailable"
  | "no_flyer"
  | "generation_unavailable"
  | "generation_failed"
  | "flyer_download_failed"
  | "render_failed"
  | "persist_failed";

export type FlyerSocialResult =
  | {
      ok: true;
      reused: boolean;
      content: { id: string; title: string | null; status: ContentStatus };
      /** L'asset che è il visuale del DRAFT: la creatività nuova. */
      creative: ContentAsset;
      /** La locandina, in Media Library, fuori dagli asset del contenuto. */
      flyerSource: ContentAsset | null;
      extraction: CommercialExtraction;
      direction: VisualDirection;
      layers: CreativeLayers;
      photoPrompt: string;
    }
  | {
      ok: false;
      reason: FlyerSocialFailureReason;
      detail: string | null;
      message: string;
      extraction: CommercialExtraction | null;
      direction: VisualDirection | null;
    };


/**
 * Gli strati della creatività, dichiarati prima di comporre.
 *
 * Serve a rendere verificabile la provenienza senza aprire l'immagine: la
 * creatività finale porta con sé quattro blocchi, e solo `commercial` può
 * contenere un dato commerciale.
 */
function buildLayers(input: {
  extraction: CommercialExtraction;
  direction: VisualDirection;
  copy: { title: string; caption: string; hashtags: string };
  photoPrompt: string;
  providerName: string;
  brandMark: "logo" | "wordmark" | null;
  brandName: string | null;
}): CreativeLayers {
  const { extraction, copy, photoPrompt } = input;
  const lines = commercialLines(extraction);

  return {
    commercial: {
      origin: "FLYER",
      lines: lines.map((l) => `${l.label}  ${l.value}`),
      detail: extraction.sourceImageUrl || null,
    },
    photo: {
      origin: "MAGNIFIC",
      lines: [],
      detail: photoPrompt,
    },
    brand: {
      // Il marchio stampato è il logo configurato in `Brand.logoUrl` e, in sua
      // assenza, il wordmark con `Brand.name`: dati dell'azienda, mai un segno
      // di terzi. Il livello dichiara quale dei due è finito sull'overlay.
      origin: "BRAND",
      lines: input.brandMark === "wordmark" && input.brandName ? [input.brandName] : [],
      detail: input.brandMark,
    },
    copy: {
      origin: "COPY",
      lines: [copy.title],
      detail: copy.hashtags || null,
    },
  };
}

/** Metadati dell'asset che è la creatività finale. */
export interface FlyerSocialCreativeMetadata {
  origin: typeof FLYER_SOCIAL_CREATIVE_ORIGIN;
  vertical: typeof FLYER_SOCIAL_VERTICAL;
  provider: string;
  catalogProposalId: string;
  /** La locandina da cui sono tratti i dati commerciali. */
  flyer: {
    catalogImageId: string | null;
    sourceUrl: string;
    localAssetId: string | null;
  };
  extractionMethod: CommercialExtraction["extractionMethod"];
  commercialFields: CommercialExtraction["extractedFields"];
  commercialConfidence: number;
  commercialWarnings: string[];
  commercialLines: string[];
  generatedPhoto: {
    url: string;
    provider: string;
    prompt: string;
    /** Formato e risoluzione chiesti al provider: dichiarati, non dedotti. */
    aspectRatio: string;
    resolution: string;
  };
  visualDirection: VisualDirection;
  layers: CreativeLayers;
  width: number;
  height: number;
  /** Il titolo realmente stampato sull'overlay: il nome pulito del luogo. */
  printedTitle: string;
  /**
   * La rubrica stampata sopra il titolo, o `null` se il formato non ne ha una.
   *
   * Vale "Consigli di viaggio" per TRAVEL_TIPS: è ciò che distingue il
   * fotogramma di un contenuto informativo da quello di un hero sul luogo.
   */
  kicker: string | null;
  /** Il marchio stampato sull'overlay: logo file o wordmark con `Brand.name`. */
  brandMark: "logo" | "wordmark" | null;
}

/** Metadati dell'asset di provenienza (la locandina). */
export interface FlyerSocialSourceMetadata {
  origin: typeof FLYER_SOCIAL_SOURCE_ORIGIN;
  vertical: typeof FLYER_SOCIAL_VERTICAL;
  /** Il DRAFT a cui questa locandina appartiene: il legame, non l'allegato. */
  contentId: string;
  catalogProposalId: string;
  catalogImageId: string | null;
  sourceUrl: string;
  role: "SOURCE_FLYER";
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function isCreativeMetadata(value: unknown): value is FlyerSocialCreativeMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.origin === FLYER_SOCIAL_CREATIVE_ORIGIN && v.vertical === FLYER_SOCIAL_VERTICAL;
}

/**
 * Il risultato di questa proposta è già a terra?
 *
 * Stessa logica del riuso del visuale di catalogo: si cerca tra gli asset dei
 * contenuti legati a quella proposta e si accetta solo se il file esiste
 * ancora. Riga e disco che non concordano non sono un riuso: sono un problema
 * da rifare.
 */
async function findExisting(proposalId: string): Promise<{ content: { id: string; title: string | null; status: ContentStatus }; asset: ContentAsset; metadata: FlyerSocialCreativeMetadata } | null> {
  const candidates = await prisma.contentAsset.findMany({
    where: { kind: "IMAGE", content: { catalogProposalId: proposalId } },
    orderBy: { createdAt: "asc" },
    include: { content: { select: { id: true, title: true, status: true } } },
  });

  for (const asset of candidates) {
    if (!asset.contentId || !asset.content) continue;
    if (!isCreativeMetadata(asset.metadata)) continue;
    if (asset.content.status !== "DRAFT") continue;
    if (!(await uploadedFileExists(asset.url))) continue;
    return { content: asset.content, asset: asset as ContentAsset, metadata: asset.metadata };
  }
  return null;
}

/**
 * Percorre il verticale e, se tutto va a terra, crea il DRAFT.
 *
 * L'ordine è quello che rende il fallimento innocuo: prima si genera la
 * fotografia, poi si scarica la locandina, poi si compone, e solo alla fine si
 * scrive. Un errore in qualsiasi passaggio avviene prima di existenza di una
 * riga in database, quindi non c'è nulla da riparare: si pulisce il file e si
 * esce.
 */
export async function createFlyerSocialDraft(input: FlyerSocialInput): Promise<FlyerSocialResult> {
  const dto: CatalogProposalDto | null = await getCatalogProposalForAi(input.proposalId);
  if (!dto) {
    return {
      ok: false,
      reason: "proposal_unavailable",
      detail: input.proposalId,
      message: `Proposta di catalogo "${input.proposalId}" non trovata: nessun contenuto è stato creato.`,
      extraction: null,
      direction: null,
    };
  }

  // Senza locandina non c'è una provenienza: questo verticale promette dati
  // riconducibili a un'immagine del catalogo, e qui non ce n'è.
  if (!dto.officialImage) {
    return {
      ok: false,
      reason: "no_flyer",
      detail: dto.id,
      message: `La proposta "${dto.name}" non ha un'immagine nel catalogo: nessun contenuto è stato creato.`,
      extraction: null,
      direction: null,
    };
  }

  // La locandina viene fissata in una variabile sua: TypeScript perde il
  // restringimento di `flyer` dentro le closure, e qui la locandina
  // serve sia al download sia alla transazione.
  const flyer = dto.officialImage;

  const { format } = pickEditorialFormat(dto, (input.format as never) ?? null);
  const direction: VisualDirection = buildVisualDirection(dto, format);
  const copy = catalogCopyFromProposal(dto, format);
  const extraction = extractCommercial(dto);

  // 1) riuso: stessa proposta, stesso verticale.
  const existing = await findExisting(dto.id);
  if (existing) {
    return {
      ok: true,
      reused: true,
      content: existing.content,
      creative: existing.asset,
      flyerSource: null,
      extraction,
      direction: existing.metadata.visualDirection,
      layers: existing.metadata.layers,
      photoPrompt: existing.metadata.generatedPhoto.prompt,
    };
  }

  const provider = getImageProvider();
  if (!provider.canGenerate) {    return {
      ok: false,
      reason: "generation_unavailable",
      detail: `provider:${provider.name}`,
      message:
        `Provider immagini "${provider.name}" non sa generare: nessun contenuto è stato creato. ` +
        "La fotografia è l'unica fonte del visuale, quindi senza provider non c'è creatività.",
      extraction,
      direction,
    };
  }

  // La direzione del catalogo dice "uso l'immagine ufficiale", perché nel suo
  // flusso il visuale è la foto del catalogo. Qui non è vero: di quella
  // immagine si usa solo la provenienza dei dati, e il visuale è una fotografia
  // generata e composta da noi. L'allineamento è condiviso con l'altro percorso
  // che parte da una locandina, perché qui e lì la contraddizione sarebbe la
  // stessa: un prompt che promette "ripresa dall'originale" e un'immagine che
  // non lo è.
  const photoDirection = photoDirectionFrom(direction);

  const photoPrompt = offerPhotoPrompt(photoDirection);
  // Il marchio si legge una volta sola: è sia il dato dichiarato negli strati
  // sia quello stampato sulla creatività, e due letture darebbero due risposte
  // Potenzialmente diverse se il brand cambiasce nel mezzo.
  const mark = await getBrandMark();
  const layers = buildLayers({
    extraction,
    direction,
    copy,
    photoPrompt,
    providerName: provider.name,
    brandMark: mark?.kind ?? null,
    brandName: mark?.kind === "wordmark" ? mark.name : null,
  });

  // 2) fotografia. Il job nasce solo qui, quando la generazione sta davvero per
  //    partire: un job per una generazione che non avviene sarebbe una bugia.
  const job = await recordJob("IMAGE", {
    contentId: null,
    prompt: photoPrompt,
    aspectRatio: PHOTO_ASPECT_RATIO,
    resolution: PHOTO_RESOLUTION,
    catalogProposalId: dto.id,
    vertical: FLYER_SOCIAL_VERTICAL,
  });

  let photoUrl = "";
  try {
    const image = await provider.generateImage(photoPrompt, {
      aspectRatio: PHOTO_ASPECT_RATIO,
      resolution: PHOTO_RESOLUTION,
    });
    photoUrl = image.url;

    // Un provider che dichiara un file e non scrive nulla produrrebbe una
    // creatività costruita sul vuoto.
    if (!(await uploadedFileExists(image.url))) {
      await finishJob(job.id, false, undefined, `File generato assente: ${image.url}`);
      return {
        ok: false,
        reason: "generation_failed",
        detail: "file_missing",
        message: `Il provider immagini ha dichiarato generato "${image.url}" ma il file non è a terra: nessun contenuto è stato creato.`,
        extraction,
        direction,
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAIError("flyer-social.generate", { proposalId: dto.id, jobId: job.id }, e);
    await finishJob(job.id, false, undefined, message);
    return {
      ok: false,
      reason: "generation_failed",
      detail: `provider:${provider.name}`,
      message: `Generazione della fotografia fallita con "${provider.name}": nessun contenuto è stato creato. ${message}`,
      extraction,
      direction,
    };
  }

  // 3) locandina: copia locale per la provenienza. Non è il visuale, quindi
  //    viene tenuta in Media Library e non tra gli asset del contenuto.
  let flyerUrl = "";
  try {
    const downloaded = await downloadRemoteImage({
      url: flyer.url,
      // L'unica allowlist ammessa è il dominio della fonte già in catalogo.
      allowedDomains: [dto.source.domain],
      originalName: flyer.filename,
    });
    flyerUrl = downloaded.url;
  } catch (e) {
    const code = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : "unknown";
    logAIError("flyer-social.download", { proposalId: dto.id, code }, e);
    await finishJob(job.id, false, undefined, `Locandina non scaricata (${code})`);
    await deleteUploadedFile(photoUrl).catch(() => undefined);
    return {
      ok: false,
      reason: "flyer_download_failed",
      detail: code,
      message: `Impossibile scaricare la locandina della proposta "${dto.name}" (${code}): nessun contenuto è stato creato.`,
      extraction,
      direction,
    };
  }

  // 4) composizione della creatività.
  //
  // Il titolo è il nome pulito del luogo e nient'altro: la destinazione della
  // proposta, ripulita dalla stessa funzione che ripulisce il titolo dei post
  // generici. Il nome della proposta non viene stampato, né come titolo né
  // come sottotitolo: è una stringa editoriale che porta con sé formule
  // generiche ("... - proposta di viaggio") che sul fotogramma diventano
  // rumido, e il post ha già il suo dove nei dati commerciali qui sotto.
  //
  // Qui la fotografia non è un dettaglio: è l'unica base del fotogramma. La
  // locandina non viene ritagliata, non diventa sfondo e non viene allegata al
  // contenuto, quindi sul post non può restare traccia della grafica del
  // fornitore. La composizione è quella condivisa con l'altro percorso che
  // parte da un'offerta di catalogo.
  const creativeTitle = printedTitleFrom(extraction);
  if (!creativeTitle) {
    await finishJob(job.id, false, undefined, "Luogo non utilizzabile per il titolo della creatività");
    await deleteUploadedFile(photoUrl).catch(() => undefined);
    await deleteUploadedFile(flyerUrl).catch(() => undefined);
    return {
      ok: false,
      reason: "render_failed",
      detail: "place_missing",
      message:
        `La proposta "${dto.name}" non ha un nome di luogo utilizzabile per la creatività: ` +
        "nessun contenuto è stato creato.",
      extraction,
      direction,
    };
  }

  let composed: Awaited<ReturnType<typeof composeOfferCreative>>;
  try {
    const photo = await readFileBuffer(photoUrl);
    composed = await composeOfferCreative({
      photo,
      extraction,
      mark,
      title: creativeTitle,
      format,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAIError("flyer-social.render", { proposalId: dto.id, jobId: job.id }, e);
    await finishJob(job.id, false, undefined, `Composizione fallita: ${message}`);
    await deleteUploadedFile(photoUrl).catch(() => undefined);
    await deleteUploadedFile(flyerUrl).catch(() => undefined);
    return {
      ok: false,
      reason: "render_failed",
      detail: message,
      message: `Composizione della creatività fallita per "${dto.name}": nessun contenuto è stato creato.`,
      extraction,
      direction,
    };
  }
  const { rendered } = composed;
  const creativeUrl = composed.url;

  // 5) scrittura: DRAFT, creatività e locandina nella stessa transazione, così
  //    non esiste mai un DRAFT senza visuale né una creatività senza DRAFT.
  //    La locandina viene scritta per prima: è così che la creatività può
  //    dichiarare nei metadati l'asset esatto da cui i dati commerciali derivano,
  //    senza doverlo aggiornare dopo.
  const creativeMetadataBase: Omit<FlyerSocialCreativeMetadata, "flyer"> = {
    origin: FLYER_SOCIAL_CREATIVE_ORIGIN,
    vertical: FLYER_SOCIAL_VERTICAL,
    provider: provider.name,
    catalogProposalId: dto.id,
    extractionMethod: extraction.extractionMethod,
    commercialFields: extraction.extractedFields,
    commercialConfidence: extraction.confidence,
    commercialWarnings: extraction.warnings,
    commercialLines: rendered.commercialLines.map((l) => `${l.label}  ${l.value}`),
    generatedPhoto: {
      url: photoUrl,
      provider: provider.name,
      prompt: photoPrompt,
      aspectRatio: PHOTO_ASPECT_RATIO,
      resolution: PHOTO_RESOLUTION,
    },
    visualDirection: { ...direction, layers },
    layers,
    width: rendered.width,
    height: rendered.height,
    printedTitle: creativeTitle,
    kicker: rendered.kicker,
    brandMark: rendered.brandMark,
  };

  try {
    const platforms = assertValidPlatforms(input.platforms ?? ["INSTAGRAM"]);
    const type = input.type ?? "POST";

    const { content, creative, flyerSource } = await prisma.$transaction(
      async (tx) => {
        const created = await tx.content.create({
          data: {
            type,
            title: copy.title,
            caption: copy.caption,
            hashtags: copy.hashtags || null,
            // Bozza, sempre. Questo flusso non approva e non pubblica: la
            // revisione e la pubblicazione restano decisioni umane.
            status: "DRAFT",
            catalogProposalId: dto.id,
            platforms: { create: platforms.map((p) => ({ platform: p, accountId: null })) },
          },
          select: { id: true, title: true, status: true },
        });

        // La locandina resta in Media Library, con il legame al DRAFT nei
        // metadati. Allegarla agli asset del contenuto la farebbe diventare il
        // visuale del post, che è esattamente ciò che non deve succedere.
        const sourceMetadata: FlyerSocialSourceMetadata = {
          origin: FLYER_SOCIAL_SOURCE_ORIGIN,
          vertical: FLYER_SOCIAL_VERTICAL,
          contentId: created.id,
          catalogProposalId: dto.id,
          catalogImageId: flyer.id,
          sourceUrl: flyer.url,
          role: "SOURCE_FLYER",
        };
        const flyerRow = await tx.contentAsset.create({
          data: {
            kind: "IMAGE",
            contentId: null,
            url: flyerUrl,
            filename: flyer.filename,
            mimeType: "image/jpeg",
            size: null,
            metadata: asJson(sourceMetadata),
          },
          select: { id: true, kind: true, contentId: true, url: true, filename: true, mimeType: true, size: true, metadata: true, createdAt: true },
        });

        const creativeMetadata: FlyerSocialCreativeMetadata = {
          ...creativeMetadataBase,
          flyer: {
            catalogImageId: flyer.id,
            sourceUrl: flyer.url,
            localAssetId: flyerRow.id,
          },
        };

        // La creatività è l'unico asset allegato al contenuto: è ciò che l'app
        // mostra in anteprima e ciò che la pubblicazione userebbe.
        const creativeRow = await tx.contentAsset.create({
          data: {
            kind: "IMAGE",
            contentId: created.id,
            url: creativeUrl,
            filename: rendered.filename,
            mimeType: rendered.mimeType,
            size: rendered.buffer.length,
            metadata: asJson(creativeMetadata),
          },
          select: { id: true, kind: true, contentId: true, url: true, filename: true, mimeType: true, size: true, metadata: true, createdAt: true },
        });

        return { content: created, creative: creativeRow as ContentAsset, flyerSource: flyerRow as ContentAsset };
      },
      { timeout: 15_000 }
    );

    // L'audit sta fuori dalla transazione di proposito: nessun CONTENT_CREATED
    // senza l'asset che lo rende pubblicabile.
    await logAudit("CONTENT_CREATED", "Content", content.id, {
      status: content.status,
      title: content.title,
      catalogProposalId: dto.id,
      visualOrigin: FLYER_SOCIAL_CREATIVE_ORIGIN,
      vertical: FLYER_SOCIAL_VERTICAL,
    });
    await logAudit("ASSET_CREATED", "ContentAsset", creative.id, {
      filename: creative.filename,
      kind: creative.kind,
      contentId: creative.contentId,
      origin: FLYER_SOCIAL_CREATIVE_ORIGIN,
    });
    await finishJob(job.id, true, {
      url: creativeUrl,
      assetId: creative.id,
      contentId: content.id,
      photoUrl,
    });

    return {
      ok: true,
      reused: false,
      content,
      creative,
      flyerSource,
      extraction,
      direction: { ...direction, layers },
      layers,
      photoPrompt,
    };
  } catch (e) {
    // Il rollback ha già annullato tutto: qui si puliscono i file, che la
    // transazione non può toccare. Anche la foto generata va via: nessun asset
    // la usa e nessuno saprebbe di doverla cancellare.
    logAIError("flyer-social.persist", { proposalId: dto.id, creativeUrl }, e);
    const removed: string[] = [];
    for (const url of [creativeUrl, flyerUrl, photoUrl]) {
      const ok = await deleteUploadedFile(url).catch(() => false);
      removed.push(`${url}:${ok ? "rimosso" : "non_rimosso"}`);
    }
    await finishJob(job.id, false, undefined, `Salvataggio non riuscito: ${removed.join(", ")}`);

    return {
      ok: false,
      reason: "persist_failed",
      detail: removed.join(" "),
      message: `Salvataggio non riuscito per la proposta "${dto.name}": nessun contenuto è stato creato.`,
      extraction,
      direction,
    };
  }
}

/** Lato attivo del verticale, per l'audit e per i test. */
export const FLYER_SOCIAL_SIZE = SOCIAL_CREATIVE_SIZE;
