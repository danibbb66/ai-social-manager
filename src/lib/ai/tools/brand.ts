import { z } from "zod";
import { getBrand as svcGetBrand, updateBrand as svcUpdateBrand, BrandInput } from "@/lib/services/brand";
import { AiTool } from "@/lib/ai/tools/types";

export const getBrandTool: AiTool = {
  name: "getBrand",
  description:
    "Restituisce la configurazione del brand (nome agenzia, tono, pubblico, colori, CTA, argomenti preferiti/vietati...). Usala per contestualizzare le richieste o quando l'utente chiede di vedere il profilo brand.",
  brief: "Lettura brand",
  schema: z.object({}),
  execute: async () => {
    const brand = await svcGetBrand();
    if (!brand) {
      return { ok: false, message: "Nessun brand configurato ancora." };
    }
    return {
      ok: true,
      message: "Profilo brand recuperato.",
      data: {
        id: brand.id,
        name: brand.name,
        description: brand.description,
        website: brand.website,
        instagram: brand.instagram,
        facebook: brand.facebook,
        tiktok: brand.tiktok,
        tone: brand.tone,
        audience: brand.audience,
        style: brand.style,
        preferredTopics: brand.preferredTopics,
        forbiddenTopics: brand.forbiddenTopics,
        forbiddenWords: brand.forbiddenWords,
        preferredCtas: brand.preferredCtas,
        colors: brand.colors,
        fonts: brand.fonts,
      },
    };
  },
};

export const updateBrandTool: AiTool = {
  name: "updateBrand",
  description:
    "Aggiorna uno o più campi del profilo brand (nome agenzia, descrizione, sito, social, tono comunicativo, pubblico, stile, argomenti preferiti/vietati, parole vietate, CTA, colori, font).",
  brief: "Aggiornamento brand",
  schema: z.object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    instagram: z.string().nullable().optional(),
    facebook: z.string().nullable().optional(),
    tiktok: z.string().nullable().optional(),
    tone: z.string().nullable().optional(),
    audience: z.string().nullable().optional(),
    style: z.string().nullable().optional(),
    preferredTopics: z.array(z.string()).nullable().optional(),
    forbiddenTopics: z.array(z.string()).nullable().optional(),
    forbiddenWords: z.array(z.string()).nullable().optional(),
    preferredCtas: z.array(z.string()).nullable().optional(),
  }),
  execute: async (args) => {
    const parsed = z.object({
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      website: z.string().nullable().optional(),
      instagram: z.string().nullable().optional(),
      facebook: z.string().nullable().optional(),
      tiktok: z.string().nullable().optional(),
      tone: z.string().nullable().optional(),
      audience: z.string().nullable().optional(),
      style: z.string().nullable().optional(),
      preferredTopics: z.array(z.string()).nullable().optional(),
      forbiddenTopics: z.array(z.string()).nullable().optional(),
      forbiddenWords: z.array(z.string()).nullable().optional(),
      preferredCtas: z.array(z.string()).nullable().optional(),
    }).parse(args);

    const updated = await svcUpdateBrand(parsed as BrandInput);
    return {
      ok: true,
      message: `Brand "${updated.name}" aggiornato.`,
      data: { id: updated.id, name: updated.name },
    };
  },
};