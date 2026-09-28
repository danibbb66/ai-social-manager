import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateWithBrand, recordJob, finishJob, tryParseJson } from "@/lib/ai/generate";
import { getContentOrThrow, createContent, updateContent } from "@/lib/services/content";
import { createAsset } from "@/lib/services/media";
import { getVideoProvider } from "@/lib/video/factory";
import { VideoGenerationUnavailableError } from "@/lib/video/provider";
import { logAudit } from "@/lib/audit";
import { AiTool } from "@/lib/ai/tools/types";
import { platformsField } from "@/lib/ai/tools/schemas";

const slideSchema = z.object({
  title: z.string().optional().describe("Titolo della slide"),
  text: z.string().optional().describe("Testo della slide"),
  imageUrl: z.string().optional().describe("URL immagine della slide"),
  durationSec: z.number().optional().describe("Durata in secondi (per i video)"),
});

async function generateSlideIdeas(topic: string, count = 5): Promise<{ title: string; text: string }[]> {
  const raw = await generateWithBrand({
    jsonMode: true,
    temperature: 0.85,
    system:
      "Sei un creative strategist per agenzie di viaggio. Progetta carousel coinvolgenti: ogni slide ha un titolo breve accattivante e un testo conciso che porta all'azione. Rispetta tono e limiti del brand.",
    user: `Progetta un carousel di ${count} slide sul tema "${topic}". Rispondi SOLO con JSON: {"slides": [{"title": "...", "text": "..."}]}`,
  });
  const json = tryParseJson(raw);
  const slides = (json?.slides ?? []) as { title?: string; text?: string }[];
  return slides.slice(0, count).map((s) => ({ title: s.title ?? "", text: s.text ?? "" }));
}

