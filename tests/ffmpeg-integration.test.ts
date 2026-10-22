import { test, after } from "node:test"; // no TLA: il runner trasforma il file
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { createContent, deleteContent, getContent } from "../src/lib/services/content";
import { generateVideoForContent, ensureVideoPoster } from "../src/lib/services/video";
import {
  isVideoGenerationAvailable,
  resolveFfmpegPath,
  resolveFfprobePath,
} from "../src/lib/video/ffmpeg";

/**
 * Integrazione reale con FFmpeg: nessun provider finto.
 *
 * Il test salta da solo se ffmpeg non è disponibile sulla macchina (il check
 * usa la stessa risoluzione del provider: FFMPEG_PATH o comando di sistema).
 * Quando gira, copre l'intera catena: spawn con il binario risolto, percorsi
 * assoluti, encoding reale, file di output verificato, asset VIDEO su database
 * e tipo del contenuto.
 */

const contentIds: string[] = [];
const tempFilePaths: string[] = [];

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeRealPng(relativeUrl: string): Promise<string> {
  const filepath = path.join(process.cwd(), "public", relativeUrl);
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  // PNG 1x1 valido: è l'input minimo che ffmpeg decodifica davvero.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await fs.writeFile(filepath, png);
  tempFilePaths.push(filepath);
  return relativeUrl;
}

after(async () => {
  for (const id of contentIds.splice(0)) {
    await deleteContent(id).catch(() => undefined);
  }
  for (const filepath of tempFilePaths.splice(0)) {
    await fs.rm(filepath, { force: true }).catch(() => undefined);
  }
});

test(
  "integrazione reale: ffmpeg compila il reel, l'asset VIDEO finisce sul database",
  async (t) => {
    // Skip dinamico: il check usa la stessa risoluzione del provider
    // (FFMPEG_PATH o comando di sistema), quindi se il test gira ma ffmpeg
    // manca davvero, il test lo dichiara invece di fallire.
    const ffmpegAvailable = await isVideoGenerationAvailable();
    if (!ffmpegAvailable) {
      t.skip("ffmpeg non disponibile su questa macchina");
      return;
    }
    // Tre fotogrammi reali: il reel deve montarli in sequenza (tagli + Ken
    // Burns per ciascuno), non mostrare una sola immagine ferma.
    const slides = [];
    for (let i = 0; i < 3; i += 1) {
      slides.push({ imageUrl: await writeRealPng(`/uploads/images/${uniq("frame")}.png`) });
    }
    const content = await createContent({
      type: "CAROUSEL",
      title: `[TEST] ${uniq("reel")}`,
      caption: "Caption di test",
      platforms: ["INSTAGRAM"],
      slides,
    });
    contentIds.push(content.id);

    // Nessun provider iniettato: il provider reale (ffmpeg) viene dal factory.
    const result = await generateVideoForContent({ contentId: content.id });
    assert.equal(result.ok, true, result.ok ? "" : `fallito: ${result.reason}`);
    if (!result.ok) return;
    // Il montaggio copre la finestra 15-20s. Il valore esatto dipende dalle
    // clip video leftover nel database condiviso (che possono deviare sulla
    // via montaggio): ciò che è contrattuale è la finestra.
    assert.ok(
      result.durationSec >= 15 && result.durationSec <= 20,
      `durata ${result.durationSec}s fuori dalla finestra 15-20s`
    );

    // B) MONTAGGIO REALE con una clip video vera (generata con ffmpeg lavfi):
    // taglio -ss/-t, normalizzazione e concat sul sorgente reale.
    const clipPath = path.join(process.cwd(), "public", "uploads", "videos", `${uniq("clip")}.mp4`);
    const ffmpegExe = await resolveFfmpegPath();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegExe, [
        "-y",
        "-f", "lavfi",
        "-i", `testsrc2=size=320x568:rate=25:duration=10`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        clipPath,
      ], { windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg uscita ${code}`))));
    });
    tempFilePaths.push(clipPath);
    await prisma.contentAsset.create({
      data: { kind: "VIDEO", contentId: content.id, url: `/uploads/videos/${path.basename(clipPath)}`, filename: path.basename(clipPath) },
    });

    const montage = await generateVideoForContent({ contentId: content.id });
    assert.equal(montage.ok, true, montage.ok ? "" : `fallito: ${montage.reason}`);
    if (!montage.ok) return;
    // 1 copertina (3s) + segmenti della clip da 10s (3 tagli) + eventuale
    // riciclo = 5-6 scene × 3s = 15-18s, dentro la finestra 15-20s.
    assert.ok(
      montage.durationSec >= 15 && montage.durationSec <= 20,
      `durata montaggio ${montage.durationSec}s fuori dalla finestra`
    );
    const montageOnDisk = path.join(process.cwd(), "public", montage.url.replace(/^\//, ""));
    assert.ok((await fs.stat(montageOnDisk)).size > 0);

    // Lo slideshow di copertina (parte A) è comunque a terra su disco.
    const videoOnDisk = path.join(process.cwd(), "public", result.url.replace(/^\//, ""));
    const stat = await fs.stat(videoOnDisk);
    assert.ok(stat.size > 0, "il file video non deve essere vuoto");

    const fresh = await getContent(content.id);
    assert.equal(fresh?.type, "VIDEO");
    const videoAsset = fresh?.assets.find((a) => a.id === result.assetId);
    assert.equal(videoAsset?.kind, "VIDEO");
    assert.equal(videoAsset?.url, result.url);
    // La locandina è già un asset IMAGE del contenuto (la slide).
    assert.ok(fresh?.assets.some((a) => a.kind === "IMAGE"));
    assert.equal(result.posterAssetId != null, true);

    // Una seconda chiamata senza slide non deve corrompere nulla: la poster
    // già presente fa da copertina senza scrivere righe nuove.
    const poster = await ensureVideoPoster(content.id);
    assert.equal(poster.ok, true);
    if (poster.ok) assert.equal(poster.created, false);
  }
);

/** true se il flusso audio è presente tra gli stream del contenitore. */
async function hasAudioStream(filePath: string): Promise<boolean> {
  const ffprobeExe = await resolveFfprobePath();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      ffprobeExe,
      ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath],
      { windowsHide: true }
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffprobe uscita ${code}`))
    );
  });
  return stdout
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .includes("audio");
}

