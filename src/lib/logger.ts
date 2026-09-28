/**
 * Logging server-side compatto e contestualizzato.
 * Centralizza i log relativi alle operazioni AI/tool per diagnosticare
 * gli errori senza esporre dati sensibili all'utente.
 */

function serialize(ctx: unknown): string {
  if (!ctx) return "";
  try {
    const s = JSON.stringify(ctx);
    return s && s.length <= 400 ? s : `${s?.slice(0, 400)}…`;
  } catch {
    return "[non serializzabile]";
  }
}

function errMsg(e: unknown): string {
  if (!e) return "sconosciuto";
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * Log di errore per le operazioni AI/tool.
 * @param operation operazione in corso (es. "agent.run", "tool.generateCaption")
 * @param context dettagli non sensibili (conversationId, contentId, nome tool...)
 * @param error errore verificato
 */
export function logAIError(
  operation: string,
  context: Record<string, unknown>,
  error: unknown
): void {
  console.error(
    `[ai:error] op=${operation} ctx=${serialize(context)} err=${errMsg(error)}`
  );
}