"use server";

import { revalidatePath } from "next/cache";
import { ContentStatus, ContentType, Platform } from "@prisma/client";
import { z } from "zod";
import {
  createContent as svcCreate,
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
  type: z.enum(["POST", "CAROUSEL", "VIDEO"]).optional(),
  title: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  hashtags: z.string().nullable().optional(),
  scheduledDate: z.string().nullable().optional(),
  platforms: z.array(z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK"])).optional(),
});

const paths = (id?: string) => ["/", "/contents", "/calendar", ...(id ? [`/contents/${id}`] : [])];

function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return `Dati non validi: ${e.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("; ")}`;
  }
  if (e instanceof Error && e.message) return e.message;
  return "Operazione non riuscita. Riprova tra poco.";
}

export async function createContentAction(input: unknown) {
  try {
    const parsed = contentInputSchema.parse(input);
    const content = await svcCreate({
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
    console.error("[action:createContent]", e);
    return { ok: false, message: errorMessage(e) };
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