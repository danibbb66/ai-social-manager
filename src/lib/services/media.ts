import { AssetKind, ContentAsset, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export interface AssetInput {
  url: string;
  filename: string;
  mimeType?: string | null;
  size?: number | null;
  kind?: AssetKind;
  contentId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

export const assetInclude = {
  content: { select: { id: true, title: true, status: true } },
} satisfies Prisma.ContentAssetInclude;

export type AssetWithContent = Prisma.ContentAssetGetPayload<{
  include: typeof assetInclude;
}>;

export async function listAssets(opts?: {
  contentId?: string;
  kind?: AssetKind;
  /** Quando true restituisce solo gli asset già associati a un contenuto. */
  linkedOnly?: boolean;
}): Promise<AssetWithContent[]> {
  return prisma.contentAsset.findMany({
    where: {
      ...(opts?.contentId ? { contentId: opts.contentId } : {}),
      ...(opts?.kind ? { kind: opts.kind } : {}),
      ...(opts?.linkedOnly ? { contentId: { not: null } } : {}),
    },
    include: assetInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getAsset(id: string): Promise<AssetWithContent | null> {
  return prisma.contentAsset.findUnique({ where: { id }, include: assetInclude });
}

export async function createAsset(input: AssetInput): Promise<ContentAsset> {
  const url = String(input.url ?? "").trim();
  const filename = String(input.filename ?? "").trim();
  if (!url) throw new Error("URL dell'asset mancante.");
  if (!filename) throw new Error("Nome file mancante.");

  if (input.contentId) {
    const content = await prisma.content.findUnique({
      where: { id: input.contentId },
      select: { id: true },
    });
    if (!content) {
      throw new Error(
        "Contenuto associato non trovato: impossibile allegare il file."
      );
    }
  }

  const asset = await prisma.contentAsset.create({
    data: {
      url,
      filename,
      mimeType: input.mimeType ?? null,
      size: input.size ?? null,
      kind: input.kind ?? "IMAGE",
      contentId: input.contentId ?? null,
      metadata: (input.metadata as Prisma.InputJsonValue) ?? undefined,
    },
  });
  await logAudit("ASSET_CREATED", "ContentAsset", asset.id, {
    filename: asset.filename,
    kind: asset.kind,
    contentId: asset.contentId,
  });
  return asset;
}

/**
 * Associa un asset a un contenuto (ContentAsset.contentId).
 * L'asset resta in Media Library: l'associazione non elimina né duplica il file.
 */
export async function linkAsset(id: string, contentId: string | null) {
  const asset = await getAsset(id);
  if (!asset) throw new Error("Asset non trovato.");

  if (contentId) {
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true },
    });
    if (!content) throw new Error("Contenuto associato non trovato.");
  }

  const updated = await prisma.contentAsset.update({
    where: { id },
    data: { contentId: contentId ?? null },
    include: assetInclude,
  });
  await logAudit("ASSET_LINKED", "ContentAsset", id, {
    filename: updated.filename,
    fromContentId: asset.contentId,
    toContentId: contentId,
  });
  return updated;
}

/**
 * Rimuove SOLO l'associazione tra un asset e un contenuto.
 *
 * Operazione NON distruttiva e deliberatamente separata da `deleteAsset`:
 *  - non cancella il record `ContentAsset`;
 *  - non cancella il file fisico in /public/uploads;
 *  - imposta solo `ContentAsset.contentId = null`, così l'asset torna in
 *    Media Library come "Non associato" e può essere ricollegato altrove.
 *
 * `deleteAsset` NON viene mai chiamato da qui.
 */
export async function unlinkAssetFromContent(contentId: string, assetId: string) {
  const asset = await getAsset(assetId);
  if (!asset) throw new Error("Asset non trovato.");
  if (!asset.contentId) return asset;
  if (asset.contentId !== contentId) {
    throw new Error(
      "Questo file non è associato al contenuto corrente: associazione non modificata."
    );
  }

  const updated = await prisma.contentAsset.update({
    where: { id: assetId },
    data: { contentId: null },
    include: assetInclude,
  });
  await logAudit("ASSET_UNLINKED", "ContentAsset", assetId, {
    filename: updated.filename,
    fromContentId: contentId,
  });
  return updated;
}

/**
 * Operazione DISTRUTTIVA: elimina l'asset dalla Media Library.
 * Usata solo dall'eliminazione esplicita del file (API /api/upload DELETE),
 * che rimuove anche il file fisico. Non va mai usata per togliere un asset
 * da un contenuto: usare `unlinkAssetFromContent`.
 */
export async function deleteAsset(id: string): Promise<void> {
  const asset = await getAsset(id);
  if (!asset) return;
  await prisma.contentAsset.delete({ where: { id } });
  await logAudit("ASSET_DELETED", "ContentAsset", id, {
    url: asset.url,
  });
}