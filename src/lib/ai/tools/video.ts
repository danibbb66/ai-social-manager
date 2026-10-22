import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getContentOrThrow } from "@/lib/services/content";
import { getAsset, linkAsset } from "@/lib/services/media";
import { ensureVideoPoster, markContentAsVideo } from "@/lib/services/video";
import { logAudit } from "@/lib/audit";
import { AiTool } from "@/lib/ai/tools/types";

/**
 * Collega un file video già presente nella libreria media a un contenuto.
 *
 * È il percorso "senza ricaricare": un video caricato in Media Library (o
 * rimasto scollegato da un contenuto eliminato) non deve essere ricaricato a
 * mano dall'editor. Il tool lo aggancia al contenuto, imposta il tipo VIDEO e
 * cura la locandina. Se l'utente non indica l'asset, si usa il video più
 * recente non ancora associato: il caso tipico è "collega il video che ho
 * caricato" subito dopo il caricamento.
 */
export const attachVideoTool: AiTool = {
  name: "attachVideo",
  description:
    "Collega un file video già presente nella libreria media a un contenuto e lo imposta come tipo VIDEO, curando anche la locandina. Se non passi assetId usa il video più recente non ancora associato a nessun contenuto. Non serve per i post immagine: per quelli i visual sono già collegati da createContent.",
  brief: "Collegamento video",
  schema: z.object({
    contentId: z.string().describe("Id del contenuto a cui collegare il video"),
    assetId: z
      .string()
      .optional()
      .describe("Id dell'asset video in libreria; se omesso si usa il video scollegato più recente"),
  }),
  execute: async (args) => {
    const parsed = z
      .object({ contentId: z.string(), assetId: z.string().optional() })
      .parse(args);

    const content = await getContentOrThrow(parsed.contentId);

    const asset = parsed.assetId
      ? await getAsset(parsed.assetId)
      : await prisma.contentAsset.findFirst({
          where: { kind: "VIDEO", contentId: null },
          orderBy: { createdAt: "desc" },
        });

    if (!asset) {
      return {
        ok: false,
        message: parsed.assetId
          ? "L'asset indicato non esiste: controlla l'elenco dei file in Media."
          : "Nessun video libero in libreria: carica il file video dall'editor del contenuto (MP4, MOV, WebM) oppure genera un reel con generateVideo.",
        data: { contentId: content.id, requestedAssetId: parsed.assetId ?? null },
      };
    }

    if (asset.kind !== "VIDEO") {
      return {
        ok: false,
        message: "Il file indicato non è un video: serve un asset di tipo VIDEO.",
        data: { contentId: content.id, assetId: asset.id, kind: asset.kind },
      };
    }

    if (asset.contentId === content.id) {
      return {
        ok: true,
        message: "Questo video è già collegato al contenuto: nessuna modifica fatta.",
        data: { contentId: content.id, assetId: asset.id },
      };
    }

    const linked = await linkAsset(asset.id, content.id);
    await markContentAsVideo(content.id);
    const poster = await ensureVideoPoster(content.id);

    await logAudit("VIDEO_ATTACHED", "Content", content.id, {
      assetId: linked.id,
      posterAssetId: poster.ok ? poster.assetId : null,
    });

    return {
      ok: true,
      message: `Video "${linked.filename}" collegato al contenuto e tipo impostato a VIDEO.`,
      data: {
        contentId: content.id,
        assetId: linked.id,
        url: linked.url,
        posterAssetId: poster.ok ? poster.assetId : null,
        posterReason: poster.ok ? null : poster.reason,
      },
    };
  },
};
