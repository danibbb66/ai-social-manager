import { z } from "zod";
import { AiTool } from "@/lib/ai/tools/types";
import {
  createContentTool,
  updateContentTool,
  getContentTool,
  listContentsTool,
  duplicateContentTool,
  deleteContentTool,
} from "@/lib/ai/tools/content";
import { searchCatalogTool } from "@/lib/ai/tools/catalog";
import { createIdeaTool, listIdeasTool } from "@/lib/ai/tools/ideas";
import {
  generateCaptionTool,
  generateHashtagsTool,
  generateImageTool,
} from "@/lib/ai/tools/generation";
import { createCarouselTool, generateVideoTool } from "@/lib/ai/tools/carousel";
import {
  scheduleContentTool,
  unscheduleContentTool,
  getCalendarTool,
} from "@/lib/ai/tools/calendar";
import { getBrandTool, updateBrandTool } from "@/lib/ai/tools/brand";
import {
  getPendingApprovalsTool,
  approveContentTool,
  rejectContentTool,
} from "@/lib/ai/tools/approvals";
import { getStatisticsTool } from "@/lib/ai/tools/stats";
import { publishContentTool } from "@/lib/ai/tools/social";

export const AI_TOOLS: AiTool[] = [
  createContentTool,
  searchCatalogTool,
  updateContentTool,
  getContentTool,
  listContentsTool,
  duplicateContentTool,
  deleteContentTool,
  createIdeaTool,
  listIdeasTool,
  generateCaptionTool,
  generateHashtagsTool,
  generateImageTool,
  createCarouselTool,
  generateVideoTool,
  scheduleContentTool,
  unscheduleContentTool,
  getCalendarTool,
  getBrandTool,
  updateBrandTool,
  getPendingApprovalsTool,
  approveContentTool,
  rejectContentTool,
  getStatisticsTool,
  publishContentTool,
];

export function getTool(name: string): AiTool | undefined {
  return AI_TOOLS.find((t) => t.name === name);
}

type JsonSchema = Record<string, unknown>;

/**
 * Converte il sottoinsieme di Zod usato dai tool in JSON Schema.
 *
 * Serve al decoding strutturato di Ollama (`format` con schema): senza uno
 * schema per-argomento il modello inventa i valori ("type": "destination",
 * "Facebook") invece di rispettare gli enum. Copre solo i costrutti
 * effettivamente usati: string, boolean, number, enum, array, object,
 * optional/nullable/default e preprocess (ZodEffects).
 */
function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const typeName = schema._def.typeName;
  switch (typeName) {
    case "ZodEffects":
      return toJsonSchema((schema as z.ZodEffects<z.ZodTypeAny>)._def.schema);
    case "ZodOptional":
    case "ZodNullable":
      return toJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodDefault":
      return toJsonSchema(
        (schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType
      );
    case "ZodString":
      return { type: "string" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodEnum":
      return {
        type: "string",
        enum: [...(schema as z.ZodEnum<[string, ...string[]]>)._def.values],
      };
    case "ZodArray": {
      const arr = schema as unknown as { _def: { type: z.ZodTypeAny } };
      return { type: "array", items: toJsonSchema(arr._def.type) };
    }
    case "ZodObject": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> })
        .shape;
      const properties: JsonSchema = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        if (!(value.isOptional?.() ?? false)) required.push(key);
      }
      const out: JsonSchema = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) out.required = required;
      return out;
    }
    default:
      // tipo non mappato: lascia libero il campo invece di bloccare la grammatica
      return {};
  }
}

/**
 * Schema degli argomenti di ogni tool, per il decoding strutturato.
 * Un solo flusso: la validazione resta quella Zod di `tool.schema`.
 */
export function toolSchemaVariants(): {
  name: string;
  arguments: JsonSchema;
}[] {
  return AI_TOOLS.map((t) => ({
    name: t.name,
    arguments: toJsonSchema(t.schema),
  }));
}

/** Descrizioni in formato compatto per il system prompt */
export function toolsSystemDescription(): string {
  return AI_TOOLS.map(
    (t) =>
      `- ${t.name}: ${t.description} Parametri: ${JSON.stringify(describeSchema(t.schema))}`
  ).join("\n");
}

function describeSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (!("shape" in schema) || typeof schema.shape !== "object") return {};
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    const isOptional = v.isOptional?.() ?? false;
    const inner = isOptional ? (v as z.ZodOptional<z.ZodTypeAny>).unwrap() : v;
    out[k] = describeField(inner, isOptional);
  }
  return out;
}

/** Descrizione del tipo di un campo, gestendo preprocess, array ed enum. */
function describeField(v: z.ZodTypeAny, isOptional: boolean): string {
  if (v._def.typeName === "ZodEffects") {
    const innerSchema = (v as z.ZodEffects<z.ZodTypeAny>)._def.schema;
    return describeField(innerSchema, isOptional);
  }
  if (v._def.typeName === "ZodObject") {
    return `object${isOptional ? " (opzionale)" : ""}`;
  }
  let type = "string";
  if (v._def.typeName === "ZodArray") {
    const inner = (v as z.ZodArray<z.ZodTypeAny>).element;
    if (inner._def.typeName === "ZodEnum") {
      type = `array of ${JSON.stringify((inner as z.ZodEnum<[string, ...string[]]>)._def.values)}`;
    } else {
      type = "array";
    }
  }
  if (v._def.typeName === "ZodEnum") {
    type = `enum ${JSON.stringify((v as z.ZodEnum<[string, ...string[]]>)._def.values)}`;
  }
  if (v._def.typeName === "ZodNumber") type = "number";
  if (v._def.typeName === "ZodBoolean") type = "boolean";
  const description = v.description ?? "";
  return `${type}${isOptional ? " (opzionale)" : ""}${description ? ` - ${description}` : ""}`;
}