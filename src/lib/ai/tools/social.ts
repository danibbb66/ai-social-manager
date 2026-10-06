import { z } from "zod";
import { publishContent } from "@/lib/services/publish";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { friendlyMessage } from "@/lib/errors/user-message";
import { AiTool } from "@/lib/ai/tools/types";

export const publishContentTool: AiTool = {
  name: "publishContent",
  description:
    "Pubblica il contenuto sulle piattaforme configurate tramite le API ufficiali. Richiede che l'utente dia conferma ESPLICITA (campo confirm=true) e che il contenuto sia già stato approvato. Le piattaforme senza credenziali non verranno pubblicate.",
  brief: "Pubblicazione contenuto",
  schema: z.object({
    contentId: z.string(),
    platform: z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK", "ALL"]).optional(),
    confirm: z.boolean().describe("Deve essere true: conferma esplicita dell'utente alla pubblicazione"),
  }),
  execute: async (args) => {
    const parsed = z.object({
      contentId: z.string(),
      platform: z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK", "ALL"]).optional(),
      confirm: z.boolean(),
    }).parse(args);

    if (!parsed.confirm) {
      return {
        ok: false,
        message:
          "Pubblicazione NON eseguita: serve la tua conferma esplicita. Scrivi 'si, pubblica' per procedere.",
      };
    }

    try {
      const res = await publishContent(parsed.contentId, parsed.platform, {
        confirm: parsed.confirm,
      });
      await logAudit("PUBLISH_VIA_AI", "Content", parsed.contentId, { res: res.ok });
      return { ok: res.ok, message: res.message, data: { jobId: res.jobId } };
    } catch (e) {
      logAIError("tool.publishContent", { contentId: parsed.contentId }, e);
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};