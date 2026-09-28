import { AiPingResult } from "@/lib/ai/provider";
import { getAiProvider } from "@/lib/ai/factory";

let lastPing: { at: number; result: AiPingResult } | null = null;
const CACHE_MS = 10_000;

/** Verifica lo stato del provider AI con una piccola cache per non sovraccaricare Ollama */
export async function checkAiStatus(force = false): Promise<AiPingResult> {
  if (!force && lastPing && Date.now() - lastPing.at < CACHE_MS) {
    return lastPing.result;
  }
  const provider = getAiProvider();
  const result = await provider.ping();
  lastPing = { at: Date.now(), result };
  return result;
}