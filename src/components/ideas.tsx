"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Input, Textarea, Field } from "@/components/ui";
import { createIdeaAction, deleteIdeaAction } from "@/lib/actions/ideas";

export function CreateIdeaForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-3"
      action={(formData) =>
        startTransition(async () => {
          const res = await createIdeaAction({
            title: formData.get("title"),
            description: formData.get("description"),
            topic: formData.get("topic"),
          });
          if (res.ok === false) {
            alert(res.message ?? "Creazione idea non riuscita.");
            return;
          }
          router.refresh();
        })
      }
    >
      <Field label="Titolo *">
        <Input name="title" required placeholder="Es. Itinerario di 7 giorni in Sardegna" />
      </Field>
      <Field label="Argomento">
        <Input name="topic" placeholder="Es. Sardegna, Grecia, isole…" />
      </Field>
      <Field label="Descrizione">
        <Textarea
          name="description"
          rows={2}
          placeholder="Dettagli dello spunto…"
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Crea idea
        </Button>
      </div>
    </form>
  );
}

export function DeleteIdeaButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          if (!window.confirm("Eliminare questa idea?")) return;
          const res = await deleteIdeaAction(id);
          if (res.ok === false) {
            alert(res.message ?? "Eliminazione non riuscita.");
            return;
          }
          router.refresh();
        })
      }
      title="Elimina idea"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Trash2 className="h-4 w-4 text-slate-400 hover:text-red-600" />
      )}
    </Button>
  );
}