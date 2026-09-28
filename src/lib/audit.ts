import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type AuditDetail = Prisma.InputJsonValue | null;

export async function logAudit(
  action: string,
  entityType?: string | null,
  entityId?: string | null,
  detail?: AuditDetail
) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
        detail: detail ?? Prisma.JsonNull,
      },
    });
  } catch (e) {
    console.error("Audit log write failed", e);
  }
}