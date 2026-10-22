"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { createContentAction } from "@/lib/actions/content";

export function NewContentButton({
  label = "Nuovo contenuto",
}: {
  label?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromProposal = searchParams.get("fromProposal");

  // Il flusso ?fromProposal=... deve creare la bozza una volta sola: React in
  // StrictMode monta (e smonta e rimonta) il componente eseguendo l'effetto
  // due volte, e senza un guard arrivano due chiamate alla Server Action.
  // Il ref tiene traccia della proposta già processata per questa istanza;
  // la de-duplicazione lato server resta la rete di sicurezza definitiva.
  const processedProposalRef = useRef<string | null>(null);

  useEffect(() => {
    if (!fromProposal) return;
    if (processedProposalRef.current === fromProposal) return;
    processedProposalRef.current = fromProposal;
    (async () => {
      // La Server Action risponde sempre con un oggetto strutturato
      // ({ ok, success, id, message, error }); il try/catch copre il caso
      // residuo di trasporto (rete, 500 con corpo vuoto), così il client non
      // esplode con "Unexpected end of JSON input" e l'utente vede un alert.
      try {
        const res = await createContentAction({ proposalId: fromProposal });
        if (res?.ok && res.id) {
          // Il parametro viene rimosso dalla query string: un reload della
          // pagina non ritenta la creazione e l'URL resta condivisibile.
          router.replace(`/contents/${res.id}`);
        } else {
          processedProposalRef.current = null;
          alert(res?.error ?? res?.message ?? "Creazione dalla proposta non riuscita.");
        }
      } catch (e) {
        processedProposalRef.current = null;
        console.error("Trasformazione proposta in contenuto", e);
        alert("Creazione dalla proposta non riuscita. Riprova tra poco.");
      }
    })();
  }, [fromProposal, router]);
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await createContentAction({});
          if (res.ok && res.id) {
            router.push(`/contents/${res.id}`);
          } else {
            alert(res.message ?? "Creazione non riuscita.");
          }
        })
      }
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Plus className="h-4 w-4" />
      )}
      {pending ? "Creazione…" : label}
    </Button>
  );
}