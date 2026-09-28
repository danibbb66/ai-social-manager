import { ContentIdea } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export interface IdeaInput {
  title: string;
  description?: string | null;
  topic?: string | null;
}

export async function listIdeas(limit = 50): Promise<ContentIdea[]> {
  return prisma.contentIdea.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getIdea(id: string): Promise<ContentIdea | null> {
  return prisma.contentIdea.findUnique({ where: { id } });
}

export async function createIdea(input: IdeaInput): Promise<ContentIdea> {
  const title = String(input.title ?? "").trim();
  if (!title) {
    throw new Error("Il titolo dell'idea è obbligatorio.");
  }
  if (title.length > 200) {
    throw new Error("Il titolo dell'idea non può superare i 200 caratteri.");
  }
  const description =
    input.description !== null && input.description !== undefined
      ? String(input.description).trim().slice(0, 2000) || null
      : null;
  const topic =
    input.topic !== null && input.topic !== undefined
      ? String(input.topic).trim().slice(0, 200) || null
      : null;

  const idea = await prisma.contentIdea.create({
    data: {
      title,
      description,
      topic,
    },
  });
  await logAudit("IDEA_CREATED", "ContentIdea", idea.id, {
    title: idea.title,
  });
  return idea;
}

export async function deleteIdea(id: string): Promise<void> {
  await prisma.contentIdea.delete({ where: { id } });
  await logAudit("IDEA_DELETED", "ContentIdea", id, {});
}