import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateWithBrand, recordJob, finishJob, tryParseJson } from "@/lib/ai/generate";
import { getContent, getContentOrThrow, createContent } from "@/lib/services/content";
import { generateVideoForContent } from "@/lib/services/video";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { friendlyMessage } from "@/lib/errors/user-message";
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
        message: `Carousel "${content.title}" aggiornato con ${slideData.length} slide.`,
        data: { contentId: content.id, slides: slideData },
      };
    } catch (e) {
      await finishJob(job.id, false, undefined, String(e));
      logAIError("tool.createCarousel", { tool: "createCarousel" }, e);
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};

export const generateVideoTool: AiTool = {
  name: "generateVideo",
  description:
    "Genera il video/reel (slideshow) di un contenuto GIÀ esistente, usando ffmpeg: fotogrammi dalle slide con immagine o dagli asset immagine (incluse le immagini di una proposta di catalogo, che vengono scaricate automaticamente). NON crea contenuti nuovi e richiede un contentId REALE, preso da createContent o listContents. Per creare un VIDEO da una destinazione (es. 'crea un video per Zanzibar') usa createContent con type: \"VIDEO\", che crea la bozza e genera già il video da solo. Imposta il contenuto come tipo VIDEO e vi collega la locandina. ATTENZIONE: richiede VIDEO_PROVIDER/ffmpeg configurato; se risponde che la generazione non è disponibile NON ritentare e non inventare strumenti alternativi: la bozza VIDEO si completa caricando il file video dall'editor o collegandone uno dalla libreria con attachVideo.",
  brief: "Generazione video",
  schema: z.object({
    contentId: z.string().describe("Id del contenuto con slide/immagini"),
    durationPerSlide: z.number().min(1).max(15).optional().describe("Durata di ogni immagine in secondi"),
    query: z.string().optional().describe("Parole chiave della destinazione: con poche immagini sul contenuto, la Media Library viene cercata per aggiungere scene al reel"),
  }),
  execute: async (args) => {
    try {
      const parsed = z.object({ contentId: z.string(), durationPerSlide: z.number().optional(), query: z.string().optional() }).parse(args);

      // Il tool richiede un contenuto ESISTENTE: un id inventato (es. il titolo
      // della destinazione) non è un contenuto, e va guidato verso createContent
      // invece di far girare l'ennesima eccezione "Contenuto non trovato".
      if (!(await getContent(parsed.contentId))) {
        return {
          ok: false,
          message: `Il contenuto "${parsed.contentId}" non esiste. Per creare un VIDEO da una destinazione (es. "crea un video per Zanzibar") usa createContent con type: "VIDEO", senza contentId: questo tool serve solo per contenuti già creati.`,
        };
      }

    // L'orchestrazione (fotogrammi, download delle immagini remote, provider,
    // asset, locandina) sta tutta nel servizio: qui restano solo il job e il
    // rendiconto per il modello.
    const job = await recordJob("VIDEO", { contentId: parsed.contentId });
    const result = await generateVideoForContent(parsed);

    if (!result.ok) {
      await finishJob(job.id, false, undefined, result.reason);
      return { ok: false, message: result.reason };
    }

    await finishJob(job.id, true, {
      url: result.url,
      durationSec: result.durationSec,
      assetId: result.assetId,
      posterAssetId: result.posterAssetId,
    });
    return {
      ok: true,
      // Il file generato resta in `data`, dove il modello e il chiamante lo
      // trovano: la frase per l'utente non contiene il percorso, perché un
      // percorso di file è un dettaglio della macchina e non una risposta.
      message: `Video generato (${result.durationSec}s) e collegato al contenuto${result.posterAssetId ? ", con la locandina" : ""}.`,
      data: {
        contentId: parsed.contentId,
        url: result.url,
        durationSec: result.durationSec,
        assetId: result.assetId,
        posterAssetId: result.posterAssetId,
        provider: result.provider,
      },
    };
    } catch (e) {
      logAIError("tool.generateVideo", { tool: "generateVideo" }, e);
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};