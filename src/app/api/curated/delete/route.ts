import { NextRequest } from "next/server";
import { deleteFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Elimina un file "curato" (foto/clip/audio) dal bucket R2 (o `public/` in
 * locale). Accetta solo chiavi sotto `curated/` o `audio/`: nessun'altra
 * chiave può essere cancellata da qui (protezione contro cancellazioni
 * arbitrarie). Serve alla pagina "Clip & foto" per rimuovere i media caricati.
 */
export async function POST(req: NextRequest) {
  let body: { key?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Richiesta non valida." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return Response.json({ ok: false, message: "Chiave mancante." }, { status: 400 });
  }
  // Percorso di sicurezza: solo curated/** e audio/**
  const safe = key.startsWith("curated/") || key.startsWith("audio/");
  if (!safe || key.includes("..")) {
    return Response.json({ ok: false, message: "Chiave non valida." }, { status: 400 });
  }

  try {
    await deleteFile(key);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("Curated/delete fallita", e);
    return Response.json(
      { ok: false, message: "Eliminazione non riuscita. Riprova." },
      { status: 500 }
    );
  }
}
