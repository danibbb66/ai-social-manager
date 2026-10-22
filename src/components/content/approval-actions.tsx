"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { approveAction, rejectAction } from "@/lib/actions/content";
import { Button, Modal, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * UNICA implementazione del comportamento Approva / Rifiuta dell'app.
 *
 * Tutti i punti di ingresso (Review Deck in /contents, lista, editor del
 * contenuto) chiamano `approveAction` / `rejectAction`: le stesse server
 * action degli altri moduli, con gli stessi gate lato server
 * (record Approval obbligatorio, caption richiesta, transizioni consentite).
 * Qui non viene reimplementato nessun controllo di workflow.
 */

/** Motivi rapidi proposti nel rifiuto. La nota resta comunque modificabile. */
const REJECT_REASONS = [
  "Testo da rifare",
  "Media da cambiare",
  "Non coerente con il brand",
  "Altro",
] as const;

type ActionResult = { ok?: boolean; message?: string } | null | undefined;

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Hook condiviso: esegue le due action e gestisce l'esito in modo uniforme.
 *
 * L'esito non viene restituito in modo sincrono (l'action è asincrona dentro
 * `startTransition`): chi chiama riceve il risultato tramite `onDone`, che
 * viene invocato SOLO se l'azione è riuscita. In caso di errore la card resta
 * al suo posto, il messaggio resta visibile e l'utente può riprovare.
 */
export function useApprovalActions() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const approve = (
    contentId: string,
    note?: string,
    onDone?: () => void,
    beforeApprove?: () => Promise<boolean>
  ) =>
    startTransition(async () => {
      setError(null);
      try {
        if (beforeApprove && !(await beforeApprove())) return;
        const res: ActionResult = await approveAction(contentId, note);
        if (res && res.ok === false) {
          setError(res.message ?? "Approvazione non riuscita.");
          return;
        }
        onDone?.();
      } catch (e) {
        setError(messageOf(e, "Si è verificato un errore. Riprova."));
      }
    });

  const reject = (contentId: string, note?: string, onDone?: () => void) =>
    startTransition(async () => {
      setError(null);
      try {
        const res: ActionResult = await rejectAction(contentId, note);
        if (res && res.ok === false) {
          setError(res.message ?? "Rifiuto non riuscito.");
          return;
        }
        onDone?.();
      } catch (e) {
        setError(messageOf(e, "Si è verificato un errore. Riprova."));
      }
    });

  return { approve, reject, pending, error, setError };
}

/**
 * Dialog di rifiuto con motivazione. Non cancella nulla: conferma il passaggio
 * DRAFT → REJECTED reusing `rejectAction`, quindi record Approval e audit
 * vengono scritti dal server esattamente come in editor e Review Deck.
 */
export function RejectReasonDialog({
  open,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy?: boolean;
  /** Errore dell'ultima conferma: mostrato dentro il dialog, che resta aperto. */
  error?: string | null;
  onClose: () => void;
  onConfirm: (note?: string) => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // A ogni apertura si ripartisce puliti: altrimenti, confermando il rifiuto
  // senza passare da `close()`, motivo e nota della scelta precedente
  // restavano precompilati alla riapertura successiva.
  useEffect(() => {
    if (!open) return;
    setReason(null);
    setNote("");
  }, [open]);

  const close = () => {
    if (busy) return;
    setReason(null);
    setNote("");
    onClose();
  };

  const confirm = () => {
    const text = note.trim();
    const final = text || reason || undefined;
    onConfirm(final);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      busy={busy}
      title="Scarta contenuto"
      description="Il contenuto torna in stato Rifiutato e resta modificabile. Non viene eliminato."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Annulla
          </Button>
          <Button variant="danger" onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Scarta
          </Button>
        </>
      }
    >
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium text-slate-700">
          Perché?
        </legend>
        <div className="flex flex-wrap gap-2">
          {REJECT_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setReason((prev) => (prev === r ? null : r))}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300",
                reason === r
                  ? "border-sky-300 bg-sky-50 text-sky-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Aggiungi un dettaglio (facoltativo)…"
          aria-label="Nota del rifiuto"
        />
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </p>
        ) : null}
        <p className="text-xs text-slate-400">
          La motivazione viene salvata nello storico delle decisioni del
          contenuto.
        </p>
      </fieldset>
    </Modal>
  );
}

/**
 * Coppia di pulsanti Approva / Rifiuta.
 * Usata dall'editor e da ogni altro punto di ingresso: un solo comportamento.
 */
export function ApprovalActions({
  contentId,
  disabled = false,
  disabledReason,
  layout = "row",
  size = "sm",
  className,
  onApproved,
  onRejected,
  beforeApprove,
}: {
  contentId: string;
  /** Blocca le azioni quando il contenuto non è in DRAFT o manca la caption. */
  disabled?: boolean;
  disabledReason?: string;
  layout?: "row" | "stack";
  size?: "sm" | "md";
  className?: string;
  onApproved?: () => void;
  onRejected?: (note?: string) => void;
  /** Salvata prima di approvare; se ritorna false l'approvazione viene annullata. */
  beforeApprove?: () => Promise<boolean>;
}) {
  const { approve, reject, pending, error } = useApprovalActions();
  const [askReject, setAskReject] = useState(false);

  const doApprove = () => approve(contentId, undefined, onApproved, beforeApprove);

  const doReject = (note?: string) =>
    reject(contentId, note, () => {
      setAskReject(false);
      onRejected?.(note);
    });

  const full = size === "md";

  return (
    <div className={cn(layout === "stack" ? "space-y-2" : "flex gap-2", className)}>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}

      <div className={cn(layout === "stack" ? "space-y-2" : "flex gap-2")}>
        <Button
          variant="danger"
          size={full ? "md" : "sm"}
          onClick={() => setAskReject(true)}
          disabled={pending || disabled}
          title={disabled ? disabledReason : undefined}
          aria-label="Rifiuta contenuto"
        >
          <X className="h-4 w-4" />
          Rifiuta
        </Button>
        <Button
          variant="success"
          size={full ? "md" : "sm"}
          onClick={doApprove}
          disabled={pending || disabled}
          title={disabled ? disabledReason : undefined}
          aria-label="Approva contenuto"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          Approva
        </Button>
      </div>

      <RejectReasonDialog
        open={askReject}
        busy={pending}
        error={error}
        onClose={() => setAskReject(false)}
        onConfirm={doReject}
      />
    </div>
  );
}
