import { prisma } from "@/lib/prisma";
import { contentInclude } from "@/lib/services/content";

/**
 * Contenuti in attesa di una decisione di approvazione.
 *
 * Nel workflow DRAFT → APPROVED → SCHEDULED → PUBLISHED la coda di approvazione
 * è costituita dalle bozze: un contenuto è "da approvare" finché resta DRAFT.
 * REVIEW è legacy e non viene contato.
 */
export async function getPendingApprovals() {
  return prisma.content.findMany({
    where: { status: "DRAFT" },
    include: contentInclude,
    orderBy: { updatedAt: "asc" },
  });
}

/** Cronologia delle decisioni di approvazione */
export async function getApprovalHistory(limit = 20) {
  return prisma.approval.findMany({
    include: { content: { select: { id: true, title: true, type: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Verifica che il contenuto abbia ALMENO UN'approvazione esplicita precedente.
 * È il controllo ufficiale: usato dal publish gate e dalla UI.
 */
export async function hasExplicitApproval(contentId: string): Promise<boolean> {
  const count = await prisma.approval.count({
    where: { contentId, decision: "APPROVED" },
  });
  return count > 0;
}

/**
 * Storico completo delle decisioni su un contenuto.
 * Nessun limite: serve a mostrare la cronologia, non a decidere il gate.
 */
export async function getContentApprovals(id: string) {
  return prisma.approval.findMany({
    where: { contentId: id },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Fonte di verità unica per la UI.
 *
 * Restituisce sia lo storico sia il flag di approvazione, ricalcolato con
 * hasExplicitApproval(): la stessa identica funzione usata dal publish gate.
 * La UI non deve più dedurre il flag da un array di approvazioni limitato,
 * altrimenti può mostrare "non approvato" mentre il server pubblicerebbe.
 */
export async function getApprovalState(id: string): Promise<{
  hasExplicitApproval: boolean;
  approvals: Awaited<ReturnType<typeof getContentApprovals>>;
}> {
  const [approved, approvals] = await Promise.all([
    hasExplicitApproval(id),
    getContentApprovals(id),
  ]);
  return { hasExplicitApproval: approved, approvals };
}
