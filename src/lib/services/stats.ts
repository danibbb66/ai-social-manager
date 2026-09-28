import { subDays } from "date-fns";
import { prisma } from "@/lib/prisma";

export interface DashboardStats {
  counts: Record<string, number>;
  pendingApproval: number;
  scheduled: { id: string; title: string | null; type: string; scheduledDate: Date | null; platformLabels: string[] }[];
  published30d: number;
  ideasRecent: { id: string; title: string; createdAt: Date }[];
  recentActivity: { id: string; action: string; entityType: string | null; createdAt: Date }[];
  mediaCount: number;
  accounts: { platform: string; configured: boolean; active: boolean; name: string }[];
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const [grouped, scheduled, published30, ideas, activity, mediaCount, accounts] =
    await Promise.all([
      prisma.content.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.content.findMany({
        where: {
          status: "SCHEDULED",
          scheduledDate: { gte: new Date() },
        },
        include: { platforms: true },
        orderBy: { scheduledDate: "asc" },
        take: 8,
      }),
      prisma.content.count({
        where: {
          status: "PUBLISHED",
          updatedAt: { gte: subDays(new Date(), 30) },
        },
      }),
      prisma.contentIdea.findMany({
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.contentAsset.count(),
      prisma.socialAccount.findMany({
        where: { active: true },
        select: { platform: true, configured: true, active: true, name: true },
      }),
    ]);

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;

  return {
    counts,
    // Nel workflow DRAFT → APPROVED → SCHEDULED → PUBLISHED la coda di
    // approvazione coincide con le bozze. REVIEW è legacy: non si conta.
    pendingApproval: counts.DRAFT ?? 0,
    scheduled: scheduled.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      scheduledDate: c.scheduledDate,
      platformLabels: c.platforms.map((p) => p.platform),
    })),
    published30d: published30,
    ideasRecent: ideas.map((i) => ({
      id: i.id,
      title: i.title,
      createdAt: i.createdAt,
    })),
    recentActivity: activity,
    mediaCount,
    accounts,
  };
}