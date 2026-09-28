import { NextRequest } from "next/server";
import { listConversations, getOrCreateConversation, updateConversationTitle } from "@/lib/services/chat";

export const dynamic = "force-dynamic";

const MAX_TITLE_LEN = 120;

export async function GET() {
  try {
    const conversations = await listConversations();
    return Response.json({ ok: true, conversations });
  } catch (e) {
    console.error("[api:conversations] list fallita", e);
    return Response.json(
      { ok: false, conversations: [], message: "Impossibile caricare le conversazioni." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    const title = String(body.title ?? "Nuova conversazione").trim().slice(0, MAX_TITLE_LEN) || "Nuova conversazione";
    const conversation = await getOrCreateConversation(null, title);
    return Response.json({ ok: true, conversation });
  } catch (e) {
    console.error("[api:conversations] create fallita", e);
    return Response.json(
      { ok: false, message: "Impossibile creare la conversazione." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string };
    const id = String(body.id ?? "").trim();
    if (!id) {
      return Response.json({ ok: false, message: "id mancante" }, { status: 400 });
    }
    const title = String(body.title ?? "Conversazione").trim().slice(0, MAX_TITLE_LEN) || "Conversazione";
    await updateConversationTitle(id, title);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[api:conversations] patch fallita", e);
    return Response.json(
      { ok: false, message: "Impossibile aggiornare la conversazione." },
      { status: 500 }
    );
  }
}