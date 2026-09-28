import { NextRequest } from "next/server";
import { checkAiStatus } from "@/lib/ai/status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const force = req.nextUrl.searchParams.get("force") === "1";
    const status = await checkAiStatus(force);
    return Response.json({ ok: true, status });
  } catch (e) {
    console.error("[ai:status] verifica fallita", e);
    return Response.json(
      {
        ok: false,
        status: {
          ok: false,
          provider: "ollama",
          model: "",
          availableModels: [],
          message: "Impossibile verificare lo stato dell'AI in questo momento.",
        },
      },
      { status: 502 }
    );
  }
}