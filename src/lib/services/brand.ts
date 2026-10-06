import { Brand, Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sniffMediaMime } from "@/lib/uploads";

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

/**
 * Marchio dell'agenzia da stampare sull'overlay dei post.
 *
 * Due sorgenti, in quest'ordine di precedenza:
 *
 *  1. `logo`: il file che l'utente ha caricato in `Brand.logoUrl`. È la
 *     sorgente forte e va sempre usata quando esiste.
 *  2. `wordmark`: il nome dell'agenzia (`Brand.name`). Non è un logo inventato
 *     né un logo di terzi: è il nome di chi produce il post, quindi dichiara
 *     l'autore senza mettere in circolo un marchio che non è dell'azienda.
 *
 * La promessa del template è che ogni post esce con il marchio: senza logo
 * file il post esce comunque con il wordmark, e `kind` dichiara quale dei due
 * è stato stampato. Il risultato è `null` solo se non c'è né un logo
 * leggibile né un nome: in quel caso non viene disegnato nessun segno.
 *
 * Il caricamento è memoizzato perché il marchio cambia di rado e la
 * composizione avviene una volta per post, non una volta per tentativo.
 * `resetBrandLogoCache` va chiamata quando il brand viene aggiornato a runtime.
 */
let brandLogoCache: BrandMark | null | undefined;

/**
 * Il marchio da stampare, con la sua forma.
 *
 * La forma è dichiarata perché cambia ciò che il renderer deve fare: `logo` è
 * un file da ridimensionare, `wordmark` è una stringa da comporre. Un
 * oggetto unico con `kind` evita che il chiamante debba chiedere due volte al
 * database per sapere quale dei due si trova davanti.
 */
export type BrandMark =
  | { kind: "logo"; buffer: Buffer; mimeType: string }
  | { kind: "wordmark"; name: string };

export async function getBrandMark(): Promise<BrandMark | null> {
  if (brandLogoCache !== undefined) return brandLogoCache;

  let resolved: BrandMark | null = null;
  try {
    const brand = await getBrand();
    const logoUrl = brand?.logoUrl?.trim();
    if (logoUrl) {
      // Solo file già in Media Library: il logo non viene scaricato dalla rete
      // durante la composizione di un post.
      const match = logoUrl.match(/^\/uploads\/([a-z]+)\/([^/]+)$/);
      if (match) {
        const buffer = await readFile(
          path.join(process.cwd(), "public", "uploads", match[1], match[2])
        ).catch(() => null);
        if (buffer && buffer.length > 0) {
          resolved = {
            kind: "logo",
            buffer,
            mimeType: sniffMediaMime(buffer) ?? "image/png",
          };
        }
      }
    }
    // Il logo file non c'è o non è leggibile: il wordmark è il marchio, non un
    // ripiego silenzioso. Un brand illeggibile non può impedire la creazione
    // di un post, quindi l'errore non viene propagato.
    if (!resolved) {
      const name = brand?.name?.replace(/\s+/g, " ").trim();
      if (name) resolved = { kind: "wordmark", name };
    }
  } catch {
    // Il marchio non è un prerequisito: un brand illeggibile non può impedire
    // la creazione di un post.
    resolved = null;
  }

  brandLogoCache = resolved;
  return resolved;
}

/** Svuota la cache del marchio, per gli aggiornamenti del brand a runtime e i test. */
export function resetBrandLogoCache(): void {
  brandLogoCache = undefined;
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