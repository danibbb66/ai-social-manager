import { z } from "zod";
import { createIdea as svcCreateIdea, listIdeas as svcListIdeas } from "@/lib/services/ideas";
import { AiTool } from "@/lib/ai/tools/types";

export const createIdeaTool: AiTool = {
  name: "createIdea",
  description:
    "Crea un'idea di contenuto nel database (titolo, descrizione, argomento). Usalo quando l'utente propone un tema/idea di contenuto e vuole salvarla.",
  brief: "Salvataggio idea",
  schema: z.object({
    title: z.string().describe("Titolo dell'idea"),
    description: z.string().optional().describe("Descrizione dettagliata"),
    topic: z.string().optional().describe("Argomento/tema"),
  }),
  execute: async (args) => {
    const parsed = z
      .object({ title: z.string(), description: z.string().optional(), topic: z.string().optional() })
      .parse(args);
    const idea = await svcCreateIdea(parsed);
    return {
      ok: true,
      message: `Idea salvata: "${idea.title}" (id ${idea.id}).`,
      data: { id: idea.id, title: idea.title, topic: idea.topic },
    };
  },
};

export const listIdeasTool: AiTool = {
  name: "listIdeas",
  description: "Elenca le idee di contenuto salvate, dalla più recente.",
  brief: "Elenco idee",
  schema: z.object({}),
  execute: async () => {
    const ideas = await svcListIdeas(50);
    return {
      ok: true,
      message: `Trovate ${ideas.length} idee.`,
      data: ideas.map((i) => ({
        id: i.id,
        title: i.title,
        topic: i.topic,
        description: i.description,
        createdAt: i.createdAt,
      })),
    };
  },
};