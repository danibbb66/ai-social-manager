"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Input, Select, Field } from "@/components/ui";
import { upsertAccountAction, deleteAccountAction } from "@/lib/actions/accounts";

const PLATFORMS = [
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "TIKTOK", label: "TikTok" },
];

export function AccountForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-3"
      action={(formData) =>
        startTransition(async () => {
          const res = await upsertAccountAction({
            platform: formData.get("platform"),
            name: formData.get("name"),
            handle: formData.get("handle"),
            active: true,
          });
          if (res.ok === false) {
            alert(res.message ?? "Salvataggio non riuscito.");
            return;
          }
          router.refresh();
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Piattaforma">
          <Select name="platform" defaultValue="INSTAGRAM">
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Nome account *">
          <Input name="name" required placeholder="Es. Instagram aziendale" />
        </Field>
      </div>
      <Field label="Handle / pagina">
        <Input name="handle" placeholder="Es. @lamiaagenziaviaggi" />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Aggiungi account
        </Button>
      </div>
    </form>
  );
}

export function AccountDeleteButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          if (!window.confirm("Eliminare questo account?")) return;
          const res = await deleteAccountAction(id);
          if (res.ok === false) {
            alert(res.message ?? "Eliminazione non riuscita.");
            return;
          }
          router.refresh();
        })
      }
      title="Elimina account"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Trash2 className="h-4 w-4 text-slate-400 hover:text-red-600" />
      )}
    </Button>
  );
}