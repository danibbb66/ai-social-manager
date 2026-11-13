import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MontageClip, VideoProvider } from "@/lib/video/provider";
import { getVideoProvider } from "@/lib/video/factory";
import { extractVideoFrame, probeVideoDurationSec } from "@/lib/video/ffmpeg";
import { deleteUploadedFile, saveUploadedFile, uploadedFileExists } from "@/lib/uploads";
import { materialize, publicUrlFor, isCloudStorage, listKeys } from "@/lib/storage";
import { logAIError } from "@/lib/logger";
import { config } from "@/lib/env";
import { createAsset, linkAsset } from "@/lib/services/media";
import { getContent, getContentOrThrow } from "@/lib/services/content";
import { getBrand } from "@/lib/services/brand";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { friendlyMessage } from "@/lib/errors/user-message";

/**
 * Servizio video: generazione del reel e locandina di copertina.
 *
 * Qui sta tutta l'orchestrazione che prima era dispersa nel tool AI: scelta
 * dei fotogrammi, materializzazione dei file locali (le immagini del catalogo
 * sono URL remoti e ffmpeg non può leggerle), creazione dell'asset VIDEO e
 * locandina di copertina. I tool AI orchestrano e basta, come per il visual
 * del catalogo: ripetere la logica nei tool darebbe due versioni della stessa
 * pipeline da tenere allineate.
 */

export type GenerateVideoResult =
  | {
      ok: true;
      url: string;
      durationSec: number;
      assetId: string;
      provider: string;
      posterAssetId: string | null;
    }
  | {
      ok: false;
      /** Frase già pronta per l'utente: niente dettagli interni. */
      reason: string;
    };

export type VideoPosterResult =
  | { ok: true; assetId: string; created: boolean }
  | { ok: false; reason: string };

function filenameFromUrl(url: string): string {
  const clean = url.split("?")[0];
  return clean.split("/").pop() || "video.mp4";
}

/**
 * Imposta il tipo VIDEO (e disarma la programmazione) senza toccare le
 * piattaforme.
 *
 * `updateContent` cancella SEMPRE le piattaforme del contenuto e le ricrea
 * solo se riceve l'elenco: una chiamata senza `platforms` le azzererebbe, e
 * il reel perderebbe la distribuzione dichiarata dall'utente. Il tipo si
 * cambia quindi con un update mirato.
 */
export async function markContentAsVideo(contentId: string): Promise<void> {
  await prisma.content.update({
    where: { id: contentId },
    data: { type: "VIDEO", scheduledDate: null },
  });
}

const MAX_TOTAL_SECONDS = 20;

/**
 * Risolve l'input di una clip per ffmpeg/ffprobe.
 *
 * In cloud (Vercel) la clip si passa come URL pubblico di R2: ffmpeg/ffprobe
 * leggono via HTTP con richieste "range", scaricando solo i ~3s necessari
 * invece dell'intero file (le clip curate arrivano anche a 140MB). In locale
 * resta il materialize sul percorso del disco.
 */
async function clipInputPath(ref: string): Promise<string> {
  if (isCloudStorage()) return publicUrlFor(ref);
  return materialize(ref);
}

/** Percorso locale del logo del brand, se caricato in Media Library. */
async function brandLogoPath(): Promise<string | null> {
  try {
    const brand = await getBrand();
    const logoUrl = brand?.logoUrl?.trim();
    if (!logoUrl) return null;
    if (!(await uploadedFileExists(logoUrl))) return null;
    return await materialize(logoUrl);
  } catch {
    return null;
  }
}

/**
 * Traccia musicale per il sottofondo del reel, se disponibile.
 *
 * Ordine di risoluzione:
 * 1. `VIDEO_MUSIC_FILE` (percorso assoluto o `/uploads/...`), se esiste;
 * 2. rotazione automatica tra le tracce della chiave `audio/` (vedi sotto);
 * 3. il primo asset `AUDIO` in Media Library con file ancora su disco;
 * 4. `null` → video senza audio (il provider degrada a `-an`).
 *
 * Nessuna musica viene scaricata da Internet né hardcodata: senza una fonte
 * l'audio viene semplicemente omesso, senza rompere la generazione. La
 * risoluzione non deve MAI far fallire il reel: ogni errore interno ricade su
 * `null`.
 */
/** Ogni "giro" completo di tracce sposta l'inizio della musica di 30s. */
const AUDIO_ROTATION_STEP_SEC = 30;

