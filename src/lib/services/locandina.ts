import sharp from "sharp";
import { Platform } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { downloadRemoteImage } from "@/lib/images/remote";
import { readFileBuffer } from "@/lib/storage";
import { ocrTextFromImage } from "@/lib/catalog/ocr";
import { parseLocandinaText } from "@/lib/catalog/locandina-parse";
import { renderLocandina } from "@/lib/catalog/locandina-render";
import { filenameFromUrl } from "@/lib/catalog/offerte";
import { curatedFolderSlug } from "@/lib/ai/travel-knowledge";
import { listCuratedPhotos } from "@/lib/curated/media";
import { getBrand, getBrandMark } from "@/lib/services/brand";
import { saveUploadedFile } from "@/lib/uploads";
import { createAsset } from "@/lib/services/media";
import { createContent } from "@/lib/services/content";

export type RegenerateLocandinaResult =
  | { ok: true; contentId: string }
  | { ok: false; reason: string };

/** Sfondo di ripiego quando la destinazione non ha foto curate. */
async function fallbackBackground(): Promise<Buffer> {
  const W = 1080;
  const H = 1350;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#123a5f"/><stop offset="100%" stop-color="#0b2545"/>
    </linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/**
 * Rigenera la locandina di una proposta come creatività dell'agenzia.
 *
 * Flusso: scarica la locandina ufficiale del fornitore → ne legge il testo
 * (OCR) → ricompone una locandina nuova con foto curata, logo e sito
 * dell'agenzia → salva il risultato come nuovo contenuto POST in DRAFT.
 *
 * Non tocca mai la locandina originale e non usa il provider immagini: la foto
 * arriva dalle cartelle curate, il resto dai dati letti dalla locandina stessa.
 */
export async function regenerateLocandinaForProposal(
  proposalId: string
): Promise<RegenerateLocandinaResult> {
  const proposal = await prisma.catalogProposal.findUnique({
    where: { id: proposalId },
    include: { images: true, source: true },
  });
  if (!proposal) return { ok: false, reason: "Proposta non trovata." };

  const official =
    proposal.images.find((i) => i.role === "FLYER") ??
    proposal.images.find((i) => i.role === "HERO") ??
    proposal.images[0];
  if (!official) return { ok: false, reason: "Nessuna locandina collegata a questa proposta." };

  // 1. Locandina ufficiale: download sicuro (allowlist = dominio della fonte).
  let remote;
  try {
    remote = await downloadRemoteImage({
      url: official.url,
      allowedDomains: proposal.source?.domain ? [proposal.source.domain] : [],
    });
  } catch (e) {
    console.error("[locandina] download non riuscito", e);
    return { ok: false, reason: "Download della locandina non riuscito." };
  }

  // 2. OCR + parse dei dati commerciali.
  const raw = await readFileBuffer(remote.url);
  const text = await ocrTextFromImage(raw);
  const parsed = parseLocandinaText(text);

  // 3. Foto curata della destinazione (se esiste una cartella).
  const slug = curatedFolderSlug(proposal.destination ?? proposal.name ?? "");
  let photo: Buffer | null = null;
  if (slug) {
    const photos = await listCuratedPhotos(slug);
    if (photos.length > 0) photo = await readFileBuffer(photos[0]);
  }

  // 4. Marchio e sito dell'agenzia.
  const brand = await getBrand();
  const mark = await getBrandMark();
  const logo = mark?.kind === "logo" ? { buffer: mark.buffer, mimeType: mark.mimeType } : null;
  const brandName = mark?.kind === "wordmark" ? mark.name : (brand?.name ?? null);

  // 5. Composizione.
  const title =
    parsed.title ?? proposal.name ?? proposal.destination ?? "Offerta speciale";
  const rendered = await renderLocandina({
    photo: photo ?? (await fallbackBackground()),
    logo,
    brandName,
    website: brand?.website ?? null,
    title,
    parsed,
  });

  // 6. Salvataggio come POST (DRAFT) + asset immagine.
  const content = await createContent({
    type: "POST",
    title: proposal.name ?? proposal.destination ?? "Offerta speciale",
    caption: null,
    hashtags: null,
    platforms: [Platform.INSTAGRAM, Platform.FACEBOOK],
  });

  const saved = await saveUploadedFile({
    buffer: rendered,
    originalName: `locandina-${proposal.id}.png`,
    mimeType: "image/png",
  });

  await createAsset({
    url: saved.url,
    filename: filenameFromUrl(saved.url),
    mimeType: "image/png",
    kind: "IMAGE",
    contentId: content.id,
  });

  return { ok: true, contentId: content.id };
}
