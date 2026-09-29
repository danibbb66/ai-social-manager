import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OllamaProvider, buildAgentEnvelopeSchema } from "../src/lib/ai/ollama";
import { toolSchemaVariants, AI_TOOLS } from "../src/lib/ai/tools/registry";
import { config } from "../src/lib/env";

/**
 * Contratto di trasporto verso Ollama.
 *
 * Non chiama Ollama: `fetch` è sostituito, così si verifica il corpo della
 * richiesta reale. Il punto è che qwen3 senza `think:false` riversa
 * l'analisi in `message.thinking` e lascia `content` quasi vuoto.
 *
 * Con H2 il corpo porta anche `num_ctx` e `num_predict`: senza un contesto
 * più grande del prompt (~7,5k token con system prompt, catalogo tool e
 * cronologia) il runtime evetta i token più vecchi, cioè le regole.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Risponde con lo stream NDJSON di Ollama e cattura il body inviato.
 * `doneExtra` finisce nell'ultimo chunk, dove Ollama manda i contatori.
 */
function stubFetch(
  text: string,
  doneExtra: Record<string, unknown> = {}
): { body: Record<string, unknown> } {
  const captured: { body: Record<string, unknown> } = { body: {} };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const ndjson =
      `${JSON.stringify({
        model: "qwen3:8b",
        message: { role: "assistant", content: text },
        done: false,
      })}\n` +
      `${JSON.stringify({ model: "qwen3:8b", done: true, ...doneExtra })}\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(ndjson);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }) as typeof fetch;
  return captured;
}

type FieldSchema = {
  type?: string;
  enum?: string[];
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

type ToolVariant = {
  name: string;
  arguments: FieldSchema;
  required: string[];
  additionalProperties?: boolean;
};

/** Le varianti tool dentro lo schema dell'envelope. */
function toolVariants(): ToolVariant[] {
  const schema = buildAgentEnvelopeSchema(toolSchemaVariants());
  const properties = schema.properties as { tool_calls: FieldSchema };
  const oneOf = (properties.tool_calls.items as unknown as { oneOf: unknown[] }).oneOf;
  return oneOf.map((raw) => {
    const v = raw as {
      properties: { name: { enum: string[] }; arguments: FieldSchema };
      required: string[];
      additionalProperties?: boolean;
    };
    return {
      name: v.properties.name.enum[0],
      arguments: v.properties.arguments,
      required: v.required,
      additionalProperties: v.additionalProperties,
    };
  });
}

/** La variante dello schema per il tool indicato. */
function variantOf(name: string): ToolVariant {
  const found = toolVariants().find((v) => v.name === name);
  assert.ok(found, `${name} deve essere nello schema`);
  return found;
}

test("il thinking di qwen3 viene disabilitato esplicitamente", async () => {
  const captured = stubFetch("Ciao");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  const res = await provider.chat([{ role: "user", content: "ciao" }]);

  assert.equal(captured.body.think, false);
  assert.equal(res.text, "Ciao");
});

test("con jsonSchema il corpo manda lo schema, non format:'json'", async () => {
  const captured = stubFetch("{}");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");
  const schema = buildAgentEnvelopeSchema(toolSchemaVariants());

  await provider.chat([{ role: "user", content: "ciao" }], { jsonSchema: schema });

  assert.deepEqual(captured.body.format, schema);
  assert.notEqual(captured.body.format, "json");
  assert.equal(captured.body.think, false);
});

test("senza schema lo schema di risposta non viene imposto", async () => {
  const captured = stubFetch("testo");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  await provider.chat([{ role: "user", content: "ciao" }]);

  assert.equal(captured.body.format, undefined);
  assert.equal(captured.body.think, false);
});

test("jsonMode semplice resta disponibile per le altre chiamate AI", async () => {
  const captured = stubFetch("{}");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  await provider.chat([{ role: "user", content: "ciao" }], { jsonMode: true });

  assert.equal(captured.body.format, "json");
});

/* ------------------------------------------------------------------------- *
 * H2: context window e tetto di generazione.
 * ------------------------------------------------------------------------- */

/** `options` del body Ollama, che porta temperature, num_ctx e num_predict. */
function sentOptions(body: Record<string, unknown>): Record<string, number> {
  return (body.options ?? {}) as Record<string, number>;
}

test("num_ctx e num_predict vengono inviati con i default applicativi", async () => {
  const captured = stubFetch("Ciao");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  await provider.chat([{ role: "user", content: "ciao" }]);

  const options = sentOptions(captured.body);
  assert.equal(options.num_ctx, 16384);
  assert.equal(options.num_predict, 900);
  assert.equal(options.temperature, 0.7);
});

test("i default applicativi sono 16384 e 900 e arrivano da env", () => {
  // Il default di Ollama è 4096: se il codice smettesse di mandare num_ctx,
  // il prompt dell'agente verrebbe troncato dalle regole in testa.
  assert.equal(config.ollamaNumCtx, 16384);
  assert.equal(config.ollamaNumPredict, 900);
});

test("num_ctx e num_predict sono sovrascrivibili per singola chiamata", async () => {
  const captured = stubFetch("Ciao");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  await provider.chat([{ role: "user", content: "ciao" }], {
    numCtx: 8192,
    numPredict: 256,
  });

  const options = sentOptions(captured.body);
  assert.equal(options.num_ctx, 8192);
  assert.equal(options.num_predict, 256);
});

test("il context window non tocca model, messages, format e think", async () => {
  const captured = stubFetch("{}");
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");
  const schema = buildAgentEnvelopeSchema(toolSchemaVariants());
  const messages = [
    { role: "system" as const, content: "regole" },
    { role: "user" as const, content: "ciao" },
  ];

  await provider.chat(messages, { jsonSchema: schema, temperature: 0.3 });

  assert.equal(captured.body.model, "qwen3:8b");
  assert.deepEqual(captured.body.messages, messages);
  assert.deepEqual(captured.body.format, schema);
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.stream, true);
  assert.equal(sentOptions(captured.body).temperature, 0.3);
  assert.equal(sentOptions(captured.body).num_ctx, 16384);
});

test(".env.example documenta le due variabili con i default", () => {
  const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  assert.match(env, /^OLLAMA_NUM_CTX=16384$/m);
  assert.match(env, /^OLLAMA_NUM_PREDICT=900$/m);
  // le variabili già presenti non vengono toccate
  assert.match(env, /^OLLAMA_MODEL=qwen3:8b$/m);
  assert.match(env, /^OLLAMA_BASE_URL=http:\/\/127\.0\.0\.1:11434$/m);
});

test("i contatori di contesto arrivano dall'ultimo chunk del driver", async () => {
  // Diagnostica H2: prompt_eval_count dice se il prompt è entrato nel contesto.
  const captured = stubFetch("Ciao", { prompt_eval_count: 7476, eval_count: 42 });
  const provider = new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");

  const res = await provider.chat([{ role: "user", content: "ciao" }]);

  assert.equal(res.text, "Ciao");
  assert.equal(res.promptEvalCount, 7476);
  assert.equal(res.evalCount, 42);
  assert.equal(sentOptions(captured.body).num_ctx, 16384);
});

test("lo schema ammette solo i tool del registry", () => {
  const names = toolVariants().map((v) => v.name);
  assert.equal(names.length, AI_TOOLS.length);
  assert.deepEqual(names, AI_TOOLS.map((t) => t.name));
  assert.equal(new Set(names).size, names.length, "nessun tool duplicato");
});

test("lo schema vincola gli argomenti di ogni tool (niente chiavi libere)", () => {
  for (const variant of toolVariants()) {
    assert.equal(
      variant.additionalProperties,
      false,
      `${variant.name}: nessuna chiave extra consentita`
    );
    assert.deepEqual(
      variant.required,
      ["name", "arguments"],
      variant.name
    );
    if (variant.arguments.properties) {
      assert.equal(
        variant.arguments.additionalProperties,
        false,
        `${variant.name}: gli argomenti non ammettono chiavi inventate`
      );
    }
  }
});

test("createContent nello schema accetta solo le piattaforme valide", () => {
  const args = variantOf("createContent").arguments;
  assert.ok(args.properties, "createContent deve avere argomenti");

  assert.deepEqual(args.properties.platforms?.items?.enum, [
    "INSTAGRAM",
    "FACEBOOK",
    "TIKTOK",
  ]);
  assert.deepEqual(args.properties.type?.enum, ["POST", "VIDEO"]);
});

test("deleteContent nello schema richiede la conferma", () => {
  const args = variantOf("deleteContent").arguments;
  assert.ok(args.properties, "deleteContent deve avere argomenti");

  assert.equal(args.properties.confirm?.type, "boolean");
  assert.ok(
    args.required?.includes("confirm"),
    "confirm è obbligatorio: non può mancare"
  );
  assert.ok(args.required?.includes("contentId"));
});

test("publishContent nello schema richiede la conferma", () => {
  const args = variantOf("publishContent").arguments;
  assert.ok(args.properties, "publishContent deve avere argomenti");

  assert.equal(args.properties.confirm?.type, "boolean");
  assert.ok(args.required?.includes("confirm"));
});