test(
  "il video include una traccia audio quando è configurata la musica di sottofondo",
  async (t) => {
    const ffmpegAvailable = await isVideoGenerationAvailable();
    if (!ffmpegAvailable) {
      t.skip("ffmpeg non disponibile su questa macchina");
      return;
    }
    const ffmpegExe = await resolveFfmpegPath();

    // Traccia audio reale (sine 8s) più due fotogrammi reali.
    const musicPath = path.join(
      process.cwd(),
      "public",
      "uploads",
      "files",
      `${uniq("music")}.m4a`
    );
    await fs.mkdir(path.dirname(musicPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpegExe,
        [
          "-y",
          "-f", "lavfi",
          "-i", "sine=frequency=440:sample_rate=44100:duration=8",
          "-c:a", "aac",
          "-b:a", "128k",
          musicPath,
        ],
        { windowsHide: true }
      );
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg uscita ${code}`))
      );
    });
    tempFilePaths.push(musicPath);

    const slides = [
      { imageUrl: await writeRealPng(`/uploads/images/${uniq("frame")}.png`) },
      { imageUrl: await writeRealPng(`/uploads/images/${uniq("frame")}.png`) },
    ];
    const content = await createContent({
      type: "CAROUSEL",
      title: `[TEST] ${uniq("music")}`,
      caption: "Caption di test",
      platforms: ["INSTAGRAM"],
      slides,
    });
    contentIds.push(content.id);

    const previous = process.env.VIDEO_MUSIC_FILE;
    process.env.VIDEO_MUSIC_FILE = musicPath;
    try {
      const result = await generateVideoForContent({ contentId: content.id });
      assert.equal(result.ok, true, result.ok ? "" : `fallito: ${result.reason}`);
      if (!result.ok) return;

      const onDisk = path.join(process.cwd(), "public", result.url.replace(/^\//, ""));
      assert.ok((await fs.stat(onDisk)).size > 0, "il file video non deve essere vuoto");
      assert.ok(
        await hasAudioStream(onDisk),
        "il video deve contenere una traccia audio quando è configurata la musica"
      );
      assert.ok(
        result.durationSec >= 15 && result.durationSec <= 20,
        `durata ${result.durationSec}s fuori dalla finestra 15-20s`
      );
    } finally {
      if (previous === undefined) delete process.env.VIDEO_MUSIC_FILE;
      else process.env.VIDEO_MUSIC_FILE = previous;
    }
  }
);

test(
  "il video usa la colonna sonora predefinita quando non c'è alcuna traccia configurata",
  async (t) => {
    const ffmpegAvailable = await isVideoGenerationAvailable();
    if (!ffmpegAvailable) {
      t.skip("ffmpeg non disponibile su questa macchina");
      return;
    }

    const slides = [
      { imageUrl: await writeRealPng(`/uploads/images/${uniq("frame")}.png`) },
      { imageUrl: await writeRealPng(`/uploads/images/${uniq("frame")}.png`) },
    ];
    const content = await createContent({
      type: "CAROUSEL",
      title: `[TEST] ${uniq("default-music")}`,
      caption: "Caption di test",
      platforms: ["INSTAGRAM"],
      slides,
    });
    contentIds.push(content.id);

    // Nessun VIDEO_MUSIC_FILE e nessun asset AUDIO: deve entrare in gioco la
    // colonna sonora predefinita inclusa nel progetto.
    const previous = process.env.VIDEO_MUSIC_FILE;
    delete process.env.VIDEO_MUSIC_FILE;
    try {
      const result = await generateVideoForContent({ contentId: content.id });
      assert.equal(result.ok, true, result.ok ? "" : `fallito: ${result.reason}`);
      if (!result.ok) return;
      const onDisk = path.join(process.cwd(), "public", result.url.replace(/^\//, ""));
      assert.ok(
        await hasAudioStream(onDisk),
        "il video deve contenere la colonna sonora predefinita"
      );
    } finally {
      if (previous === undefined) delete process.env.VIDEO_MUSIC_FILE;
      else process.env.VIDEO_MUSIC_FILE = previous;
    }
  }
);