async function resolveBackgroundMusic(): Promise<{
  path: string | null;
  volume: number;
  offsetSec: number;
}> {
  const rawVolume = Number(process.env.VIDEO_MUSIC_VOLUME ?? "0.2");
  const volume = Number.isFinite(rawVolume) ? Math.min(1, Math.max(0, rawVolume)) : 0.2;

  const envFile = process.env.VIDEO_MUSIC_FILE?.trim();
  if (envFile) {
    try {
      const abs = await materialize(envFile);
      await fs.access(abs);
      return { path: abs, volume, offsetSec: 0 };
    } catch {
      console.warn(`[video] VIDEO_MUSIC_FILE non trovato su disco: ${envFile}`);
    }
  }

  // Colonne sonore multiple (priorità): ROTAZIONE deterministica tra TUTTI i
  // file audio sotto la chiave `audio/` (.mp3/.m4a/.wav/.aac/.ogg). In locale
  // è `public/audio/`, in cloud la stessa chiave nel bucket R2.
  // Il video N-esimo usa la traccia (N % numero tracce); esaurito un giro
  // completo, la musica parte AUDIO_ROTATION_STEP_SEC secondi più avanti, e
  // così via: stessa playlist, punti di inizio sempre diversi. L'indice di
  // rotazione è il numero di reel già generati (asset VIDEO sul DB), quindi
  // dopo un reset dei contenuti la rotazione riparte da capo, in linea col
  // riutilizzo dei media curati.
  try {
    const keys = (await listKeys("audio"))
      .filter((k) => /\.(m4a|mp3|wav|aac|ogg)$/i.test(k))
      .sort();
    if (keys.length > 0) {
      const videosGenerated = await prisma.contentAsset.count({
        where: { kind: "VIDEO" },
      });
      const picked = keys[videosGenerated % keys.length];
      const round = Math.floor(videosGenerated / keys.length);
      const abs = await materialize(picked);

      // Offset di partenza nella traccia: 0 al primo giro, 30s al secondo...
      // Limitato alla durata reale (ffprobe) così l'audio copre sempre tutto
      // il video; se la traccia è troppo corta si riparte da 0.
      let offsetSec = round * AUDIO_ROTATION_STEP_SEC;
      const duration = await probeVideoDurationSec(abs);
      if (duration != null) {
        const usable = Math.floor(duration - 16);
        offsetSec = usable > 0 ? offsetSec % usable : 0;
      } else {
        offsetSec = 0;
      }
      return { path: abs, volume, offsetSec };
    }
  } catch {
    // nessuna traccia: si prosegue con il fallback qui sotto
  }

  try {
    const audios = await prisma.contentAsset.findMany({
      where: { kind: "AUDIO" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    for (const asset of audios) {
      if (!(await uploadedFileExists(asset.url))) continue;
      return { path: await materialize(asset.url), volume, offsetSec: 0 };
    }
  } catch (e) {
    logAIError("video.audio.resolve", {}, e);
  }

  return { path: null, volume, offsetSec: 0 };
}

/** Una clip scelta a mano dall'utente per il montaggio manuale. */
export interface ManualClipInput {
  /** Chiave di storage della clip curata (es. curated/videos/bali/beach.mp4). */
  key: string;
  /** Secondo della clip da cui partire. */
  startSec: number;
  /** Secondo della clip in cui finire (deve essere > startSec). */
  endSec: number;
  /** Scritta opzionale mostrata in basso su questa clip. */
  caption?: string | null;
}

/**
 * Montaggio manuale: l'utente sceglie clip, ordine, durata e scritte per clip.
 *
 * A differenza del flusso automatico (che seleziona e interleava le clip da
 * solo), qui l'ordine e i contenuti sono quelli dichiarati dall'utente, uno a
 * uno: la cover riceve titolo+logo, ogni scena la propria eventuale scritta.
 * Il rendering riusa lo stesso provider ffmpeg e la stessa persistenza.
 */
export async function generateManualVideoForContent(input: {
  contentId: string;
  /** Titolo della copertina (di norma il nome della destinazione). */
  title: string;
  /** Clip nell'ordine scelto dall'utente. */
  clips: ManualClipInput[];
  /** Preset di stile delle scritte ("bold" | "regular" | "italic" | "uppercase"). */
  font?: string;
  /** Colore del testo delle scritte (hex). Default bianco. */
  captionColor?: string | null;
  /** Colore del titolo (hex). Assente → gradiente automatico dello stile del brand. */
  titleColor?: string | null;
}): Promise<GenerateVideoResult> {
  const content = await getContentOrThrow(input.contentId);
  const provider = getVideoProvider();

  if (!provider.generateMontage) {
    return { ok: false, reason: "Generazione video non disponibile su questa configurazione." };
  }

  const clips = input.clips.filter(
    (c) => c.key && c.endSec > c.startSec && /^curated\/videos\/[a-z0-9_]+\/.+$/.test(c.key)
  );
  if (clips.length === 0) {
    return { ok: false, reason: "Nessuna clip selezionata per il montaggio." };
  }

  const logoPath = await brandLogoPath();
  const title = input.title.trim();

  const montageClips: MontageClip[] = [];
  const usedKeys: string[] = [];
  for (const [i, c] of clips.entries()) {
    const abs = await clipInputPath(c.key);
    const start = Math.max(0, Math.round(c.startSec || 0));
    const end = Math.max(start + 1, Math.round(c.endSec || start + 1));
    const dur = Math.min(30, end - start);
    const caption = c.caption?.trim();
    montageClips.push({
      path: abs,
      type: "video",
      trimStartSec: start,
      sceneSeconds: dur,
      overlay: i === 0 ? { title, logoPath, titleColor: input.titleColor ?? null } : null,
      caption: caption
        ? {
            text: caption,
            font: input.font ?? "bold",
            color: input.captionColor ?? null,
          }
        : null,
    });
    usedKeys.push(c.key);
  }

  const audio = await resolveBackgroundMusic();

  let generated;
  try {
    generated = await provider.generateMontage!(montageClips, {
      width: config.videoWidth,
      height: config.videoHeight,
      fps: 25,
      audioPath: audio.path,
      audioVolume: audio.volume,
      audioOffsetSec: audio.offsetSec,
    });
  } catch (e) {
    logAIError("video.manual", { contentId: content.id, clips: clips.length }, e);
    await logAudit("VIDEO_GENERATION_FAILED", "Content", content.id, {
      phase: "render",
      clips: clips.length,
      reason: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: friendlyMessage(e) };
  }

  if (!(await uploadedFileExists(generated.url))) {
    logAIError(
      "video.manual.verify",
      { contentId: content.id, url: generated.url },
      new Error("il provider ha dichiarato successo ma il file di output non esiste")
    );
    return {
      ok: false,
      reason: "La generazione non ha prodotto un file utilizzabile: nulla è stato salvato. Riprova.",
    };
  }

  let asset;
  try {
    asset = await createAsset({
      url: generated.url,
      filename: filenameFromUrl(generated.url),
      mimeType: "video/mp4",
      kind: "VIDEO",
      contentId: content.id,
      metadata: { curatedKeys: usedKeys },
    });
    await markContentAsVideo(content.id);
  } catch (e) {
    if (asset) {
      await prisma.contentAsset.delete({ where: { id: asset.id } }).catch(() => undefined);
    }
    await deleteUploadedFile(generated.url).catch(() => undefined);
    logAIError("video.manual.persist", { contentId: content.id, url: generated.url }, e);
    await logAudit("VIDEO_GENERATION_FAILED", "Content", content.id, {
      phase: "persist",
      detail: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      reason: "Salvataggio del video non riuscito: nessun asset è stato scritto. Riprova.",
    };
  }

  const poster = await ensureVideoPoster(content.id, generated.pathname);

  if (isCloudStorage()) {
    await fs.rm(generated.pathname, { force: true }).catch(() => undefined);
  }

  await logAudit("VIDEO_GENERATED", "ContentAsset", asset.id, {
    contentId: content.id,
    durationSec: generated.durationSec,
    clips: clips.length,
    posterAssetId: poster.ok ? poster.assetId : null,
  });

  return {
    ok: true,
    url: generated.url,
    durationSec: generated.durationSec,
    assetId: asset.id,
    provider: generated.provider,
    posterAssetId: poster.ok ? poster.assetId : null,
  };
}

/**
 * Assicura che il contenuto VIDEO abbia una locandina (copertina) IMAGE.
 *
 * Instagram e le anteprime dell'interfaccia mostrano un fotogramma statico:
 * un VIDEO senza locandina nasce "cieco". La locandina non viene generata con
 * provider esterni: è la prima immagine già disponibile sul contenuto, oppure
 * la prima immagine della proposta di catalogo collegata, creata come asset
 * IMAGE con `metadata.role: "POSTER"`. Se il contenuto ha già un'immagine
 * quella fa da locandina e non viene scritto nulla.
 */
export async function ensureVideoPoster(
  contentId: string,
  /** Percorso locale del video appena generato (cloud): usato per estrarre il
   * frame-0 senza ri-scaricare l'intero file da R2. Omesso → materialize. */
  localVideoPath?: string
): Promise<VideoPosterResult> {
  const content = await getContent(contentId);
  if (!content) throw new Error(`Contenuto non trovato (${contentId}).`);

  const existingImage = content.assets.find((a) => a.kind === "IMAGE");
  if (existingImage) {
    return { ok: true, assetId: existingImage.id, created: false };
  }

  // La locandina è un abbellimento, non una garanzia: un errore qui non deve
  // risalire fino a far sembrare fallita una generazione riuscita. Si logga e
  // si dichiara, il chiamante decide.
  try {
    return await ensureVideoPosterInner(content, localVideoPath);
  } catch (e) {
    logAIError("video.poster", { contentId }, e);
    return {
      ok: false,
      reason: "Collegamento della locandina non riuscito: vedi i log server-side.",
    };
  }
}

async function ensureVideoPosterInner(
  content: NonNullable<Awaited<ReturnType<typeof getContent>>>,
  localVideoPath?: string
): Promise<VideoPosterResult> {
  const usedUrls = new Set(content.assets.map((a) => a.url));
  const candidates: { url: string; filename: string; origin: string; id?: string }[] = [];

  for (const slide of content.slides) {
    if (slide.imageUrl && !usedUrls.has(slide.imageUrl)) {
      usedUrls.add(slide.imageUrl);
      candidates.push({
        url: slide.imageUrl,
        filename: slide.imageUrl.split("/").pop() || "poster.jpg",
        origin: "slide",
      });
    }
  }

  if (content.catalogProposalId) {
    const proposal = await prisma.catalogProposal.findUnique({
      where: { id: content.catalogProposalId },
      include: { images: { orderBy: { acquiredAt: "asc" as const } } },
    });
    for (const image of proposal?.images ?? []) {
      if (!usedUrls.has(image.url)) {
        usedUrls.add(image.url);
        candidates.push({
          url: image.url,
          filename: image.filename,
          origin: "catalog-proposal",
          id: image.id,
        });
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: estrai il primo frame del video (porta titolo + logo composti
    // dal montaggio) come locandina, così anteprime ed editor social hanno una
    // copertina reale e non un frame casuale scelto da Meta.
    const videoAsset = content.assets.find((a) => a.kind === "VIDEO");
    if (videoAsset) {
      try {
        // In cloud il file video è già a terra dopo la generazione
        // (`publishOutput` con keepLocal): lo si riusa per il frame-0 invece
        // di ri-scaricarlo interamente da R2 (risparmia decine di secondi sul
        // tetto dei 60s di Vercel). Fallisce in modo silenzioso: se il file
        // non c'è più, si ricade su materialize.
        const localVideo =
          localVideoPath ?? (await materialize(videoAsset.url));
        const framePath = path.join(
          os.tmpdir(),
          `asm-poster-${content.id}-${Date.now()}.jpg`
        );
        await extractVideoFrame(localVideo, framePath, 0);
        const buffer = await fs.readFile(framePath);
        const saved = await saveUploadedFile({
          buffer,
          originalName: `poster-${content.id}.jpg`,
          mimeType: "image/jpeg",
        });
        await fs.rm(framePath, { force: true }).catch(() => {});
        const created = await createAsset({
          url: saved.url,
          filename: saved.url.split("/").pop() || "poster.jpg",
          kind: "IMAGE",
          contentId: content.id,
          metadata: { role: "POSTER", source: "video-frame" },
        });
        await logAudit("VIDEO_POSTER_SET", "ContentAsset", created.id, {
          contentId: content.id,
          source: "video-frame",
        });
        return { ok: true, assetId: created.id, created: true };
      } catch (e) {
        logAIError("video.poster.frame", { contentId: content.id }, e);
      }
    }
    return {
      ok: false,
      reason:
        "Nessuna immagine disponibile per la locandina: carica una copertina o collega una proposta del catalogo.",
    };
  }

  const poster = candidates[0];

  // Se lo stesso file è già in Media Library come asset scollegato, lo si
  // collega invece di creare una riga gemella: un file, un asset.
  const reusable = await prisma.contentAsset.findFirst({
    where: { url: poster.url, contentId: null },
    select: { id: true },
  });
  if (reusable) {
    const linked = await linkAsset(reusable.id, content.id);
    await logAudit("VIDEO_POSTER_SET", "ContentAsset", linked.id, {
      contentId: content.id,
      source: poster.origin,
      reused: true,
    });
    return { ok: true, assetId: linked.id, created: true };
  }

  const created = await createAsset({
    url: poster.url,
    filename: poster.filename,
    kind: "IMAGE",
    contentId: content.id,
    metadata: {
      role: "POSTER",
      source: poster.origin,
      ...(poster.id ? { catalogImageId: poster.id } : {}),
    },
  });
  await logAudit("VIDEO_POSTER_SET", "ContentAsset", created.id, {
    contentId: content.id,
    source: poster.origin,
  });
  return { ok: true, assetId: created.id, created: true };
}
