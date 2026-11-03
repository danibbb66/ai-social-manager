/**
 * Formatta un errore della Meta Graph API con tutto il dettaglio disponibile:
 * message, error_user_msg, code/subcode e type. Meta restituisce spesso un
 * generico "Invalid parameter" nel solo `message`: il subcode e il messaggio
 * utente sono ciò che permette di capire davvero la causa (token scaduto,
 * permesso mancante, media rifiutato...).
 */
export function formatGraphError(error?: {
  message?: string;
  code?: number;
  type?: string;
  error_subcode?: number;
  error_user_msg?: string;
}): string {
  if (!error) return "unknown";
  const parts: string[] = [];
  if (error.message) parts.push(error.message);
  if (error.error_user_msg && error.error_user_msg !== error.message) {
    parts.push(error.error_user_msg);
  }
  const codes: string[] = [];
  if (error.code != null) {
    codes.push(
      error.error_subcode != null
        ? `code ${error.code}/${error.error_subcode}`
        : `code ${error.code}`
    );
  }
  if (error.type) codes.push(error.type);
  if (codes.length > 0) parts.push(`(${codes.join(", ")})`);
  return parts.join(" — ") || "unknown";
}
