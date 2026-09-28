import fs from "node:fs/promises";
import path from "node:path";
import {
  GeneratedImage,
  ImageGenerationUnavailableError,
  ImageProvider,
  ImageUpload,
} from "@/lib/images/provider";
import { uniqueFilename } from "@/lib/utils";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "images");

/**
 * Provider "manual": supporta l'importazione di immagini locali.
 * NON genera immagini: se qualcosa chiede una generazione restituisce
 * ImageGenerationUnavailableError così l'UI mostra l'avviso corretto.
 */
export class ManualImageProvider implements ImageProvider {
  readonly name = "manual";
  readonly canGenerate = false;

  async generateImage(): Promise<GeneratedImage> {
    throw new ImageGenerationUnavailableError(
      "Il generatore immagini non è configurato (IMAGE_PROVIDER=manual). Puoi caricare immagini manualmente dalla Media Library."
    );
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    const filename = uniqueFilename(file.originalName);
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const filepath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(filepath, file.buffer);
    return {
      url: `/uploads/images/${filename}`,
      provider: this.name,
      pathname: filepath,
    };
  }
}