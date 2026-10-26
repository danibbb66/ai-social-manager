import { createWorker } from "tesseract.js";
import os from "node:os";
import path from "node:path";

/**
 * OCR delle locandine del fornitore.
 *
 * Il catalogo importa dalla pagina pubblica solo il TITOLO della card; prezzi,
 * hotel, date, trattamento e tutto il resto esistono SOLO dentro l'immagine
 * della locandina. Questo modulo legge quel testo dai pixel con tesseract.js,
 * così la locandina rigenerata può riportare i dati reali dell'offerta.
 *
 * Vincoli di deployment (Vercel):
 *  - i file `.traineddata` sono committati in `vendor/tessdata/` e letti da
 *    `langPath` locale: nessun download a runtime dalla CDN;
 *  - `gzip: false` perché i file sono `.traineddata` non compressi;
 *  - `cachePath` su `os.tmpdir()` e `cacheMethod: "none"`: il filesystem di
 *    Vercel non è persistente, non serve una cache.
 */

/** Cartella dei modelli lingua, relativa alla radice del progetto. */
const TESSDATA_DIR = path.join(process.cwd(), "vendor", "tessdata");

/** Lingue: italiano (testi) + inglese (nomi di hotel/città/termini propri). */
const OCR_LANGS = "ita+eng";

export async function ocrTextFromImage(image: Buffer): Promise<string> {
  const worker = await createWorker(OCR_LANGS, 1, {
    langPath: TESSDATA_DIR,
    cachePath: path.join(os.tmpdir(), "tesseract-cache"),
    cacheMethod: "none",
    gzip: false,
  });
  try {
    const { data } = await worker.recognize(image);
    return (data.text ?? "").trim();
  } finally {
    await worker.terminate();
  }
}
