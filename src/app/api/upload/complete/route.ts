import { NextRequest } from "next/server";
import { statFile, readFileHead } from "@/lib/storage";
import { detectUploadKind, UnsupportedMediaTypeError } from "@/lib/uploads";
import { deleteUploadedFile } from "@/lib/uploads";
import { createAsset } from "@/lib/services/media";

export const dynamic = "force-dynamic";

/** Byte iniziali letti per annusare il formato reale del file caricato. */
const SNIFF_BYTES = 4100;

/**
 * Registrazione di un file caricato DIRETTAMENTE su R2 dal browser
 * (flusso "direct" di /api/upload/sign).
 *
 * Verifica che l'oggetto esista davvero nel bucket, rileva il formato reale
 * dai magic bytes (senza fidarsi del MIME dichiarato) e crea l'asset in
 * Media Library. In caso di rifiuto il file orfano viene eliminato dal
 * bucket, come già fa il flusso classico.
 */
export async function POST(req: NextRequest) {
  let body: {
    key?: unknown;
    publicUrl?: unknown;
    name?: unknown;
    type?: unknown;
    size?: unknown;
    contentId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Richiesta non valida." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const publicUrl = typeof body.publicUrl === "string" ? body.publicUrl.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const declaredMime =
    typeof body.type === "string" && body.type.trim()
      ? body.type.trim()
      : "application/octet-stream";
  const declaredSize = typeof body.size === "number" ? body.size : null;
  const contentId =
    typeof body.contentId === "string" && body.contentId.trim()
      ? body.contentId.trim()
      : null;

  // La chiave deve stare sotto uploads/ ed essere stata emessa da /sign:
  // senza questo vincolo si potrebbero registrare oggetti arbitrari del bucket.
  if (!/^uploads\/(images|videos|files)\/[^/]+$/.test(key) || key.includes("..")) {
    return Response.json({ ok: false, message: "Chiave file non valida." }, { status: 400 });
  }
  if (!publicUrl || !name) {
    return Response.json({ ok: false, message: "Dati del file mancanti." }, { status: 400 });
  }

  // L'oggetto deve esistere davvero: il client potrebbe chiamare complete
  // senza aver fatto il PUT (o con un PUT fallito).
  const stat = await statFile(key);
  if (!stat || stat.size <= 0) {
    return Response.json(
      { ok: false, message: `Il file "${name}" non risulta caricato. Riprova l'upload.` },
      { status: 400 }
    );
  }
  if (declaredSize != null && stat.size !== declaredSize) {
    console.warn(
      `Upload/complete: dimensione dichiarata (${declaredSize}) diversa da quella nel bucket (${stat.size}) per ${key}`
    );
  }

  // Formato reale dai magic bytes (solo i primi KB, non tutto il file).
  const head = await readFileHead(key, SNIFF_BYTES);
  let detected: ReturnType<typeof detectUploadKind>;
  try {
    detected = detectUploadKind(head ?? Buffer.alloc(0), declaredMime, name);
  } catch (e) {
    await deleteUploadedFile(key).catch(() => {});
    const message =
      e instanceof UnsupportedMediaTypeError
        ? e.message
        : `Tipo di file non supportato: "${name}".`;
    return Response.json({ ok: false, message }, { status: 415 });
  }

  try {
    const asset = await createAsset({
      url: publicUrl,
      filename: name,
      mimeType: detected.mimeType,
      size: stat.size,
      kind: detected.kind,
      contentId,
    });
    return Response.json({ ok: true, assets: [asset] });
  } catch (e) {
    await deleteUploadedFile(key).catch(() => {});
    console.error("Upload/complete: registrazione asset fallita", name, e);
    return Response.json(
      { ok: false, message: "Errore nel salvare i metadati del file. Riprova." },
      { status: 500 }
    );
  }
}
