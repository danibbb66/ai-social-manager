import { z } from "zod";
import { getPendingApprovals as svcPending } from "@/lib/services/approvals";
import {
  approveContent as svcApprove,
  rejectContent as svcReject,
} from "@/lib/services/content";
import { AiTool, contentBriefView } from "@/lib/ai/tools/types";
import { friendlyMessage } from "@/lib/errors/user-message";
import { logAIError } from "@/lib/logger";

export const getPendingApprovalsTool: AiTool = {
  name: "getPendingApprovals",
  description:
    "Elenca i contenuti in attesa di approvazione (stato DRAFT). Usalo quando l'utente chiede cosa deve ancora approvare o cosa è in bozza.",
  brief: "Approvazioni pendenti",
  schema: z.object({}),
  execute: async () => {
    const contents = await svcPending();
    return {
      ok: true,
      message: `${contents.length} contenuti in attesa di approvazione.`,
      data: contents.map(contentBriefView),
    };
  },
};

export const approveContentTool: AiTool = {
  name: "approveContent",
  description:
    "Approva ESPLICITAMENTE un contenuto in stato DRAFT e lo porta ad APPROVED creando un record di approvazione. Richiede che l'utente abbia espresso chiaramente l'approvazione. Non chiamarlo mai per conto tuo.",
  brief: "Approvazione contenuto",
  schema: z.object({
    contentId: z.string(),
    note: z.string().optional(),
  }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string(), note: z.string().optional() }).parse(args);
    try {
      const updated = await svcApprove(parsed.contentId, parsed.note);
      return {
        ok: true,
        message: `Contenuto "${updated.title}" APPROVATO.`,
        data: contentBriefView(updated),
      };
    } catch (e) {
      logAIError("tool.approveContent", { contentId: parsed.contentId }, e);
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};

export const rejectContentTool: AiTool = {
  name: "rejectContent",
  description:
    "Rifiuta un contenuto in stato DRAFT (DRAFT → REJECTED) e registra la motivazione. Solo dopo esplicita richiesta dell'utente.",
  brief: "Rifiuto contenuto",
  schema: z.object({
    contentId: z.string(),
    note: z.string().optional().describe("Motivo del rifiuto"),
  }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string(), note: z.string().optional() }).parse(args);
    try {
      const updated = await svcReject(parsed.contentId, parsed.note);
      return {
        ok: true,
        message: `Contenuto "${updated.title}" rifiutato.`,
        data: contentBriefView(updated),
      };
    } catch (e) {
      logAIError("tool.rejectContent", { contentId: parsed.contentId }, e);
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};