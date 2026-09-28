import { AiProvider } from "@/lib/ai/provider";
import { OllamaProvider } from "@/lib/ai/ollama";
import { config } from "@/lib/env";

let cached: AiProvider | null = null;
let override: AiProvider | null = null;

/**
 * Iniezione di un provider AI alternativo.
 *
 * Usata dai test per pilotare le risposte del modello senza chiamare Ollama.
 * In produzione non va mai chiamata: con `null` il comportamento è esattamente
 * quello basato su AI_PROVIDER.
 */
export function setAiProvider(provider: AiProvider | null): void {
  override = provider;
  cached = null;
}

/**
 * Factory dell'astrazione AI.
 * In base a AI_PROVIDER restituisce l'implementazione corretta
 * (ollama oggi; in futuro openai/anthropic basterà aggiungere un caso qui).
 */
export function getAiProvider(): AiProvider {
  if (override) return override;
  if (cached) return cached;
  switch (config.aiProvider) {
    case "ollama":
      cached = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
      break;
    default:
      // fallback: se il provider non è riconosciuto usiamo comunque Ollama
      cached = new OllamaProvider(config.ollamaBaseUrl, config.ollamaModel);
  }
  return cached;
}