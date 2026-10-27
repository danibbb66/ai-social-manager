"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui";
import {
  testConnectionsAction,
  type ConnectionTestResult,
} from "@/lib/actions/test-connection";

function Line({ ok, message }: { ok: boolean; message: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
      )}
      <span className={ok ? "text-emerald-700" : "text-red-700"}>{message}</span>
    </li>
  );
}

export function ConnectionTest() {
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const res = await testConnectionsAction();
      setResult(res);
    });
  }

  return (
    <div className="px-5 py-3">
      <Button size="sm" variant="secondary" onClick={run} disabled={pending}>
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Testa connessione
      </Button>

      {result ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          <Line ok={result.instagram.ok} message={result.instagram.message} />
          <Line ok={result.facebook.ok} message={result.facebook.message} />
        </ul>
      ) : null}
    </div>
  );
}
