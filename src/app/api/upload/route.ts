import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveUploadedFile, deleteUploadedFile, detectUploadKind } from "@/lib/uploads";
import { createAsset, getAsset, deleteAsset } from "@/lib/services/media";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    console.error("Upload: form data non valido", e);
    return Response.json(
      { ok: false, message: "Richiesta di upload non valida." },
      { status: 400 }
    );
  }

  const contentIdRaw = form.get("contentId");
  const contentId =
    typeof contentIdRaw === "string" && contentIdRaw.trim()
      ? contentIdRaw.trim()
      : null;

  if (contentId) {
    try {
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
    } catch (e) {
      console.error("Upload: verifica contenuto fallita", e);
      return Response.json(
        { ok: false, message: "Errore del database durante l'upload." },
        { status: 500 }
      );
    }
  }

  const fileEntries = Array.from(form.entries()).filter(
    ([key, value]) => key.startsWith("file") && value instanceof File
  );

  if (fileEntries.length === 0) {
    return Response.json(
      { ok: false, message: "Nessun file ricevuto." },
      { status: 400 }
    );
  }

  const files = fileEntries.map(([, value]) => value as File);

  // Validazione preliminare: evita di salvare metà richiesta e poi fallire.
  for (const file of files) {
    if (file.size <= 0) {
      return Response.json(
        { ok: false, message: `Il file "${file.name}" è vuoto.` },
        { status: 400 }
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { ok: false, message: `File "${file.name}" troppo grande (max 100MB).` },
        { status: 413 }
      );
    }
  }

  const assets = [];
  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (e) {
      console.error("Upload: lettura file fallita", file.name, e);
      return Response.json(
        { ok: false, message: `Impossibile leggere il file "${file.name}".` },
        { status: 400 }
      );
    }

    // Il kind è derivato dai byte reali del file, non dal MIME né dall'estensione
    // dichiarati dal client: un video non deve essere registrato come IMAGE.
    // La verifica avviene prima della scrittura, così un file rifiutato non
    // lascia mai un file orfano su disco.
    let detected: ReturnType<typeof detectUploadKind>;
    try {
      detected = detectUploadKind(buffer, file.type);
    } catch (e) {
      console.error("Upload: tipo file non supportato", file.name, e);
      return Response.json(
        {
          ok: false,
          message:
            e instanceof Error
              ? e.message
              : `Tipo di file non supportato: "${file.name}".`,
        },
        { status: 415 }
      );
    }

    let saved;
    try {
      saved = await saveUploadedFile({
        buffer,
        originalName: file.name,
        mimeType: detected.mimeType,
      });
    } catch (e) {
      console.error("Upload: salvataggio file fallito", file.name, e);
      return Response.json(
        { ok: false, message: `Impossibile salvare il file "${file.name}" sul disco.` },
        { status: 500 }
      );
    }

    try {
      const asset = await createAsset({
        url: saved.url,
        filename: file.name,
        mimeType: saved.mimeType,
        size: saved.size,
        kind: detected.kind,
        contentId,
      });
      assets.push(asset);
    } catch (e) {
      // Pulizia del file appena scritto per evitare file orfani.
      await deleteUploadedFile(saved.url).catch(() => {});
      console.error("Upload: registrazione asset fallita", file.name, e);
      return Response.json(
        {
          ok: false,
          message:
            e instanceof Error && e.message.includes("non trovato")
              ? e.message
              : "Errore nel salvare i metadati del file. Riprova.",
        },
        { status: 500 }
      );
    }
  }

  return Response.json({ ok: true, assets });
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id)
      return Response.json({ ok: false, message: "id mancante" }, { status: 400 });
    const asset = await getAsset(id);
    if (!asset)
      return Response.json(
        { ok: false, message: "Asset non trovato" },
        { status: 404 }
      );
    const url = asset.url;
    await deleteAsset(id);
    await deleteUploadedFile(url).catch(() => {});
    return Response.json({ ok: true });
  } catch (e) {
    console.error("Upload: eliminazione asset fallita", e);
    return Response.json(
      { ok: false, message: "Errore durante l'eliminazione del file." },
      { status: 500 }
    );
  }
}