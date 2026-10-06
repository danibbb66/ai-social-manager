import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ContentStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

type LatestDraft = {
  id: string;
  title: string | null;
  status: ContentStatus;
  createdAt: Date;
  catalogProposalId: string | null;
};

/**
 * Il DRAFT più rilevante del giorno: il Content collegato al run di oggi
 * (tramite contentId) se esiste, altrimenti il DRAFT più recente creato
 * oggi in UTC.
 */
async function findLatestDraft(
  run: { contentId: string | null } | null,
  startOfTodayUtc: Date,
): Promise<LatestDraft | null> {
  const select = {
    id: true,
    title: true,
    status: true,
    createdAt: true,
    catalogProposalId: true,
  } as const;

  if (run?.contentId) {
    const linked = await prisma.content.findUnique({
      where: { id: run.contentId },
      select,
    });
    if (linked) return linked;
  }

  return prisma.content.findFirst({
    where: { status: "DRAFT", createdAt: { gte: startOfTodayUtc } },
    orderBy: { createdAt: "desc" },
    select,
  });
}

function getTodayUtc(): { today: string; startOfTodayUtc: Date } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const startOfTodayUtc = new Date(today + "T00:00:00.000Z");
  return { today, startOfTodayUtc };
}

/**
 * Stato del motore editoriale: GET con autenticazione.
 *
 * Stessa auth duale del POST /api/editorial/run:
 *  - Vercel Cron: `Authorization: Bearer <CRON_SECRET>` (fail closed se non configurato)
 *  - Chiamate manuali: `x-api-key` con EDITORIAL_API_KEY (fail closed se non configurato)
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")?.trim() ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  if (bearerMatch) {
    const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
    if (!cronSecret || bearerMatch[1] !== cronSecret) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  } else {
    const provided = req.headers.get("x-api-key")?.trim() ?? "";
    const expected = process.env.EDITORIAL_API_KEY?.trim() ?? "";
    if (!expected || provided !== expected) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  const { today, startOfTodayUtc } = getTodayUtc();

  const run = await prisma.editorialRun.findFirst({
    where: { date: today },
    orderBy: { createdAt: "desc" },
  });

  const pendingDraftsCount = await prisma.content.count({
    where: {
      status: "DRAFT",
      OR: [
        { createdAt: { gte: startOfTodayUtc } },
        { editorialRuns: { some: { date: today } } },
      ],
    },
  });

  const latestDraft = await findLatestDraft(run, startOfTodayUtc);

  return Response.json({
    ok: true,
    today,
    run,
    pendingDraftsCount,
    latestDraft,
  });
}
