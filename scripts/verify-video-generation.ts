// Verifica end-to-end REALE della pipeline video: ricerca foto Magnific vera +
// ffmpeg reale + musica. Crea un contenuto, genera il reel, stampa il risultato
// e poi ripulisce la riga. Uso: npx tsx scripts/verify-video-generation.ts [destinazione]
import { loadEnvFile } from "node:process";
import { prisma } from "../src/lib/prisma";
import { createContent, deleteContent } from "../src/lib/services/content";
import { generateVideoForContent } from "../src/lib/services/video";
import { isVideoGenerationAvailable } from "../src/lib/video/ffmpeg";

async function main() {
  try {
    loadEnvFile(".env");
  } catch {
    /* .env assente: si usa l'ambiente già caricato */
  }

  const dest = process.argv[2] ?? "new york";
  console.log("ffmpeg disponibile?", await isVideoGenerationAvailable());

  const content = await createContent({
    type: "POST",
    title: `[VERIFY] ${dest}`,
    caption: "Verifica generazione video",
    platforms: ["INSTAGRAM"],
  });
  console.log("contentId:", content.id);

  const result = await generateVideoForContent({ contentId: content.id, query: dest });
  console.log("RESULT:", JSON.stringify(result, null, 2));

  await deleteContent(content.id).catch(() => undefined);
  console.log("cleanup fatto");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
