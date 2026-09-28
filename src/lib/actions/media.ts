"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  linkAsset as svcLink,
  unlinkAssetFromContent as svcUnlink,
} from "@/lib/services/media";

const linkSchema = z.object({
  assetId: z.string().min(1, "Asset non valido."),
  contentId: z.string().min(1, "Contenuto non valido."),
});

const unlinkSchema = z.object({
  assetId: z.string().min(1, "Asset non valido."),
  contentId: z.string().min(1, "Contenuto non valido."),
});

function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.errors.map((err) => err.message).join("; ");
  }
  if (e instanceof Error && e.message) return e.message;
  return "Operazione non riuscita. Riprova tra poco.";
}

function revalidateAssetPaths(contentId?: string | null) {
  revalidatePath("/media");
  revalidatePath("/contents");
  if (contentId) revalidatePath(`/contents/${contentId}`);
}

/** Associa un asset della Media Library a un contenuto (senza rimuovere il file). */
export async function linkAssetAction(input: unknown) {
  try {
    const parsed = linkSchema.parse(input);
    const asset = await svcLink(parsed.assetId, parsed.contentId);
    revalidateAssetPaths(asset.contentId);
    revalidateAssetPaths(parsed.contentId);
    return { ok: true, id: asset.id };
  } catch (e) {
    console.error("[action:linkAsset]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

/**
 * Rimuove l'associazione asset → contenuto. NON distruttiva: l'asset e il
 * file restano in Media Library e tornano visibili come "Non associato".
 */
export async function unlinkAssetAction(input: unknown) {
  try {
    const parsed = unlinkSchema.parse(input);
    const asset = await svcUnlink(parsed.contentId, parsed.assetId);
    revalidateAssetPaths(parsed.contentId);
    return { ok: true, id: asset.id, contentId: asset.contentId };
  } catch (e) {
    console.error("[action:unlinkAsset]", e);
    return { ok: false, message: errorMessage(e) };
  }
}