export const createCarouselTool: AiTool = {
  name: "createCarousel",
  description:
    "Crea o aggiorna un carousel. Se passi 'slides' le usa direttamente; se passi 'topic' e generateSlides=true, genera il testo delle slide con l'AI. Ogni slide può avere titolo, testo e immagine. Esempio: {\"title\": \"5 luoghi romantici a Parigi\", \"topic\": \"weekend romantico a Parigi\", \"generateSlides\": true, \"platforms\": [\"INSTAGRAM\"]}. ATTENZIONE: platforms è SEMPRE un array.",
  brief: "Creazione carousel",
  schema: z.object({
    contentId: z.string().optional().describe("Se presente aggiorna questo contenuto, altrimenti ne crea uno nuovo"),
    title: z.string().optional(),
    topic: z.string().optional(),
    slides: z.array(slideSchema).optional(),
    generateSlides: z.boolean().optional().describe("Generare il contenuto delle slide con l'AI dal topic"),
    platforms: platformsField.optional(),
  }),
  execute: async (args) => {
    const parsed = z.object({
      contentId: z.string().optional(),
      title: z.string().optional(),
      topic: z.string().optional(),
      slides: z.array(slideSchema).optional(),
      generateSlides: z.boolean().optional(),
      platforms: platformsField.optional(),
    }).parse(args);

    const job = await recordJob("CAROUSEL", { contentId: parsed.contentId ?? null, topic: parsed.topic ?? null });

    try {
      let slideData: { title?: string; text?: string; imageUrl?: string | null; durationSec?: number | null }[] =
        parsed.slides ?? [];

      if (slideData.length === 0 && parsed.topic && (parsed.generateSlides ?? true)) {
        const ideas = await generateSlideIdeas(parsed.topic);
        slideData = ideas.map((i) => ({ title: i.title, text: i.text, durationSec: 3 }));
      }

      if (slideData.length === 0) {
        await finishJob(job.id, false, undefined, "Nessuna slide fornita.");
        return { ok: false, message: "Fornisci le slide oppure un topic con generateSlides=true." };
      }

      let contentId: string;
      if (parsed.contentId) {
        const existing = await getContentOrThrow(parsed.contentId);
        await prisma.$transaction(
          async (tx) => {
            await tx.content.update({
              where: { id: existing.id },
              data: {
                type: "CAROUSEL",
                title: parsed.title ?? existing.title,
                platforms: parsed.platforms
                  ? {
                      deleteMany: { contentId: existing.id },
                      create: parsed.platforms.map((p) => ({ platform: p, accountId: null })),
                    }
                  : undefined,
              },
            });
            await tx.carouselSlide.deleteMany({ where: { contentId: existing.id } });
            await tx.carouselSlide.createMany({
              data: slideData.map((s, i) => ({
                contentId: existing.id,
                title: s.title ?? null,
                text: s.text ?? null,
                imageUrl: s.imageUrl ?? null,
                order: i + 1,
              })),
            });
          },
          { timeout: 15_000 }
        );
        contentId = existing.id;
      } else {
        const content = await createContent({
          type: "CAROUSEL",
          title: parsed.title ?? `Carousel ${parsed.topic ?? "nuovo"}`,
          platforms: parsed.platforms,
          slides: slideData.map((s, i) => ({
            title: s.title ?? null,
            text: s.text ?? null,
            imageUrl: s.imageUrl ?? null,
            order: i + 1,
          })),
        });
        contentId = content.id;
      }

      const content = await getContentOrThrow(contentId);

      await finishJob(job.id, true, {
        contentId: content.id,
        slideCount: slideData.length,
      });
      await logAudit("CAROUSEL_UPDATED", "Content", content.id, { slideCount: slideData.length });
      return {
        ok: true,
        message: `Carousel "${content.title}" aggiornato con ${slideData.length} slide (id ${content.id}).`,
        data: { contentId: content.id, slides: slideData },
      };
    } catch (e) {
      await finishJob(job.id, false, undefined, String(e));
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const generateVideoTool: AiTool = {
  name: "generateVideo",
  description:
    "Genera un video/reel (slideshow) locale dalle immagini delle slide del contenuto, usando ffmpeg. Aggrega il video al contenuto e lo imposta come tipo VIDEO. Richiede che il contenuto abbia slide con immagini.",
  brief: "Generazione video",
  schema: z.object({
    contentId: z.string().describe("Id del contenuto con slide/immagini"),
    durationPerSlide: z.number().min(1).max(15).optional().describe("Durata di ogni slide in secondi"),
  }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string(), durationPerSlide: z.number().optional() }).parse(args);
    const content = await getContentOrThrow(parsed.contentId);

    const slides = content.slides.filter((s) => s.imageUrl);
    if (slides.length === 0) {
      return {
        ok: false,
        message: "Nessuna immagine nelle slide: il contenuto deve avere almeno una slide con immagine per generare il video.",
      };
    }

    const job = await recordJob("VIDEO", { contentId: content.id, slides: slides.length });
    const video = getVideoProvider();

    try {
      if (!video.canGenerate) {
        throw new VideoGenerationUnavailableError(
          "Generatore video non disponibile (VIDEO_PROVIDER non abilitato o ffmpeg mancante)."
        );
      }
      const gen = await video.generateSlideshow(
        slides.map((s) => ({
          imagePath: s.imageUrl!,
          durationSec: parsed.durationPerSlide ?? (slides.length > 1 ? 3 : 5),
        })),
        { width: 1080, height: 1920, fps: 25 }
      );

      const asset = await createAsset({
        url: gen.url,
        filename: gen.url.split("/").pop() ?? "reel.mp4",
        mimeType: "video/mp4",
        kind: "VIDEO",
        contentId: content.id,
      });

      const updated = await updateContent(content.id, {
        type: "VIDEO",
        scheduledDate: null,
      });

      await finishJob(job.id, true, { url: gen.url, durationSec: gen.durationSec, assetId: asset.id });
      await logAudit("VIDEO_GENERATED", "ContentAsset", asset.id, { contentId: content.id, durationSec: gen.durationSec });
      return {
        ok: true,
        message: `Video generato (${gen.durationSec}s): ${gen.url}`,
        data: { contentId: updated.id, url: gen.url, durationSec: gen.durationSec, assetId: asset.id },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await finishJob(job.id, false, undefined, message);
      return { ok: false, message };
    }
  },
};