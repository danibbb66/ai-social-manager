"use server";

import { revalidatePath } from "next/cache";
import { ContentStatus, ContentType, Platform } from "@prisma/client";
import { z } from "zod";
import {
  updateContent as svcUpdate,
  getContent as svcGet,
  deleteContent as svcDelete,
  duplicateContent as svcDuplicate,
  changeStatus as svcChangeStatus,
  approveContent as svcApprove,
  rejectContent as svcReject,
  scheduleContent as svcSchedule,
  unscheduleContent as svcUnschedule,
} from "@/lib/services/content";
import { moveContentOnCalendar as svcMove } from "@/lib/services/calendar";
import { publishContent as svcPublish } from "@/lib/services/publish";

const contentInputSchema = z.object({
  proposalId: z.string().optional(),
  type: z.enum(["POST", "CAROUSEL", "VIDEO"]).optional(),
  title: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  hashtags: z.string().nullable().optional(),
  scheduledDate: z.string().nullable().optional(),
  platforms: z.array(z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK"])).optional(),
});

const paths = (id?: string) => ["/", "/contents", "/calendar", "/planning", ...(id ? [`/contents/${id}`] : [])];

function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return `Dati non validi: ${e.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("; ")}`;
  }
  if (e instanceof Error && e.message) return e.message;
  return "Operazione non riuscita. Riprova tra poco.";
}

/**
 * La risposta è SEMPRE un oggetto JSON serializzabile con esito esplicito:
 * una Server Action che lascia sfuggire un'eccezione torna al client come 500
 * con corpo vuoto, che il fetch lato client legge come "Unexpected end of
 * JSON input". Qui nessun percorso — parsing, id invalido, database,
 * revalidazione — può sfuggire: ogni esito negativo è un oggetto strutturato
 * con `success: false` e `error` leggibile.
 *
 * I campi `success`/`error` accompagnano `ok`/`message`: la prima coppia è il
 * contratto richiesto dai chiamanti JSON, la seconda quella storica dei
 * componenti React. Stesso valore, nessuna fonte di verità in conflitto.
 */
export async function createContentAction(input: unknown) {
  try {
    // Import dinamico dei servizi: un'eccezione all'inizializzazione di un
    // modulo (configurazione, ambiente) diventa un errore gestito qui sotto
    // invece di far 500are l'intera action prima ancora di entrare nel try.
    const { createContent, createContentFromProposal } = await import(
      "@/lib/services/content"
    );
    const { ensureVideoPoster } = await import("@/lib/services/video");

    // Il parsing con safeParse non lancia: un payload malformato è un esito
    // strutturato, non un'eccezione da 500.
    const parsed = contentInputSchema.safeParse(input);
    if (!parsed.success) {
      const message = errorMessage(parsed.error);
      return {
        ok: false as const,
        success: false as const,
        id: null as string | null,
        message,
        error: message,
      };
    }

    // Un ID proposta vuoto o plausibile-only-in-apparenza non arriva al
    // database: è un errore di input dichiarato, non un crash a valle.
    const proposalId = parsed.data.proposalId?.trim() ?? "";
    if (parsed.data.proposalId && (!proposalId || proposalId.length > 64)) {
      const message = "ID della proposta mancante o non valido.";
      return {
        ok: false as const,
        success: false as const,
        id: null as string | null,
        message,
        error: message,
      };
    }

    let content;
    if (proposalId) {
      // Flusso "da proposta": il servizio fa da guardia contro i doppioni
      // (controllo di unicità prima dell'insert) e clona le immagini della
      // proposta come asset della nuova bozza.
      content = await createContentFromProposal({
        proposalId,
        type: parsed.data.type as ContentType | undefined,
        title: parsed.data.title,
        caption: parsed.data.caption,
        hashtags: parsed.data.hashtags,
        scheduledDate: parsed.data.scheduledDate
          ? new Date(parsed.data.scheduledDate)
          : null,
        platforms: parsed.data.platforms as Platform[] | undefined,
      });
      // Per un VIDEO la prima immagine della proposta diventa la locandina del
      // contenuto: niente copertina da cercare a mano nell'editor.
      if (content.type === "VIDEO") {
        await ensureVideoPoster(content.id).catch(() => undefined);
      }
    } else {
      content = await createContent({
        type: parsed.data.type as ContentType | undefined,
        title: parsed.data.title,
        caption: parsed.data.caption,
        hashtags: parsed.data.hashtags,
        scheduledDate: parsed.data.scheduledDate
          ? new Date(parsed.data.scheduledDate)
          : null,
        platforms: parsed.data.platforms as Platform[] | undefined,
      });
    }

    // La revalidazione non può mascherare una creazione riuscita né causare
    // un 500 a creazione avvenuta: fallisce e viene loggata, il contenuto
    // resta creato e la risposta resta di successo.
    try {
      for (const p of paths(content.id)) revalidatePath(p);
    } catch (e) {
      console.error("[action:createContent] revalidatePath", e);
    }

    return {
      ok: true as const,
      success: true as const,
      id: content.id,
      message: null as string | null,
      error: null as string | null,
    };
  } catch (e) {
    const message = errorMessage(e);
    console.error("[action:createContent]", e);
    return {
      ok: false as const,
      success: false as const,
      id: null as string | null,
      message,
      error: message,
    };
  }
}

