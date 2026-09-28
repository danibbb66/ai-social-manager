"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Platform } from "@prisma/client";
import {
  upsertAccount as svcUpsert,
  deleteAccount as svcDelete,
} from "@/lib/services/accounts";

export async function upsertAccountAction(input: unknown) {
  try {
    const parsed = z
      .object({
        platform: z.enum(["INSTAGRAM", "FACEBOOK", "TIKTOK"]),
        name: z.string().min(1),
        handle: z.string().nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(input);
    await svcUpsert({
      platform: parsed.platform as Platform,
      name: parsed.name,
      handle: parsed.handle,
      active: parsed.active,
    });
    revalidatePath("/social");
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    console.error("[action:upsertAccount]", e);
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Operazione non riuscita.",
    };
  }
}

export async function deleteAccountAction(id: string) {
  try {
    await svcDelete(id);
    revalidatePath("/social");
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    console.error("[action:deleteAccount]", e);
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Operazione non riuscita.",
    };
  }
}