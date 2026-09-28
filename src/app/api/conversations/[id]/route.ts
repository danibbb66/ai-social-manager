import { NextRequest } from "next/server";
import { getConversation } from "@/lib/services/chat";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conversation = await getConversation(id);
    if (!conversation) {
      return Response.json(
        { ok: false, message: "Conversazione non trovata." },
        { status: 404 }
      );
    }
    return Response.json({ ok: true, conversation });
  } catch (e) {
    console.error("[api:conversations:id] get fallita", e);
    return Response.json(
      { ok: false, message: "Impossibile caricare la conversazione." },
      { status: 500 }
    );
  }
}