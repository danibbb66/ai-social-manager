import { z } from "zod";
import { getDashboardStats } from "@/lib/services/stats";
import { AiTool } from "@/lib/ai/tools/types";

export const getStatisticsTool: AiTool = {
  name: "getStatistics",
  description:
    "Restituisce le statistiche dell'account: contenuti per stato, in attesa di approvazione, programmati, pubblicati negli ultimi 30 giorni, idee recenti, attività recenti.",
  brief: "Lettura statistiche",
  schema: z.object({}),
  execute: async () => {
    const stats = await getDashboardStats();
    return {
      ok: true,
      message: `Statistiche: ${stats.counts.SCHEDULED ?? 0} programmati, ${stats.pendingApproval} da approvare, ${stats.published30d} pubblicati (30gg).`,
      data: {
        counts: stats.counts,
        pendingApproval: stats.pendingApproval,
        published30d: stats.published30d,
        mediaCount: stats.mediaCount,
        ideasRecent: stats.ideasRecent,
      },
    };
  },
};