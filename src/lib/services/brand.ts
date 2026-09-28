import { Brand, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export interface BrandInput {
  name?: string;
  description?: string | null;
  website?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  logoUrl?: string | null;
  colors?: Record<string, string> | null;
  fonts?: Record<string, string> | null;
  tone?: string | null;
  audience?: string | null;
  style?: string | null;
  preferredTopics?: string[] | null;
  forbiddenTopics?: string[] | null;
  forbiddenWords?: string[] | null;
  preferredCtas?: string[] | null;
}

export async function getBrand(): Promise<Brand | null> {
  return prisma.brand.findFirst({ orderBy: { createdAt: "asc" } });
}

export async function getBrandOrCreate(): Promise<Brand> {
  const existing = await getBrand();
  if (existing) return existing;
  return prisma.brand.create({
    data: { name: "La Mia Agenzia di Viaggi" },
  });
}

function setNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return v === null ? null : undefined;
  return undefined;
}

export async function updateBrand(input: BrandInput): Promise<Brand> {
  const brand = await getBrandOrCreate();

  const data: Prisma.BrandUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined)
    data.description = setNull(input.description) as string | null;
  if (input.website !== undefined)
    data.website = setNull(input.website) as string | null;
  if (input.instagram !== undefined)
    data.instagram = setNull(input.instagram) as string | null;
  if (input.facebook !== undefined)
    data.facebook = setNull(input.facebook) as string | null;
  if (input.tiktok !== undefined)
    data.tiktok = setNull(input.tiktok) as string | null;
  if (input.logoUrl !== undefined)
    data.logoUrl = setNull(input.logoUrl) as string | null;
  if (input.colors !== undefined) data.colors = input.colors ?? Prisma.JsonNull;
  if (input.fonts !== undefined) data.fonts = input.fonts ?? Prisma.JsonNull;
  if (input.tone !== undefined) data.tone = setNull(input.tone) as string | null;
  if (input.audience !== undefined)
    data.audience = setNull(input.audience) as string | null;
  if (input.style !== undefined)
    data.style = setNull(input.style) as string | null;
  if (input.preferredTopics !== undefined)
    data.preferredTopics = input.preferredTopics ?? Prisma.JsonNull;
  if (input.forbiddenTopics !== undefined)
    data.forbiddenTopics = input.forbiddenTopics ?? Prisma.JsonNull;
  if (input.forbiddenWords !== undefined)
    data.forbiddenWords = input.forbiddenWords ?? Prisma.JsonNull;
  if (input.preferredCtas !== undefined)
    data.preferredCtas = input.preferredCtas ?? Prisma.JsonNull;

  const updated = await prisma.brand.update({
    where: { id: brand.id },
    data,
  });

  await logAudit("BRAND_UPDATED", "Brand", updated.id, {
    fields: Object.keys(data),
  });

  return updated;
}

/** Testo di contesto brand usato dall'AI per generare contenuti coerenti */
export function brandToContext(brand: Brand): string {
  const topics = (brand.preferredTopics as string[] | null) ?? [];
  const forbiddenTopics = (brand.forbiddenTopics as string[] | null) ?? [];
  const forbiddenWords = (brand.forbiddenWords as string[] | null) ?? [];
  const ctas = (brand.preferredCtas as string[] | null) ?? [];
  const colors = (brand.colors as Record<string, string> | null) ?? {};

  return [
    `Agenzia: ${brand.name}`,
    brand.description ? `Descrizione: ${brand.description}` : "",
    brand.website ? `Sito web: ${brand.website}` : "",
    brand.instagram ? `Instagram: ${brand.instagram}` : "",
    brand.facebook ? `Facebook: ${brand.facebook}` : "",
    brand.tiktok ? `TikTok: ${brand.tiktok}` : "",
    `Tono comunicativo: ${brand.tone ?? "non specificato"}`,
    `Pubblico: ${brand.audience ?? "non specificato"}`,
    `Stile: ${brand.style ?? "non specificato"}`,
    topics.length ? `Argomenti preferiti: ${topics.join(", ")}` : "",
    forbiddenTopics.length
      ? `Argomenti vietati: ${forbiddenTopics.join(", ")}`
      : "",
    forbiddenWords.length ? `Parole vietate: ${forbiddenWords.join(", ")}` : "",
    ctas.length ? `CTA preferite: ${ctas.join(", ")}` : "",
    Object.keys(colors).length
      ? `Colori brand: ${JSON.stringify(colors)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}