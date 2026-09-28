import { getImageProvider } from "@/lib/images/factory";
import { ImageGenerationUnavailableError } from "@/lib/images/provider";
import { createAsset } from "@/lib/services/media";
import { deleteUploadedFile } from "@/lib/uploads";
import { logAudit } from "@/lib/audit";

/**
 * Visual di un contenuto: generazione, salvataggio in Media Library e
 * associazione al Content.
 *
 * Non è una nuova integrazione: riusa l'infrastruttura immagini già presente
 * (`getImageProvider` → Magnific in produzione) e `createAsset`, che è la
 * stessa strada usata dal tool `generateImage` e dall'upload manuale.
 * L'unica differenza è che qui il prompt non arriva dal modello ma è derivato
 * dal contenuto stesso, così il visual è coerente per costruzione.
 */

/** Limite del prompt imposta dal provider (Magnific: 1000 caratteri). */
const MAX_PROMPT_LENGTH = 1000;

/** Suffisso di stile: rende il prompt utilizzabile da un generatore di immagini. */
const VISUAL_STYLE =
  "fotografia di viaggio realistica, luce naturale, composizione professionale, " +
  "alta qualità, senza testo sovrapposto né loghi";

export type VisualOutcome =
  | { status: "created"; assetId: string; url: string; provider: string; prompt: string }
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

function clampText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/**
 * Prompt del visual derivato dal contenuto.
 *
 * Il `topic` (destinazione/argomento richiesto dall'utente) è l'ancora
 * semantica: viene ripetuto come vincolo esplicito perché il generatore non
 * introduca destinazioni diverse. Non viene mai riscritto il contenuto: qui si
 * compone solo la descrizione dell'immagine.
 */
export function buildVisualPrompt(input: {
  topic?: string | null;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
}): string {
  const topic = clampText(input.topic ?? input.title, 160);
  const title = clampText(input.title, 160);
  const caption = clampText(input.caption, 240);
  const hashtags = clampText(input.hashtags, 120);

  const parts = [
    topic ? `Oggetto: ${topic}.` : null,
    title && title.toLowerCase() !== topic.toLowerCase() ? `Titolo del post: ${title}.` : null,
    caption ? `Contesto del post: ${caption}.` : null,
    hashtags ? `Hashtag: ${hashtags}.` : null,
    topic
      ? `La scena deve raffigurare ESCLUSIVAMENTE ${topic}: non introdurre altre destinazioni, città, regioni, spiagge o monumenti.`
      : null,
    VISUAL_STYLE,
  ].filter((p): p is string => Boolean(p));

  const prompt = parts.join(" ");
  return prompt.length > MAX_PROMPT_LENGTH ? prompt.slice(0, MAX_PROMPT_LENGTH) : prompt;
}

/**
 * Genera il visual di un contenuto, lo salva in Media Library e lo collega.
 *
 * Non lancia mai: un fallimento della generazione lascia il contenuto
 * invariato (DRAFT valido, nessun asset parziale, nessun file orfano) e
 * viene riferito come warning. `createAsset` fallendo, il file appena
 * scaricato viene rimosso, quindi non resta nulla a metà.
 */
export async function ensureContentVisual(input: {
  contentId: string;
  topic?: string | null;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  aspectRatio?: string;
  resolution?: "1k" | "2k" | "4k";
  /** Motivo per cui il visual non è richiesto (nessuna generazione eseguita). */
  skipReason?: string | null;
}): Promise<VisualOutcome> {
  if (input.skipReason) {
    return { status: "skipped", reason: input.skipReason };
  }

  const provider = getImageProvider();
  if (!provider.canGenerate) {
    return {
      status: "unavailable",
      reason:
        "Generatore immagini non configurato (IMAGE_PROVIDER=manual): il contenuto resta senza visual e va arricchito dalla Media Library.",
    };
  }

  const prompt = buildVisualPrompt(input);

  try {
    const gen = await provider.generateImage(prompt, {
      contentId: input.contentId,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    });

    let asset;
    try {
      asset = await createAsset({
        url: gen.url,
        filename: gen.url.split("/").pop() ?? "content-visual.png",
        mimeType: gen.mimeType ?? "image/png",
        size: gen.size ?? null,
        kind: "IMAGE",
        contentId: input.contentId,
        metadata: {
          provider: gen.provider,
          prompt,
          sourceUrl: gen.sourceUrl ?? gen.url,
          aspectRatio: input.aspectRatio ?? null,
          resolution: input.resolution ?? "1k",
          origin: "content-creation",
        },
      });
    } catch (e) {
      // Asset non registrato: il file scaricato non deve restare orfano.
      await deleteUploadedFile(gen.url).catch(() => {});
      throw e;
    }

    await logAudit("IMAGE_GENERATED", "ContentAsset", asset.id, {
      contentId: input.contentId,
      provider: gen.provider,
      origin: "content-creation",
    });

    return {
      status: "created",
      assetId: asset.id,
      url: asset.url,
      provider: gen.provider,
      prompt,
    };
  } catch (e) {
    return {
      status: "failed",
      reason:
        e instanceof ImageGenerationUnavailableError || e instanceof Error
          ? e.message
          : String(e),
    };
  }
}
