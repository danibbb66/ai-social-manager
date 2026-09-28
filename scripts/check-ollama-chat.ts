/**
 * Check manuale della Chat contro Ollama reale (NON usa provider finti).
 *
 * Verifica che il modello, con lo stesso contratto usato da runAgent
 * (think:false + JSON Schema dell'envelope), scelga il tool giusto e produca
 * argomenti che superano la validazione Zod reale.
 * Non tocca il database e non esegue i tool.
 *
 *   npx tsx scripts/check-ollama-chat.ts "Crea un post Instagram e Facebook per una proposta Calabria"
 *   npx tsx scripts/check-ollama-chat.ts "Dammi 3 idee per l'estate"
 */
import { OllamaProvider } from "@/lib/ai/ollama";
import { getTool, AI_TOOLS } from "@/lib/ai/tools/registry";
import { SYSTEM_PROMPT, AGENT_ENVELOPE_SCHEMA } from "@/lib/ai/agent";

const userMessage =
  process.argv[2] ?? "Crea un post Instagram e Facebook per una proposta Calabria";

async function main() {
  const provider = new OllamaProvider();
  const ping = await provider.ping();
  console.log(`provider : ${ping.provider} / ${ping.model}`);
  console.log(`reacheable: ${ping.message}`);
  if (!ping.ok) process.exitCode = 1;

  const schema = AGENT_ENVELOPE_SCHEMA;
  console.log(`schema   : ${AI_TOOLS.length} varianti tool`);
  console.log(`richiesta: ${userMessage}\n`);

  const t0 = Date.now();
  const completion = await provider.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { jsonSchema: schema, temperature: 0.3 }
  );
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`tempo    : ${seconds}s`);
  console.log(`raw      : ${completion.text}\n`);

  let envelope: { message?: unknown; tool_calls?: unknown };
  try {
    envelope = JSON.parse(completion.text) as typeof envelope;
  } catch {
    console.log("ESITO    : KO - risposta non e' JSON valido");
    process.exitCode = 1;
    return;
  }

  const calls = (envelope.tool_calls ?? []) as {
    name?: unknown;
    arguments?: unknown;
  }[];
  if (!Array.isArray(calls) || calls.length === 0) {
    console.log("ESITO    : KO - nessun tool chiamato");
    process.exitCode = 1;
    return;
  }

  let allValid = true;
  for (const call of calls) {
    const name = String(call.name);
    const tool = getTool(name);
    console.log(`tool     : ${name}${tool ? "" : "  (SCONOSCIUTO)"}`);
    console.log(`argomenti: ${JSON.stringify(call.arguments)}`);
    if (!tool) {
      allValid = false;
      continue;
    }
    const parsed = tool.schema.safeParse(call.arguments);
    console.log(`validi   : ${parsed.success ? "si" : "NO -> " + parsed.error.issues[0]?.message}`);
    if (!parsed.success) allValid = false;
  }

  console.log(`\nESITO    : ${allValid ? "OK" : "KO"}`);
  if (!allValid) process.exitCode = 1;
}

main().catch((e) => {
  console.error("check fallito:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
