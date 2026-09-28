"use client";

import { useState } from "react";
import { Loader2, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { Button, Badge } from "@/components/ui";

type AiStatus = {
  ok: boolean;
  provider: string;
  model: string;
  availableModels: { name: string; size: number }[];
  message: string;
};

export function AiStatusCheck({ initial }: { initial: AiStatus | null }) {
  const [status, setStatus] = useState<AiStatus | null>(initial);
  const [checking, setChecking] = useState(false);

  const check = async (force = false) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/ai/status${force ? "?force=1" : ""}`);
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {checking ? (
            <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
          ) : status?.ok ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <XCircle className="h-5 w-5 text-red-500" />
          )}
          <span className="text-sm font-medium text-slate-800">
            {status?.ok
              ? `Ollama connesso (${status.model})`
              : status
                ? `Problema di connessione (${status.message})`
                : "Stato non verificato"}
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => check(true)}
          disabled={checking}
        >
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Verifica ora
        </Button>
      </div>

      {status?.availableModels && status.availableModels.length > 0 ? (
        <div>
          <div className="mb-1.5 text-xs font-medium text-slate-500">
            Modelli disponibili su Ollama
          </div>
          <div className="flex flex-wrap gap-1.5">
            {status.availableModels.map((m) => (
              <Badge key={m.name} className="bg-slate-100 text-slate-600 border-slate-200">
                {m.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {status && !status.ok ? (
        <p className="text-xs text-slate-500">
          <code className="mr-1 rounded bg-slate-100 px-1 py-0.5 font-mono">ollama serve</code>
          e poi{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">
            ollama pull {status.model}
          </code>{" "}
          se il modello non è installato.
        </p>
      ) : null}
    </div>
  );
}