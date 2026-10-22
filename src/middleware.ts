import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE = "app_auth";

/**
 * Protezione con password dell'intera app.
 *
 * Fall-open: se `APP_ACCESS_PASSWORD` non è configurata (es. sviluppo locale),
 * nessuna protezione. In produzione chi non ha il cookie `app_auth` valido
 * viene reindirizzato a /login.
 *
 * Esclusi: la pagina di login, l'API di login e gli endpoint del cron
 * editoriale (autenticati con Bearer CRON_SECRET, non con la password).
 */
export function middleware(request: NextRequest) {
  const password = process.env.APP_ACCESS_PASSWORD?.trim();
  if (!password) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (
    pathname === "/login" ||
    pathname === "/api/login" ||
    pathname.startsWith("/api/editorial/")
  ) {
    return NextResponse.next();
  }

  if (request.cookies.get(AUTH_COOKIE)?.value === password) {
    return NextResponse.next();
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
