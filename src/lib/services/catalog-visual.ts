/**
 * Materializzazione del visuale di una proposta del Catalogo.
 *
 * Questo servizio esiste per una garanzia di ordine: il DRAFT nasce solo dopo
 * che il file del visuale è già a terra. La sequenza è
 *
 *   1. proposta già risolta e direzione visual già calcolata (le riceve, non le rifà);
 *   2. download dell'immagine ufficiale dal dominio della fonte del catalogo;
 *   3. transazione unica: `Content` DRAFT + `ContentAsset` collegato;
 *   4. se la transazione fallisce, il file appena scaricato viene eliminato.
 *
 * Perché quell'ordine e non il contrario. L'alternativa naturale sarebbe
 * creare il DRAFT e poi allegare l'immagine: lascerebbe un contenuto in
 * Bozza senza visual quando il download fallisce, cioè esattamente il DRAFT
 * incoerente che questo progetto vieta. Con il download prima, ogni errore
 * lascia il sistema com'era: nessun contenuto, nessun asset, nessun file.
 *
 * Il servizio è deliberatamente dumb e tipizzato: non sa nulla dell'agent, non
 * chiama il modello, non chiama il provider immagini. Decide solo se
 * materializzare l'originale del catalogo oppure dichiarare che serve una
 * generazione, e in quel caso restituisce la direzione al chiamante senza
 * fare nulla. La scelta fra usare l'originale e generarlo, e il ramo Magnific,
 * sono di chi orchestra (step successivi).
 *
 * Nessuna modifica a Prisma: la provenienza del visuale vive nel `metadata`
 * JSON dell'asset, che è già un campo pensato per questo.
 */

import type { ContentAsset, ContentStatus, ContentType, Platform, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { deleteUploadedFile } from "@/lib/uploads";
import { downloadRemoteImage, type RemoteImage } from "@/lib/images/remote";
import { assertValidPlatforms } from "@/lib/services/content";
import type { CatalogProposalDto } from "@/lib/services/catalog-ai";
import type { CatalogCopy, VisualDirection } from "@/lib/ai/catalog-content";

/** Origine registrata nell'asset quando il file viene dal catalogo. */
export const CATALOG_VISUAL_ORIGIN = "catalog-official" as const;
/** "Provider" del visuale: chi ha prodotto il file è il sito dell'agenzia. */
export const CATALOG_VISUAL_PROVIDER = "catalog" as const;

/** Provenienza del visuale, serializzata nel `metadata` dell'asset. */
export interface CatalogVisualMetadata {
  origin: typeof CATALOG_VISUAL_ORIGIN;
  provider: typeof CATALOG_VISUAL_PROVIDER;
  sourceUrl: string;
  catalogProposalId: string;
  /** Presente solo se il DTO espone l'id della riga `CatalogImage`. */
  catalogImageId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  /** Formato editoriale scelto dal flusso catalogo. */
  editorialFormat: VisualDirection["format"];
  /** La direzione così com'era al momento della materializzazione. */
  visualDirection: VisualDirection;
}

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
  /** La proposta non ha immagine: qui non si crea nulla, serve il ramo generato. */
  | "no_official_image"
  /** Il download è stato rifiutato o è fallito. Nessun file lasciato. */
  | "download_failed"
  /** Il file c'era, ma la scrittura a database è fallita: il file è stato ripulito. */
  | "persist_failed";

export type MaterializeCatalogVisualResult =
  | {
      ok: true;
      /**
       * Il DRAFT appena creato. `status` è dichiarato come enum e non come
       * letterale perché è Prisma a produrlo: la verifica che valga `DRAFT` è
       * del test, non un'affermazione nel tipo.
       */
      content: { id: string; title: string | null; status: ContentStatus };
      asset: ContentAsset;
      image: RemoteImage;
      direction: VisualDirection;
      metadata: CatalogVisualMetadata;
    }
  | {
      ok: false;
      reason: CatalogVisualFailure;
      /** Messaggio già pronto per il chiamante, senza segreti né URL interni. */
      message: string;
      /**
       * true solo per `no_official_image`: il chiamante deve quindi generare il
       * visuale (step successivo) invece di materializzare l'originale.
       */
      needsGeneration: boolean;
      /** La direzione torna indietro anche in caso di fallimento. */
      direction: VisualDirection;
      /** Codice di errore del downloader, per la diagnosi. */
      detail?: string;
    };

/**
 * Un valore da mettere in `metadata` non ha un tipo JSON dichiarato.
 *
 * `CatalogVisualMetadata` contiene la `VisualDirection`, che è un'interfaccia:
 * TypeScript non le assegna una firma implicita, quindi la conversione è
 * dichiarata qui, in un punto solo, e non sparsa nelle chiamate.
 */
function asInputJson(metadata: CatalogVisualMetadata): Prisma.InputJsonValue {
  return metadata as unknown as Prisma.InputJsonValue;
}

/**
 * Materializza l'immagine ufficiale della proposta.
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
  // ragione: non si materializza nulla e si rimanda al chiamante.
  if (!official || !direction.useOfficialImage) {
    return {
      ok: false,
      reason: "no_official_image",
      needsGeneration: true,
      direction,
      message:
        `La proposta "${proposal.name}" non ha un'immagine ufficiale nel catalogo: ` +
        "non viene creato alcun contenuto. Serve generare il visuale.",
    };
  }

  // 1) download: prima di qualsiasi scrittura a database.
  let image: RemoteImage;
  try {
    image = await downloadRemoteImage({
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
      needsGeneration: false,
      direction,
      detail: code,
      message:
        `Impossibile scaricare l'immagine ufficiale della proposta "${proposal.name}" ` +
        `dal catalogo (${code}): non viene creato alcun contenuto.`,
    };
  }

  const metadata: CatalogVisualMetadata = {
    origin: CATALOG_VISUAL_ORIGIN,
    provider: CATALOG_VISUAL_PROVIDER,
    sourceUrl: image.sourceUrl,
    catalogProposalId: proposal.id,
    catalogImageId: official.id ?? null,
    filename: image.filename,
    mimeType: image.mimeType,
    size: image.size,
    editorialFormat: direction.format,
    visualDirection: direction,
  };

  // 2) scrittura: Content e ContentAsset nella stessa transazione, così non
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
          data: {
            kind: "IMAGE",
            contentId: created.id,
            url: image.url,
            filename: image.filename,
            mimeType: image.mimeType,
            size: image.size,
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
      visualOrigin: CATALOG_VISUAL_ORIGIN,
    });
    await logAudit("ASSET_CREATED", "ContentAsset", asset.id, {
      filename: asset.filename,
      kind: asset.kind,
      contentId: asset.contentId,
      origin: CATALOG_VISUAL_ORIGIN,
    });

    return {
      ok: true,
      content,
      asset: asset as ContentAsset,
      image,
      direction,
      metadata,
    };
  } catch (e) {
    // 3) il rollback ha già annullato Content e ContentAsset: qui si ripulisce
    //    solo il file, che la transazione non può toccare.
    logAIError("catalog-visual.persist", { proposalId: proposal.id, url: image.url }, e);
    const removed = await deleteUploadedFile(image.url).catch((cleanupError: unknown) => {
      logAIError("catalog-visual.cleanup", { proposalId: proposal.id, url: image.url }, cleanupError);
      return false;
    });

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
