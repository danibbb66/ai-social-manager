export interface VideoSlide {
  imagePath: string;
  durationSec?: number;
  title?: string;
}

export interface GeneratedVideo {
  url: string;
  provider: string;
  pathname: string;
  durationSec: number;
}

export interface VideoOptions {
  width?: number;
  height?: number;
  fps?: number;
}

export class VideoGenerationUnavailableError extends Error {
  constructor(message = "Generazione video non disponibile") {
    super(message);
    this.name = "VideoGenerationUnavailableError";
  }
}

/**
 * Astrazione del provider video.
 * Oggi: slideshow locale via ffmpeg.
 * In futuro: generazione video AI (Veo, Sora, Runway...).
 */
export interface VideoProvider {
  readonly name: string;
  readonly canGenerate: boolean;
  generateSlideshow(
    slides: VideoSlide[],
    options?: VideoOptions
  ): Promise<GeneratedVideo>;
}