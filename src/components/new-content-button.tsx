"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { createContentAction } from "@/lib/actions/content";

export function NewContentButton({
  label = "Nuovo contenuto",
}: {
  label?: string;
}) {
  const router = useRouter();
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