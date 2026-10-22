import { NextRequest } from "next/server";
import { dispatchDueContents } from "@/lib/services/dispatch";

export const dynamic = "force-dynamic";

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
 * Dispatcher della coda editoriale: GET e POST eseguono la stessa operazione.
 *
 * GET è il metodo che Vercel Cron invoca (14:00 UTC ≈ 15:00 Italia d'inverno).
 * POST resta disponibile per il trigger manuale con `x-api-key`.
 *
 * Un solo contenuto del giorno viene pubblicato. I programmati dei giorni
 * precedenti tornano in bozza, non escono in automatico.
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
