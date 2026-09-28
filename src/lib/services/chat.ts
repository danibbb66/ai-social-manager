import { ChatMessage, ChatRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface NewMessage {
  role: ChatRole;
  content: string;
  toolName?: string | null;
  toolArgs?: unknown | null;
  toolSummary?: string | null;
}

export async function listConversations(limit = 30) {
  return prisma.chatConversation.findMany({
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { messages: true } } },
    take: limit,
  });
}

export async function getConversation(id: string) {
  return prisma.chatConversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function getOrCreateConversation(id?: string | null, title?: string) {
  if (id) {
    const existing = await getConversation(id);
    if (existing) return existing;
  }
  return prisma.chatConversation.create({
    data: { title: title ?? "Nuova conversazione" },
    include: { messages: true },
  });
}

/** Salva più messaggi in un'unica transazione (evita dati parziali). */
export async function addMessages(
  conversationId: string,
  messages: NewMessage[]
): Promise<ChatMessage[]> {
  if (messages.length === 0) return [];

  return prisma.$transaction(
    async (tx) => {
      const created: ChatMessage[] = [];
      for (const m of messages) {
        const msg = await tx.chatMessage.create({
          data: {
            conversationId,
            role: m.role,
            content: m.content,
            toolName: m.toolName ?? null,
            toolArgs: m.toolArgs ?? undefined,
            toolSummary: m.toolSummary ?? null,
          },
        });
        created.push(msg);
      }

      const last = created[created.length - 1];
      if (last && last.role === "USER") {
        const firstUser = created.find((m) => m.role === "USER");
        const title = (firstUser?.content ?? "Conversazione").slice(0, 60);
        const existing = await tx.chatConversation.findUnique({
          where: { id: conversationId },
        });
        if (existing && existing.title === "Nuova conversazione") {
          await tx.chatConversation.update({
            where: { id: conversationId },
            data: { title },
          });
        }
      }

      return created;
    },
    { timeout: 15_000 }
  );
}

export async function updateConversationTitle(
  id: string,
  title: string
): Promise<{ id: string }> {
  return prisma.chatConversation.update({
    where: { id },
    data: { title },
  });
}

export async function getMessageHistory(
  conversationId: string,
  limit = 20
): Promise<ChatMessage[]> {
  const messages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return messages;
}

// Limiti per singolo messaggio (prevengono context overflow)
const MAX_USER_ASSISTANT_LEN = 8000;
const MAX_TOOL_LEN = 2000;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toAiMessage(m: ChatMessage): {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
} {
  switch (m.role) {
    case "USER":
      return { role: "user", content: clip(m.content, MAX_USER_ASSISTANT_LEN) };
    case "TOOL":
      return {
        role: "tool",
        name: m.toolName ?? "tool",
        content: clip(m.toolSummary ?? m.content, MAX_TOOL_LEN),
      };
    default:
      return { role: "assistant", content: clip(m.content, MAX_USER_ASSISTANT_LEN) };
  }
}

/**
 * Converte i messaggi del DB nel formato richiesto dal provider AI,
 * bloccando il totale entro un budget di caratteri (context budget).
 * Se necessario elimina i messaggi più vecchi, mantenendo sempre la parte recente.
 */
export function toAiMessages(
  messages: ChatMessage[],
  budget = 14_000
): { role: "user" | "assistant" | "tool"; content: string; name?: string }[] {
  if (messages.length === 0) return [];

  const mapped = messages.map(toAiMessage);
  let total = mapped.reduce((acc, m) => acc + m.content.length, 0);
  let from = 0;

  // Mantiene sempre almeno gli ultimi 4 messaggi
  const maxDrop = Math.max(0, messages.length - 4);
  let dropped = 0;
  while (total > budget && dropped < maxDrop) {
    total -= mapped[from].content.length;
    from += 1;
    dropped += 1;
  }

  if (from >= mapped.length) {
    // budget molto piccolo: restituisce solo gli ultimi 2 messaggi
    return mapped.slice(-2);
  }
  const kept = mapped.slice(from);

  // Passa dal vecchio API: se ancora troppo grande, tronca in modo proporzionale
  if (kept.reduce((acc, m) => acc + m.content.length, 0) > budget) {
    const perMessage = Math.max(500, Math.floor(budget / kept.length));
    return kept.map((m) => ({ ...m, content: clip(m.content, perMessage) }));
  }
  return kept;
}