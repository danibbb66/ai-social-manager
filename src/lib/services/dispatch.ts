import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { publishContent } from "@/lib/services/publish";
import { redactSecrets } from "@/lib/security";

export type DispatchPublish = typeof publishContent;

export type DispatchItemResult = {
  contentId: string;
  ok: boolean;
  action: "published" | "returned_to_draft";
  message: string;
  jobId?: string;
};

export type DispatchOutcome = {
  due: number;
  published: number;
  failed: number;
  returnedToDraft: number;
  results: DispatchItemResult[];
};

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function returnToDraft(contentId: string, reason: string): Promise<void> {
  await prisma.content.update({
    where: { id: contentId },
    data: { status: "DRAFT", scheduledDate: null },
  });
  await logAudit("CONTENT_MISSED_TO_DRAFT", "Content", contentId, { reason });
}

/**
 * Pubblica al massimo un contenuto programmato per oggi.
 *
 * I programmati dei giorni precedenti (cron saltato, errore, ecc.) non escono
 * in automatico: tornano in bozza, così non partono due post alla stessa ora.
 * Se per oggi ce n'è più di uno, esce solo il primo (data più vicina); gli
 * altri tornano in bozza.
 */
export async function dispatchDueContents(
  now: Date = new Date(),
  publish: DispatchPublish = publishContent
): Promise<DispatchOutcome> {
  const due = await prisma.content.findMany({
    where: { status: "SCHEDULED", scheduledDate: { lte: now } },
    orderBy: [{ scheduledDate: "asc" }, { id: "asc" }],
    select: { id: true, scheduledDate: true },
  });

  const dayStart = startOfUtcDay(now);
  const missed = due.filter(
    (c) => c.scheduledDate && c.scheduledDate.getTime() < dayStart.getTime()
  );
  const today = due.filter(
    (c) => !c.scheduledDate || c.scheduledDate.getTime() >= dayStart.getTime()
  );

  const results: DispatchItemResult[] = [];

  for (const content of missed) {
    try {
      await returnToDraft(content.id, "scheduled_date_in_the_past");
      results.push({
        contentId: content.id,
        ok: true,
        action: "returned_to_draft",
        message: "Non pubblicato: data superata, tornato in bozza.",
      });
    } catch (e) {
      results.push({
        contentId: content.id,
        ok: false,
        action: "returned_to_draft",
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
    }
  }

  const [toPublish, ...extras] = today;

  for (const content of extras) {
    try {
      await returnToDraft(content.id, "another_post_already_due_today");
      results.push({
        contentId: content.id,
        ok: true,
        action: "returned_to_draft",
        message: "Non pubblicato: un altro contenuto è già in uscita oggi, tornato in bozza.",
      });
    } catch (e) {
      results.push({
        contentId: content.id,
        ok: false,
        action: "returned_to_draft",
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
    }
  }

  if (toPublish) {
    try {
      const res = await publish(toPublish.id, undefined, { confirm: true });
      results.push({
        contentId: toPublish.id,
        ok: res.ok,
        action: "published",
        message: res.message,
        jobId: res.jobId,
      });
    } catch (e) {
      results.push({
        contentId: toPublish.id,
        ok: false,
        action: "published",
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
    }
  }

  return {
    due: due.length,
    published: results.filter((r) => r.action === "published" && r.ok).length,
    failed: results.filter((r) => r.action === "published" && !r.ok).length,
    returnedToDraft: results.filter((r) => r.action === "returned_to_draft" && r.ok).length,
    results,
  };
}
