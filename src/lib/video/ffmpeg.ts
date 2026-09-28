import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueFilename } from "@/lib/utils";
import {
  GeneratedVideo,
  VideoGenerationUnavailableError,
  VideoProvider,
  VideoSlide,
} from "@/lib/video/provider";

const KNOWN_PATHS: string[] = [
  process.env.FFMPEG_PATH ?? "",
  "C:\\Users\\danie\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe",
  "C:\\ffmpeg\\bin\\ffmpeg.exe",
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
].filter(Boolean);

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(
          new VideoGenerationUnavailableError(
            `ffmpeg non trovato nel PATH. Installa ffmpeg oppure imposta FFMPEG_PATH.`
          )
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg terminato con codice ${code}: ${stderr.slice(-500)}`
          )
        );
    });
  });
}

async function resolveFfmpeg(): Promise<void> {
  for (const p of KNOWN_PATHS) {
    if (!p) continue;
    try {
      await fs.access(p);
      process.env.FFMPEG_PATH = p;
      return;
    } catch {
      // prova il prossimo
    }
  }
}

/**
 * Provider video locale: crea un reel/slideshow con ffmpeg.
 * Ogni slide = immagine mostrata per una durata configurabile.
 */
export class FfmpegVideoProvider implements VideoProvider {
  readonly name = "ffmpeg";
  readonly canGenerate = true;

  async generateSlideshow(
    slides: VideoSlide[],
    options?: { width?: number; height?: number; fps?: number }
  ): Promise<GeneratedVideo> {
    await resolveFfmpeg();

    if (slides.length === 0) {
      throw new Error("Nessuna slide fornita per il video.");
    }

    const width = options?.width ?? 1080;
    const height = options?.height ?? 1920;
    const fps = options?.fps ?? 25;

    const outDir = path.join(process.cwd(), "public", "uploads", "videos");
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, uniqueFilename("reel.mp4"));
    const relUrl = `/uploads/videos/${path.basename(outFile)}`;

    // verifica esistenza immagini
    for (const s of slides) {
      if (s.imagePath.startsWith("/uploads")) {
        s.imagePath = path.join(process.cwd(), "public", s.imagePath);
      }
      try {
        await fs.access(s.imagePath);
      } catch {
        throw new Error(`Immagine non trovata: ${s.imagePath}`);
      }
    }

    const args: string[] = ["-y"];
    const filterParts: string[] = [];
    const inputs: string[] = [];
    const total = slides.reduce(
      (acc, s) => acc + (s.durationSec ?? 3),
      0
    );

    slides.forEach((slide, i) => {
      const dur = slide.durationSec ?? 3;
      args.push("-loop", "1", "-t", String(dur), "-i", slide.imagePath);
      inputs.push(`[${i}:v]`);
      const scaled = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
      filterParts.push(`[${i}:v]${scaled}[v${i}]`);
    });

    const concatInputs = slides.map((_, i) => `[v${i}]`).join("");
    filterParts.push(
      `${concatInputs}concat=n=${slides.length}:v=1:a=0[vout]`
    );

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      outFile
    );

    await runFfmpeg(args);

    return {
      url: relUrl,
      provider: this.name,
      pathname: outFile,
      durationSec: total,
    };
  }
}