export async function updateContentAction(input: unknown & { id: string }) {
  try {
    const parsed = contentInputSchema.extend({ id: z.string() }).parse(input);
    const content = await svcUpdate(parsed.id, {
      type: parsed.type as ContentType | undefined,
      title: parsed.title,
      caption: parsed.caption,
      hashtags: parsed.hashtags,
      scheduledDate: parsed.scheduledDate ? new Date(parsed.scheduledDate) : null,
      platforms: parsed.platforms as Platform[] | undefined,
    });
    for (const p of paths(content.id)) revalidatePath(p);
    return { ok: true, id: content.id };
  } catch (e) {
    console.error("[action:updateContent]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function deleteContentAction(id: string) {
  try {
    await svcDelete(id);
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    console.error("[action:deleteContent]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function duplicateContentAction(id: string) {
  try {
    const content = await svcDuplicate(id);
    for (const p of paths(content.id)) revalidatePath(p);
    return { ok: true, id: content.id };
  } catch (e) {
    console.error("[action:duplicateContent]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function approveAction(id: string, note?: string) {
  try {
    const content = await svcApprove(id, note);
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, status: content.status };
  } catch (e) {
    console.error("[action:approve]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function rejectAction(id: string, note?: string) {
  try {
    const content = await svcReject(id, note);
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, status: content.status };
  } catch (e) {
    console.error("[action:reject]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function setStatusAction(id: string, status: ContentStatus, note?: string) {
  try {
    const content = await svcChangeStatus(id, status, note);
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, status: content.status };
  } catch (e) {
    console.error("[action:setStatus]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function scheduleAction(id: string, date: string) {
  try {
    const content = await svcSchedule(id, new Date(date));
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, status: content.status };
  } catch (e) {
    console.error("[action:schedule]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function unscheduleAction(id: string) {
  try {
    const content = await svcUnschedule(id);
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, status: content.status };
  } catch (e) {
    console.error("[action:unschedule]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function moveCalendarAction(id: string, date: string) {
  try {
    const res = await svcMove(id, new Date(date));
    for (const p of paths(id)) revalidatePath(p);
    return { ok: true, ...res };
  } catch (e) {
    console.error("[action:moveCalendar]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function publishAction(id: string, platform?: string) {
  try {
    const res = await svcPublish(id, platform, { confirm: true });
    for (const p of paths(id)) revalidatePath(p);
    return { ok: res.ok, message: res.message };
  } catch (e) {
    console.error("[action:publish]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function getContentAction(id: string) {
  try {
    return svcGet(id);
  } catch (e) {
    console.error("[action:getContent]", e);
    return null;
  }
}