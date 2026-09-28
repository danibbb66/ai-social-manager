import { z } from "zod";
import {
  scheduleContent as svcSchedule,
  unscheduleContent as svcUnschedule,
} from "@/lib/services/content";
import { getCalendar as svcGetCalendar } from "@/lib/services/calendar";
import { logAudit } from "@/lib/audit";
import { AiTool } from "@/lib/ai/tools/types";

export const scheduleContentTool: AiTool = {
  name: "scheduleContent",
  description:
    "Programma un contenuto su una data/ora specifica. RICHIEDE che il contenuto sia già APPROVATO (approvazione esplicita). Se non è approvato restituisce un errore.",
  brief: "Programmazione contenuto",
  schema: z.object({
    contentId: z.string(),
    date: z.string().describe("Data/ora in formato ISO (es. 2026-09-28T10:00:00)"),
  }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string(), date: z.string() }).parse(args);
    const d = new Date(parsed.date);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, message: `Data non valida: ${parsed.date}. Usa formato ISO.` };
    }
    try {
      const updated = await svcSchedule(parsed.contentId, d);
      return {
        ok: true,
        message: `Contenuto "${updated.title}" programmato per ${d.toLocaleString("it-IT")}.`,
        data: { id: updated.id, status: updated.status, scheduledDate: updated.scheduledDate },
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const unscheduleContentTool: AiTool = {
  name: "unscheduleContent",
  description:
    "Annulla la programmazione di un contenuto (torna allo stato APPROVED senza data).",
  brief: "Annullamento programmazione",
  schema: z.object({
    contentId: z.string(),
  }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string() }).parse(args);
    try {
      const updated = await svcUnschedule(parsed.contentId);
      await logAudit("CONTENT_UNSCHEDULED_VIA_AI", "Content", updated.id, {});
      return {
        ok: true,
        message: `Programmazione annullata per "${updated.title}".`,
        data: { id: updated.id, status: updated.status, scheduledDate: updated.scheduledDate },
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const getCalendarTool: AiTool = {
  name: "getCalendar",
  description:
    "Restituisce i contenuti programmati/pubblicati in un intervallo di date. Usalo quando l'utente chiede cosa c'è nel calendario.",
  brief: "Lettura calendario",
  schema: z.object({
    from: z.string().optional().describe("Data ISO inizio intervallo"),
    to: z.string().optional().describe("Data ISO fine intervallo"),
  }),
  execute: async (args) => {
    const parsed = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(args);
    const from = parsed.from ? new Date(parsed.from) : new Date(new Date().setDate(1));
    const to = parsed.to ? new Date(parsed.to) : new Date(new Date().getTime() + 62 * 86400000);
    const contents = await svcGetCalendar({ from, to });
    return {
      ok: true,
      message: `${contents.length} contenuti nell'intervallo.`,
      data: contents.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        status: c.status,
        scheduledDate: c.scheduledDate,
      })),
    };
  },
};