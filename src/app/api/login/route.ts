import { NextRequest, NextResponse } from "next/server";

/**
 * Login con password condivisa. Confronta la password inviata con
 * `APP_ACCESS_PASSWORD` e, se corretta, imposta il cookie `app_auth` che il
 * middleware controlla. Nessun account utente: una sola password per l'app.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.APP_ACCESS_PASSWORD?.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "not_configured" },
      { status: 500 }
    );
  }

  let provided = "";
  try {
    const body = await req.json();
    if (typeof body?.password === "string") provided = body.password;
  } catch {
    provided = "";
  }

  if (provided !== expected) {
    return NextResponse.json(
      { ok: false, error: "invalid_password" },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("app_auth", expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
