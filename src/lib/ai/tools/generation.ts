import { z } from "zod";
import { ContentType } from "@prisma/client";
import { generateWithBrand, recordJob, finishJob, tryParseJson } from "@/lib/ai/generate";
import { getContent, updateContent } from "@/lib/services/content";
import { getImageProvider } from "@/lib/images/factory";
import { MAGNIFIC_ASPECT_RATIOS } from "@/lib/images/magnific";
import { createAsset } from "@/lib/services/media";
import { deleteUploadedFile } from "@/lib/uploads";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { friendlyMessage } from "@/lib/errors/user-message";
import { AiTool } from "@/lib/ai/tools/types";
import { platformsField } from "@/lib/ai/tools/schemas";
import { cleanHashtags } from "@/lib/ai/content-copy";

export const generateCaptionTool: AiTool = {
  name: "generateCaption",
  description:
    "Genera SOLO il testo (caption) di un post, con relativi hashtag. Usalo solo su richiesta esplicita di caption/testo, oppure per riscrivere il testo di un contenuto esistente (contentId). Non usarlo come passaggio per creare un contenuto: se l'utente chiede di creare un post, un reel o un contenuto, usa createContent, che genera caption, hashtag e visual. Esempio: {\"contentId\": \"abc\", \"topic\": \"weekend a Parigi\"}.",
  brief: "Generazione caption",
  schema: z.object({
    contentId: z.string().optional().describe("Id contenuto su cui generare"),
    topic: z.string().optional().describe("Argomento se non c'è un contentId"),
    type: z.enum(["POST", "CAROUSEL", "VIDEO"]).optional(),
    platforms: platformsField.optional(),
    save: z.boolean().optional().describe("Salvare la caption sul contenuto (default true se contentId presente)"),
  }),
  execute: async (args) => {
    const parsed = z.object({
      contentId: z.string().optional(),
      topic: z.string().optional(),
      type: z.enum(["POST", "CAROUSEL", "VIDEO"]).optional(),
      platforms: platformsField.optional(),
      save: z.boolean().optional(),
    }).parse(args);

    let topic = parsed.topic ?? null;
    let title = `Post su ${topic ?? "argomento generico"}`;
    let target = null;

if (parsed.contentId) {
      target = await getContent(parsed.contentId);
      if (!target) return { ok: false, message: "Il contenuto indicato non esiste." };
      topic = topic ?? target.title ?? target.caption?.slice(0, 80) ?? "argomento generico";
      title = target.title ?? title;
    }
    if (!topic) return { ok: false, message: "Indica un topic o un contentId." };

    const platformTxt = parsed.platforms?.length ? `Piattaforme: ${parsed.platforms.join(", ")}. ` : "";
    const typeTxt = (parsed.type ?? target?.type ?? "POST") as ContentType;

    const job = await recordJob("CAPTION", { contentId: target?.id ?? null, topic, type: typeTxt });

    try {
      const raw = await generateWithBrand({
        jsonMode: true,
        temperature: 0.8,
        system:
          "Sei il copywriter di un'agenzia di viaggi. Scrivi caption in italiano, autentiche e accattivanti, adatte alla piattaforma di pubblicazione. Rispetta il tono e lo stile del brand descritto nel contesto. Evita le parole/argomenti vietati. Non usare menzioni o link non forniti. CTA coerente con quelle preferite dal brand. VINCOLO SEMANTICO: l'argomento indicato è l'unico tema consentito: non introdurre né nominare altre destinazioni, città, regioni o spiagge, nemmeno come paragone.",
        user: `Scrivi una caption per un contenuto di tipo ${typeTxt} dal tema: "${topic}". ${platformTxt}La caption deve essere pronta da pubblicare (senza hashtag nella caption). Tutto il testo deve riguardare esclusivamente "${topic}". Rispondi SOLO con JSON: {"caption": "testo", "hashtags": "elenco hashtag separati da spazio (8-20, attinenti al viaggio e al brand)"}`,
      });

      const json = tryParseJson(raw);
      if (!json) {
        await finishJob(job.id, false, undefined, "Risposta AI non valida");
        return { ok: false, message: "L'AI non ha prodotto una caption valida. Riprova." };
      }
      const caption = String(json.caption ?? "").trim();
      const hashtags = cleanHashtags(String(json.hashtags ?? ""));

      let savedId: string | null = target?.id ?? null;
      if (target && (parsed.save ?? true)) {
        const updated = await updateContent(target.id, { caption, hashtags });
        savedId = updated.id;
      } else if (!target) {
        const created = await (
          await import("@/lib/services/content")
        ).createContent({
          type: typeTxt,
          title: title,
          caption,
          hashtags,
          platforms: parsed.platforms,
        });
        savedId = created.id;
      }

      await finishJob(job.id, true, { caption, hashtags });
      await logAudit("CAPTION_GENERATED", "Content", savedId, { topic });
      return {
        ok: true,
        message: `Caption generata${savedId ? " e salvata sul contenuto" : ""}: "${caption.slice(0, 120)}${caption.length > 120 ? "…" : ""}"`,
        data: { contentId: savedId, caption, hashtags },
      };
    } catch (e) {
      logAIError("tool.generateCaption", { contentId: target?.id ?? null }, e);
      await finishJob(job.id, false, undefined, String(e));
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};

export const generateHashtagsTool: AiTool = {
  name: "generateHashtags",
  description:
    "Genera SOLO hashtag. Usalo solo su richiesta esplicita di hashtag, oppure per aggiornare gli hashtag di un contenuto esistente (contentId). Non creare contenuti e non usarlo come passaggio per creare un post, un reel o un contenuto: in quel caso usa createContent, che genera caption, hashtag e visual.",
  brief: "Generazione hashtag",
  schema: z.object({
    contentId: z.string().optional(),
    topic: z.string().optional(),
    count: z.number().int().min(5).max(30).optional(),
    save: z.boolean().optional(),
  }),
  execute: async (args) => {
    const parsed = z.object({
      contentId: z.string().optional(),
      topic: z.string().optional(),
      count: z.number().int().min(5).max(30).optional(),
      save: z.boolean().optional(),
    }).parse(args);

    let topic = parsed.topic ?? null;
    let targetId: string | null = null;
    if (parsed.contentId) {
      const content = await getContent(parsed.contentId);
      if (!content) return { ok: false, message: "Il contenuto indicato non esiste." };
      targetId = content.id;
      topic = topic ?? content.title ?? "viaggi";
    }
    if (!topic) return { ok: false, message: "Indica un topic o un contentId." };

    const job = await recordJob("HASHTAGS", { contentId: targetId, topic, count: parsed.count ?? 12 });
    try {
      const raw = await generateWithBrand({
        jsonMode: true,
        temperature: 0.6,
        system:
          "Sei un esperto di social media per agenzie di viaggio. Genera hashtag pertinenti, mixando tag generici (viaggi, spiaggia, mare) e specifici della destinazione. Solo parole chiave, senza doppi o irrilevanti.",
        user: `Genera circa ${parsed.count ?? 12} hashtag per il tema "${topic}". Rispondi SOLO con JSON: {"hashtags": "tag1 tag2 tag3 ..."}`,
      });
      const json = tryParseJson(raw);
      if (!json) {
        await finishJob(job.id, false, undefined, "Risposta AI non valida");
        return { ok: false, message: "L'AI non ha prodotto hashtag validi." };
      }
      const hashtags = cleanHashtags(String(json.hashtags ?? ""));
      if (targetId && (parsed.save ?? true)) {
        await updateContent(targetId, { hashtags });
      }
      await finishJob(job.id, true, { hashtags });
      return { ok: true, message: `Hashtag generati (${hashtags.split(" ").length}): ${hashtags}`, data: { contentId: targetId, hashtags } };
    } catch (e) {
      logAIError("tool.generateHashtags", { contentId: targetId }, e);
      await finishJob(job.id, false, undefined, String(e));
      return { ok: false, message: friendlyMessage(e) };
    }
  },
};

export const generateImageTool: AiTool = {
  name: "generateImage",
  description:
    "Genera un'immagine da un prompt di testo usando il provider immagini configurato (Magnific/Mystic), attende il completamento, la scarica e la salva come asset nella Media Library. ok:true solo se l'immagine è stata realmente generata e salvata; se il provider o il salvataggio falliscono restituisce ok:false con l'errore reale. Non dichiamare mai l'immagine generata senza ok:true. Se passi contentId, l'immagine viene collegata a quel contenuto come ContentAsset. Esempio: {\"prompt\": \"Coppia romantica che cammina sulla Senna al tramonto a Parigi, atmosfera vintage, luci calde\", \"contentId\": \"abc\", \"aspectRatio\": \"square_1_1\"}.",
  brief: "Generazione immagine",
  schema: z.object({
    prompt: z
      .string()
      .min(1)
      .max(1000)
      .describe("Descrizione dettagliata dell'immagine da generare (max 1000 caratteri)"),
    contentId: z.string().optional().describe("Contenuto a cui collegare l'immagine generata"),
    aspectRatio: z
      .enum(MAGNIFIC_ASPECT_RATIOS)
      .optional()
      .describe("Formato dell'immagine (default square_1_1)"),
    resolution: z
      .enum(["1k", "2k", "4k"])
      .optional()
      .describe("Risoluzione dell'immagine (default 1k)"),
  }),
  execute: async (args) => {
    const parsed = z.object({
      prompt: z.string().min(1).max(1000),
      contentId: z.string().optional(),
      aspectRatio: z.enum(MAGNIFIC_ASPECT_RATIOS).optional(),
      resolution: z.enum(["1k", "2k", "4k"]).optional(),
    }).parse(args);

    const provider = getImageProvider();

    if (!provider.canGenerate) {
      return {
        ok: false,
        message:
          "Generatore immagini non configurato (IMAGE_PROVIDER=manual). Configura il provider Magnific per generare immagini, oppure carica manualmente l'immagine dalla Media Library.",
      };
    }

    const job = await recordJob("IMAGE", {
      contentId: parsed.contentId ?? null,
      prompt: parsed.prompt,
      aspectRatio: parsed.aspectRatio ?? null,
      resolution: parsed.resolution ?? "1k",
    });

    try {
      const gen = await provider.generateImage(parsed.prompt, {
        contentId: parsed.contentId,
        aspectRatio: parsed.aspectRatio,
        resolution: parsed.resolution,
      });

      let asset;
      try {
        asset = await createAsset({
          url: gen.url,
          filename: gen.url.split("/").pop() ?? "magnific-image.png",
          mimeType: gen.mimeType ?? "image/png",
          size: gen.size ?? null,
          kind: "IMAGE",
          contentId: parsed.contentId ?? null,
          metadata: {
            provider: gen.provider,
            prompt: parsed.prompt,
            sourceUrl: gen.sourceUrl ?? gen.url,
            aspectRatio: parsed.aspectRatio ?? null,
            resolution: parsed.resolution ?? "1k",
          },
        });
      } catch (e) {
        await deleteUploadedFile(gen.url).catch(() => {});
        throw e;
      }

      await finishJob(job.id, true, { url: gen.url, assetId: asset.id });
      await logAudit("IMAGE_GENERATED", "ContentAsset", asset.id, {
        contentId: parsed.contentId,
        provider: gen.provider,
      });
      return {
        ok: true,
        message:
          `Immagine generata e salvata nella Media Library.` +
          `${parsed.contentId ? " Collegata al contenuto indicato." : ""}`,
        data: { assetId: asset.id, url: gen.url, provider: gen.provider },
      };
    } catch (e) {
      // Il dettaglio dell'errore — endpoint, chiave, codice del provider —
      // resta nel job e nel log: la frase che l'utente legge dice solo che
      // l'operazione non è riuscita.
      logAIError("tool.generateImage", { contentId: parsed.contentId ?? null }, e);
      const message = friendlyMessage(e, "Non sono riuscito a generare l'immagine. Riprova.");
      await finishJob(job.id, false, undefined, String(e));
      return { ok: false, message, data: null };
    }
  },
};