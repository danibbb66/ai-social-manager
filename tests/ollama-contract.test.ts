import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider, buildAgentEnvelopeSchema } from "../src/lib/ai/ollama";
import { toolSchemaVariants, AI_TOOLS } from "../src/lib/ai/tools/registry";

/**
 * Contratto di trasporto verso Ollama.
 *
 * Non chiama Ollama: `fetch` è sostituito, così si verifica il corpo della
 * richiesta reale. Il punto è che qwen3 senza `think:false` riversa
 * l'analisi in `message.thinking` e lascia `content` quasi vuoto.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Risponde con lo stream NDJSON di Ollama e cattura il body inviato. */
function stubFetch(text: string): { body: Record<string, unknown> } {
  const captured: { body: Record<string, unknown> } = { body: {} };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const ndjson =
      `${JSON.stringify({
        model: "qwen3:8b",
        message: { role: "assistant", content: text },
        done: false,
      })}\n` + `${JSON.stringify({ model: "qwen3:8b", done: true })}\n`;
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
