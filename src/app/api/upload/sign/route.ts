import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createDirectUploadUrl, isCloudStorage } from "@/lib/storage";
import { uniqueFilename, isImageMime, isVideoMime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Preparazione di un upload.
 *
 * In modalità cloud restituisce un URL pre-firmato R2 (`mode: "direct"`): il
 * browser carica il file DIRETTAMENTE nel bucket, superando il limite di
 * 4,5 MB del body delle funzioni Vercel (il motivo per cui i file grandi
 * sparivano in silenzio). Dopo il PUT il client chiama /api/upload/complete.
 *
 * In locale (`mode: "proxy"`) il client usa il classico POST multipart su
 * /api/upload, che non ha limiti pratici sul disco di sviluppo.
 */
export async function POST(req: NextRequest) {
  let body: { name?: unknown; type?: unknown; size?: unknown; contentId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Richiesta non valida." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const size = typeof body.size === "number" ? body.size : NaN;
  const contentId =
    typeof body.contentId === "string" && body.contentId.trim()
      ? body.contentId.trim()
      : null;

  if (!name) {
    return Response.json({ ok: false, message: "Nome file mancante." }, { status: 400 });
  }
  if (!Number.isFinite(size) || size <= 0) {
    return Response.json({ ok: false, message: `Il file "${name}" è vuoto.` }, { status: 400 });
  }
  if (size > MAX_FILE_SIZE) {
    return Response.json(
      { ok: false, message: `File "${name}" troppo grande (max 100MB).` },
      { status: 413 }
    );
  }

  // Il tipo dichiarato orienta solo la cartella di destinazione: il kind reale
  // viene rilevato dai magic bytes in /api/upload/complete.
  const mime = type || "application/octet-stream";
  if (!isImageMime(mime) && !isVideoMime(mime)) {
    return Response.json(
      {
        ok: false,
        message: `Tipo di file non supportato: "${name}". Carica un'immagine o un video.`,
      },
      { status: 415 }
    );
  }

  if (contentId) {
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true },
    });
    if (!content) {
      return Response.json(
        { ok: false, message: "Contenuto associato non trovato." },
        { status: 400 }
      );
    }
  }

  if (!isCloudStorage()) {
    return Response.json({ ok: true, mode: "proxy" });
  }

  const sub = isImageMime(mime) ? "images" : "videos";
  const key = `uploads/${sub}/${uniqueFilename(name)}`;

  try {
    const direct = await createDirectUploadUrl(key, mime);
    if (!direct) {
      return Response.json({ ok: true, mode: "proxy" });
    }
    return Response.json({ ok: true, mode: "direct", ...direct, key });
  } catch (e) {
    console.error("Upload/sign: creazione URL pre-firmato fallita", e);
    return Response.json(
      { ok: false, message: "Impossibile preparare il caricamento. Riprova." },
      { status: 500 }
    );
  }
}
