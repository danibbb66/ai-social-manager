import { config } from "@/lib/env";

const SECRETS = () => [
  config.instagram.token,
  config.facebook.token,
  config.tiktok.token,
].filter((s): s is string => Boolean(s));

/**
 * Rimuove da un testo qualsiasi access token configurato.
 * Usato su messaggi di errore, log e audit per non esporre mai i segreti.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of SECRETS()) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}