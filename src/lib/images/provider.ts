export interface GeneratedImage {
  url: string;
  provider: string;
  pathname: string;
  /** MIME type reale del file generato (se noto) */
  mimeType?: string;
  /** Dimensione in byte (se nota) */
  size?: number;
  /** URL originale remoto da cui è stata scaricata la copia locale (se previsto) */
  sourceUrl?: string;
}

export interface GenerateImageOptions {
  contentId?: string;
  /** Formato immagine richiesto (es. "square_1_1", "widescreen_16_9") */
  aspectRatio?: string;
  /** Risoluzione richiesta ("1k" | "2k" | "4k") */
  resolution?: "1k" | "2k" | "4k";
}

export interface ImageUpload {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

/** Errore quando nessun generatore immagini è configurato */
export class ImageGenerationUnavailableError extends Error {
  constructor(message = "Nessun generatore immagini configurato") {
    super(message);
    this.name = "ImageGenerationUnavailableError";
  }
}

/**
 * Astrazione del provider immagini.
 * Oggi: "manual" (solo upload locale).
 * In futuro: Stable Diffusion locale, DALL-E, Gemini etc.
 * Per collegare un nuovo provider basta implementare questa interfaccia
 * e registrarla nella factory.
 */
export interface ImageProvider {
  readonly name: string;
  /** true se il provider SA GENERARE immagini (non solo importarle) */
  readonly canGenerate: boolean;
  generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage>;
  saveUploadedFile(file: ImageUpload): Promise<GeneratedImage>;
}