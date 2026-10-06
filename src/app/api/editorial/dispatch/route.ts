import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { publishContent } from "@/lib/services/publish";
import { redactSecrets } from "@/lib/security";

export const dynamic = "force-dynamic";

type DispatchResult = {
  contentId: string;
  ok: boolean;
  message: string;
  jobId?: string;
};

/**
 * Stessa auth duale di `/api/editorial/run` e `/api/editorial/status`:
 *  - Vercel Cron: header `Authorization: Bearer <CRON_SECRET>` (fail closed
 *    se CRON_SECRET non è configurato);
 *  - chiamate manuali: header `x-api-key` con EDITORIAL_API_KEY (fail closed
 *    se la chiave non è configurata, anche con valore vuoto).
 */
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")?.trim() ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  if (bearerMatch) {
    const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
    return Boolean(cronSecret) && bearerMatch[1] === cronSecret;
  }

  const provided = req.headers.get("x-api-key")?.trim() ?? "";
  const expected = process.env.EDITORIAL_API_KEY?.trim() ?? "";
  return Boolean(expected) && provided === expected;
}

/**
 * Pubblica i contenuti in SCHEDULED la cui data è già passata.
 *
 * Ogni contenuto viene processato in modo indipendente: un errore su uno non
 * interrompe la coda degli altri. Le eccezioni (mancata approvazione, nessuna
 * piattaforma, conferma mancante) lasciano il contenuto in SCHEDULED, quindi
 * la prossima esecuzione del cron lo riproverà; un fallimento registrato dal
 * provider sposta invece lo stato su FAILED e non viene ritentato.
 */
async function dispatchDueContents(now: Date) {
  const due = await prisma.content.findMany({
    where: { status: "SCHEDULED", scheduledDate: { lte: now } },
    orderBy: { scheduledDate: "asc" },
    select: { id: true, scheduledDate: true },
  });

  const results: DispatchResult[] = [];

  for (const content of due) {
    try {
      const res = await publishContent(content.id, undefined, { confirm: true });
      results.push({
        contentId: content.id,
        ok: res.ok,
        message: res.message,
        jobId: res.jobId,
      });
    } catch (e) {
      results.push({
        contentId: content.id,
        ok: false,
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
    }
  }

  return {
    due: due.length,
    published: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * Dispatcher della coda editoriale: GET e POST eseguono la stessa operazione.
 *
 * GET è il metodo che Vercel Cron invoca; POST resta disponibile per il
 * trigger manuale con `x-api-key`.
 */
async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const outcome = await dispatchDueContents(new Date());
  return Response.json({ ok: true, ...outcome });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
