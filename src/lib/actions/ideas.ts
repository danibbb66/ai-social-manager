"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createIdea as svcCreate, deleteIdea as svcDelete } from "@/lib/services/ideas";

function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return `Dati non validi: ${e.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("; ")}`;
  }
  if (e instanceof Error && e.message) return e.message;
  return "Operazione non riuscita. Riprova tra poco.";
}

export async function createIdeaAction(input: unknown) {
  try {
    const parsed = z
      .object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        topic: z.string().nullable().optional(),
      })
      .parse(input);
    const idea = await svcCreate(parsed);
    for (const p of ["/ideas", "/"]) revalidatePath(p);
    return { ok: true, id: idea.id };
  } catch (e) {
    console.error("[action:createIdea]", e);
    return { ok: false, message: errorMessage(e) };
  }
}

export async function deleteIdeaAction(id: string) {
  try {
    await svcDelete(id);
    for (const p of ["/ideas", "/"]) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    console.error("[action:deleteIdea]", e);
    return { ok: false, message: errorMessage(e) };
  }
}