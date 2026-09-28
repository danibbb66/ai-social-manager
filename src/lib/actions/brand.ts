"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { updateBrand as svcUpdate, getBrand as svcGet } from "@/lib/services/brand";

const brandSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  instagram: z.string().nullable().optional(),
  facebook: z.string().nullable().optional(),
  tiktok: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  colors: z.record(z.string()).nullable().optional(),
  fonts: z.record(z.string()).nullable().optional(),
  tone: z.string().nullable().optional(),
  audience: z.string().nullable().optional(),
  style: z.string().nullable().optional(),
  preferredTopics: z.array(z.string()).nullable().optional(),
  forbiddenTopics: z.array(z.string()).nullable().optional(),
  forbiddenWords: z.array(z.string()).nullable().optional(),
  preferredCtas: z.array(z.string()).nullable().optional(),
});

export async function saveBrandAction(input: unknown) {
  try {
    const parsed = brandSchema.parse(input);
    const brand = await svcUpdate(parsed);
    for (const p of ["/brand", "/settings"]) revalidatePath(p);
    return { ok: true, id: brand.id };
  } catch (e) {
    console.error("[action:saveBrand]", e);
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Operazione non riuscita.",
    };
  }
}

export async function getBrandAction() {
  try {
    return svcGet();
  } catch (e) {
    console.error("[action:getBrand]", e);
    return null;
  }
}