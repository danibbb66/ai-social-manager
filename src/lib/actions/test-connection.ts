"use server";

import { config, hasFacebook, hasInstagram } from "@/lib/env";
import { redactSecrets } from "@/lib/security";

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

export interface ConnectionTestResult {
  instagram: ConnectionCheck;
  facebook: ConnectionCheck;
}

async function checkInstagram(): Promise<ConnectionCheck> {
  if (!hasInstagram()) {
    return { ok: false, message: "Credenziali Instagram mancanti in .env." };
  }
  try {
    const url =
      `https://graph.instagram.com/v23.0/me?fields=id,username` +
      `&access_token=${encodeURIComponent(config.instagram.token!)}`;
    const res = await fetch(url);
    const json = (await res.json()) as {
      username?: string;
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      return {
        ok: false,
        message: redactSecrets(
          `Instagram: ${json.error?.message ?? `HTTP ${res.status}`}`
        ),
      };
    }
    return { ok: true, message: `Instagram collegato (@${json.username ?? "account"})` };
  } catch (e) {
    return {
      ok: false,
      message: redactSecrets(
        `Instagram: ${e instanceof Error ? e.message : String(e)}`
      ),
    };
  }
}

async function checkFacebook(): Promise<ConnectionCheck> {
  if (!hasFacebook()) {
    return { ok: false, message: "Credenziali Facebook mancanti in .env." };
  }
  try {
    const url =
      `https://graph.facebook.com/v26.0/${config.facebook.pageId}?fields=name` +
      `&access_token=${encodeURIComponent(config.facebook.token!)}`;
    const res = await fetch(url);
    const json = (await res.json()) as {
      name?: string;
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      return {
        ok: false,
        message: redactSecrets(
          `Facebook: ${json.error?.message ?? `HTTP ${res.status}`}`
        ),
      };
    }
    return { ok: true, message: `Facebook collegato (${json.name ?? "pagina"})` };
  } catch (e) {
    return {
      ok: false,
      message: redactSecrets(
        `Facebook: ${e instanceof Error ? e.message : String(e)}`
      ),
    };
  }
}

/** Verifica dal vivo che i token Instagram/Facebook siano ancora validi. */
export async function testConnectionsAction(): Promise<ConnectionTestResult> {
  const [instagram, facebook] = await Promise.all([
    checkInstagram(),
    checkFacebook(),
  ]);
  return { instagram, facebook };
}
