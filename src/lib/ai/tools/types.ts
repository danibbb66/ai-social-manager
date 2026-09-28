import { z } from "zod";

export interface ToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface AiTool {
  /** nome unico usato dal modello per invocare il tool */
  name: string;
  /** descrizione dettagliata per il modello (cosa fa, quando usarlo) */
  description: string;
  /** riassunto umano mostrato nell'UI durante l'esecuzione */
  brief: string;
  /** schema Zod dei parametri */
  schema: z.ZodTypeAny;
  execute(args: unknown): Promise<ToolResult>;
}

/** Serie id/ottimale per mostrare i contenuti al modello */
export function contentBriefView(c: {
  id: string;
  title: string | null;
  type: string;
  status: string;
  scheduledDate: Date | string | null;
  platforms?: { platform: string }[];
  caption: string | null;
}) {
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    status: c.status,
    scheduledDate: c.scheduledDate ?? null,
    platforms: c.platforms?.map((p) => p.platform) ?? [],
    caption:
      typeof c.caption === "string" && c.caption.length > 180
        ? `${c.caption.slice(0, 180)}…`
        : c.caption,
  };
}