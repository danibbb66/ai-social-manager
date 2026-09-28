import { redirect } from "next/navigation";

/**
 * /approvals non è più una coda indipendente.
 *
 * La coda dei contenuti in attesa vive in Contents, che è il centro
 * operativo: Review Deck ("Da approvare") e storico decisioni.
 * Questa route resta come compatibilità per i link esistenti e non crea
 * una seconda UI di Approva/Rifiuta.
 */
export default function ApprovalsRedirectPage() {
  redirect("/contents?view=approvals");
}
