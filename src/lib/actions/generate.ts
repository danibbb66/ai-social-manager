"use server";

import { revalidatePath } from "next/cache";
import { AssetKind, Platform } from "@prisma/client";

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
  /** Titolo della copertina, scritto a mano. Vuoto = nessun titolo. */
  title?: string | null;
  clips: { key: string; startSec: number; endSec: number; caption?: string | null }[];
  font?: string;
  captionColor?: string | null;
  titleColor?: string | null;
  titleFont?: string | null;
  /** Traccia audio scelta (chiave `audio/…`), "none" per niente, vuoto per automatico. */
  audioKey?: string | null;
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
      title: input.title?.trim() || "",
      clips,
      font: input.font,
      captionColor: input.captionColor,
      titleColor: input.titleColor,
      titleFont: input.titleFont,
      audioKey: input.audioKey ?? null,
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
  /** Titolo stampato sul post, scritto a mano. Vuoto = nessun titolo. */
  title?: string | null;
  photoKey?: string | null;
  callout?: string | null;
  titleColor?: string | null;
  calloutColor?: string | null;
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
      heading: input.title?.trim() || null,
      format: null,
      callout: input.callout?.trim() || null,
      titleColor: input.titleColor || null,
      calloutColor: input.calloutColor || null,
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

/**
 * Elimina gli asset di un contenuto (e i file fisici, se non referenziati da
 * nessun altro asset): è il passo di "sostituzione" della rigenerazione, che
 * evita di lasciare fianco a fianco video/immagine vecchi e nuovi.
 */
async function deleteContentAssets(contentId: string, kinds: AssetKind[]): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { deleteUploadedFile } = await import("@/lib/uploads");
  const assets = await prisma.contentAsset.findMany({
    where: { contentId, kind: { in: kinds } },
    select: { id: true, url: true },
  });
  for (const a of assets) {
    await prisma.contentAsset.delete({ where: { id: a.id } }).catch(() => undefined);
    if ((await prisma.contentAsset.count({ where: { url: a.url } })) === 0) {
      await deleteUploadedFile(a.url).catch(() => undefined);
    }
  }
}

/**
 * Rigenera il visual di un POST esistente (stesso contenuto, nuovo file):
 * l'utente cambia colore/titolo/gancio e il fotogramma viene ricomposto e
 * sostituito senza creare un contenuto gemello. Riutilizza la stessa foto.
 */
export async function regenerateManualPostAction(input: {
  contentId: string;
  title?: string | null;
  photoKey?: string | null;
  callout?: string | null;
  titleColor?: string | null;
  calloutColor?: string | null;
}): Promise<GenerateResult> {
  try {
    const { getContentOrThrow } = await import("@/lib/services/content");
    const { attachStockVisual } = await import("@/lib/ai/content-stock");

    const content = await getContentOrThrow(input.contentId);
    const destination = content.title?.trim();
    if (!destination) {
      return {
        ok: false,
        contentId: null,
        message: "Il contenuto non ha una destinazione associata: impossibile rigenerare.",
      };
    }

    await deleteContentAssets(input.contentId, ["IMAGE"]);

    const visual = await attachStockVisual({
      contentId: input.contentId,
      destination,
      topic: destination,
      title: destination,
      heading: input.title?.trim() || null,
      format: null,
      callout: input.callout?.trim() || null,
      titleColor: input.titleColor || null,
      calloutColor: input.calloutColor || null,
      photoKey: input.photoKey || null,
    });

    if (visual.status === "failed") {
      return { ok: false, contentId: null, message: `Post non rigenerato: ${visual.reason}` };
    }

    await revalidateAfter(input.contentId);
    return { ok: true, contentId: input.contentId, message: "Post rigenerato." };
  } catch (e) {
    console.error("[action:regenerateManualPost]", e);
    return { ok: false, contentId: null, message: errorMessage(e) };
  }
}

/**
 * Rigenera un VIDEO esistente (stesso contenuto, nuovo montaggio): l'utente
 * cambia clip/colori/scritte e il reel viene ricomposto e sostituito.
 */
export async function regenerateManualVideoAction(input: {
  contentId: string;
  title?: string | null;
  clips: { key: string; startSec: number; endSec: number; caption?: string | null }[];
  font?: string;
  captionColor?: string | null;
  titleColor?: string | null;
  titleFont?: string | null;
  audioKey?: string | null;
}): Promise<GenerateResult> {
  try {
    const { generateManualVideoForContent } = await import("@/lib/services/video");
    const { getContentOrThrow } = await import("@/lib/services/content");
    const { prisma } = await import("@/lib/prisma");

    const clips = (input.clips ?? []).filter((c) => c.key && c.endSec > c.startSec);
    if (clips.length === 0) {
      return { ok: false, contentId: null, message: "Seleziona almeno una clip." };
    }

    const content = await getContentOrThrow(input.contentId);
    const scheduled = content.scheduledDate;

    // Rimuovo il montaggio precedente e la sua locandina: la rigenerazione
    // produce un file nuovo e una locandina nuova (frame-0 del nuovo montaggio).
    await deleteContentAssets(input.contentId, ["VIDEO", "IMAGE"]);

    const video = await generateManualVideoForContent({
      contentId: input.contentId,
      title: input.title?.trim() || "",
      clips,
      font: input.font,
      captionColor: input.captionColor,
      titleColor: input.titleColor,
      titleFont: input.titleFont,
      audioKey: input.audioKey ?? null,
    });

    if (!video.ok) {
      return { ok: false, contentId: null, message: `Video non rigenerato: ${video.reason}` };
    }

    // `markContentAsVideo` azzera la programmazione: se il contenuto era già
    // schedulato ripristiniamola, così l'edit non cancella la data scelta.
    if (scheduled) {
      await prisma.content
        .update({ where: { id: input.contentId }, data: { scheduledDate: scheduled } })
        .catch(() => undefined);
    }

    await revalidateAfter(input.contentId);
    return { ok: true, contentId: input.contentId, message: `Video rigenerato (${video.durationSec}s).` };
  } catch (e) {
    console.error("[action:regenerateManualVideo]", e);
    return { ok: false, contentId: null, message: errorMessage(e) };
  }
}
