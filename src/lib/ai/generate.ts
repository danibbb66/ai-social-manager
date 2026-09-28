import { AIJobKind, AIJobStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBrand, brandToContext } from "@/lib/services/brand";
import { getAiProvider } from "@/lib/ai/factory";
import { AiChatMessage } from "@/lib/ai/provider";

export interface GenerateOptions {
  system?: string;
  user: string;
  temperature?: number;
  jsonMode?: boolean;
  onToken?: (chunk: string) => void;
}

/** Chiama l'AI con il contesto del brand iniettato nel system prompt */
export async function generateWithBrand(opts: GenerateOptions): Promise<string> {
  const brand = await getBrand();
  const context = brand ? brandToContext(brand) : "Nessun brand configurato.";
  const provider = getAiProvider();

  const system = opts.system
    ? `${opts.system}\n\n=== CONTESTO BRAND ===\n${context}`
    : context;

  const messages: AiChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: opts.user },
  ];

  const completion = await provider.chat(messages, {
    temperature: opts.temperature ?? 0.8,
    jsonMode: opts.jsonMode,
    onToken: opts.onToken,
  });
  return completion.text;
}

export async function recordJob(
  kind: AIJobKind,
  input: Prisma.InputJsonValue
) {
  return prisma.aIJob.create({
    data: {
      kind,
      status: "PENDING",
      input,
    },
  });
}

export async function finishJob(
  jobId: string,
  ok: boolean,
  output?: unknown,
  error?: string
) {
  await prisma.aIJob.update({
    where: { id: jobId },
    data: {
      status: (ok ? "SUCCESS" : "FAILED") as AIJobStatus,
      output: output ?? undefined,
      error: error ?? null,
    },
  });
}

export function tryParseJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}