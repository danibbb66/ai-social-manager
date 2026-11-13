"use server";

import { revalidatePath } from "next/cache";
import { Platform } from "@prisma/client";

/**
 * Creazione diretta da UI (pulsanti della sezione "Crea"), SENZA passare dal
 * modello/chat. Riprende la stessa pipeline dell'AI tool `createContent`, ma
 * con input deterministici: destinazione + (per il post) testo gancio facoltativo.
 *
 * Ogni azione restituisce sempre un oggetto JSON serializzabile, mai un'eccezione
 * che in Server Action diventerebbe un 500 con corpo vuoto.
 */

export interface GenerateResult {
  ok: boolean;
  contentId: string | null;
  message: string;
}

const DEFAULT_PLATFORMS: Platform[] = ["INSTAGRAM", "FACEBOOK"];

const paths = () => ["/", "/contents", "/generate"];

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Operazione non riuscita. Riprova tra poco.";
}

async function revalidateAfter(id: string) {
  try {
    for (const p of paths()) revalidatePath(p);
    revalidatePath(`/contents/${id}`);
  } catch (e) {
    console.error("[action:generate] revalidatePath", e);
  }
}

/**
 * Crea un VIDEO manuale: l'utente sceglie clip, ordine, durata e scritta per
 * clip. Riprende `generateManualVideoForContent` con le clip indicate, senza
 * selezione automatica.
 */
export async function createManualVideoAction(input: {
  destination: string;
  clips: { key: string; startSec: number; endSec: number; caption?: string | null }[];
  font?: string;
  captionColor?: string | null;
  titleColor?: string | null;
  platforms?: Platform[];
}): Promise<GenerateResult> {
  try {
    const { createContent, deleteContent } = await import("@/lib/services/content");
    const { generateManualVideoForContent } = await import("@/lib/services/video");

    const destination = (input.destination ?? "").trim();
    if (!destination) {
      return { ok: false, contentId: null, message: "Indica una destinazione." };
    }
    const clips = (input.clips ?? []).filter((c) => c.key && c.endSec > c.startSec);
    if (clips.length === 0) {
      return { ok: false, contentId: null, message: "Seleziona almeno una clip." };
    }

    const content = await createContent({
      type: "VIDEO",
      title: destination,
      caption: null,
      hashtags: null,
      platforms: input.platforms ?? DEFAULT_PLATFORMS,
    });

    const video = await generateManualVideoForContent({
      contentId: content.id,
      title: destination,
      clips,
      font: input.font,
      captionColor: input.captionColor,
      titleColor: input.titleColor,
    });

    if (!video.ok) {
      await deleteContent(content.id).catch(() => undefined);
      return { ok: false, contentId: null, message: `Nessun video creato: ${video.reason}` };
    }

    await revalidateAfter(content.id);
    return {
      ok: true,
      contentId: content.id,
      message: `Video generato (${video.durationSec}s). Lo trovi nella sezione Contenuti.`,
    };
  } catch (e) {
    console.error("[action:createManualVideo]", e);
    return { ok: false, contentId: null, message: errorMessage(e) };
  }
}

/**
 * Crea un POST manuale: l'utente sceglie la foto e il testo da stampare sopra.
 * Riprende `attachStockVisual` passando `photoKey` (foto scelta) + `callout`.
 */
export async function createManualPostAction(input: {
  destination: string;
  photoKey?: string | null;
  callout?: string | null;
  titleColor?: string | null;
  titleFont?: string | null;
  calloutColor?: string | null;
  calloutFont?: string | null;
  platforms?: Platform[];
}): Promise<GenerateResult> {
  try {
    const { createContent, deleteContent } = await import("@/lib/services/content");
    const { attachStockVisual } = await import("@/lib/ai/content-stock");

    const destination = (input.destination ?? "").trim();
    if (!destination) {
      return { ok: false, contentId: null, message: "Indica una destinazione." };
    }

    const content = await createContent({
      type: "POST",
      title: destination,
      caption: null,
      hashtags: null,
      platforms: input.platforms ?? DEFAULT_PLATFORMS,
    });

    const visual = await attachStockVisual({
      contentId: content.id,
      destination,
      topic: destination,
      title: destination,
      format: null,
      callout: input.callout?.trim() || null,
      titleColor: input.titleColor || null,
      titleFont: input.titleFont || null,
      calloutColor: input.calloutColor || null,
      calloutFont: input.calloutFont || null,
      photoKey: input.photoKey || null,
    });

    if (visual.status === "failed") {
      await deleteContent(content.id).catch(() => undefined);
      return { ok: false, contentId: null, message: `Nessun post creato: ${visual.reason}` };
    }

    await revalidateAfter(content.id);
    return {
      ok: true,
      contentId: content.id,
      message: "Post creato in stato DRAFT. Lo trovi nella sezione Contenuti.",
    };
  } catch (e) {
    console.error("[action:createManualPost]", e);
    return { ok: false, contentId: null, message: errorMessage(e) };
  }
}
