import { NextRequest } from "next/server";
import { runAgent, AgentStreamEvent } from "@/lib/ai/agent";
import { getOrCreateConversation } from "@/lib/services/chat";
import { logAIError } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_LEN = 20_000;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    conversationId?: string;
    message?: string;
  };
  const message = (body.message ?? "").toString().trim();
  if (!message) {
    return Response.json(
      { ok: false, message: "Messaggio vuoto." },
      { status: 400 }
    );
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return Response.json(
      {
        ok: false,
        message: `Messaggio troppo lungo (max ${MAX_MESSAGE_LEN} caratteri).`,
      },
      { status: 413 }
    );
  }

  let conversation;
  try {
    conversation = await getOrCreateConversation(body.conversationId);
  } catch (e) {
    logAIError("chat.getOrCreateConversation", { conversationId: body.conversationId }, e);
    return Response.json(
      { ok: false, message: "Impossibile avviare la conversazione. Riprova tra poco." },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const push = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream chiuso dal client
        }
      };
      try {
        await runAgent({
          conversationId: conversation.id,
          userMessage: message,
          emit: (e: AgentStreamEvent) => push({ type: "agent", event: e }),
        });
      } catch (e) {
        logAIError("chat.stream", { conversationId: conversation.id }, e);
        push({
          type: "error",
          text: "Si è verificato un errore durante la richiesta. Riprova tra poco.",
        });
      }
      push({ type: "done", conversationId: conversation.id });
      try {
        controller.close();
      } catch {
        // già chiuso
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}