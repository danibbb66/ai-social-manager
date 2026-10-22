import { NextRequest } from "next/server";
import { runDailyEditorial } from "@/lib/services/editorial-engine";

export const dynamic = "force-dynamic";

/**
 * Trigger esterno del motore editoriale: POST con autenticazione.
 *
 * La generazione automatica quotidiana non è più in `vercel.json`: i
 * contenuti si creano a mano. Questo endpoint resta per un avvio manuale.
 *
 * Due metodi supportati:
 *  - Bearer `CRON_SECRET` (stesso schema degli altri endpoint editoriali).
 *  - Chiamate manuali: header `x-api-key` con EDITORIAL_API_KEY.
 *
 * Fail closed: se CRON_SECRET non è configurato, il Bearer non è autorizzato.
 * Senza EDITORIAL_API_KEY configurato ogni richiesta con x-api-key è rifiutata,
 * anche con una chiave vuota.
 */
export async function POST(req: NextRequest) {
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

  const outcome = await runDailyEditorial();
  return Response.json({ ok: true, reused: outcome.reused, run: outcome.run });
}
