"use server";

import { revalidatePath } from "next/cache";
import { syncOfferteCatalog } from "@/lib/services/catalog";
import { regenerateLocandinaForProposal } from "@/lib/services/locandina";

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Import non riuscito. Riprova tra poco.";
}

/**
 * Rilettura del catalogo pubblico delle offerte.
 *
 * Non è distruttiva: ricalcola le card, non duplica nulla e non cancella
 * le proposte sparite dal sito (le marca come "non più presenti").
 */
export async function importOfferteAction() {
  try {
    const report = await syncOfferteCatalog();
    revalidatePath("/catalog");
    return { ok: true as const, report };
  } catch (e) {
    console.error("[action:importOfferte]", e);
    return { ok: false as const, message: errorMessage(e) };
  }
}

/** Rigenera la locandina di una proposta come creatività dell'agenzia. */
export async function regenerateLocandinaAction(proposalId: string) {
  try {
    const result = await regenerateLocandinaForProposal(proposalId);
    revalidatePath("/catalog");
    revalidatePath("/contents");
    if (result.ok) {
      revalidatePath(`/contents/${result.contentId}`);
      return { ok: true as const, contentId: result.contentId };
    }
    return { ok: false as const, message: result.reason };
  } catch (e) {
    console.error("[action:regenerateLocandina]", e);
    return { ok: false as const, message: errorMessage(e) };
  }
}
