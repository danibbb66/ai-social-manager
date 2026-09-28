"use client";

import Link from "next/link";
import { CheckCircle2, Link2, Loader2, Wand2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Normalizzazione dei contenuti ASSISTANT persistiti.
 * I round che eseguono tool salvano in DB il JSON grezzo del modello
 * ({"message": "...", "tool_calls": [...]} o il vecchio formato
 * {"action": "...", "parameters": {...}}). L'utente deve vedere solo
 * la narrazione umana ("message"), mai il JSON tecnico.
 */
export function parseAssistantMessage(raw: string): { text: string; hide: boolean } {
  const s = String(raw ?? "").trim();
  if (!s) return { text: "", hide: true };

  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    // non è JSON: testo normale
  }
  if (!obj) return { text: s, hide: false };

  const isToolRound =
    "tool_calls" in obj || "action" in obj || "parameters" in obj || "message" in obj;
  if (!isToolRound) return { text: s, hide: false };

  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  if (message && !message.startsWith("{") && !message.startsWith("[")) {
    return { text: message, hide: false };
  }
  // round di puro orchestrazione di tool: nessuna bollicina visibile
  return { text: "", hide: true };
}

export type ParsedToolResult = {
  ok?: boolean;
  message?: string;
  data?: Record<string, unknown> | null;
  label?: string;
};

/**
 * Normalizzazione dei risultati TOOL persistiti.
 * Il backend salva la risposta come JSON stringificato: estraiamo
 * solo i campi strutturati (ok/message/data) e il label, mai il JSON grezzo.
 */
export function parseToolResult(raw: string): ParsedToolResult | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    return {
      ok: typeof o.ok === "boolean" ? o.ok : undefined,
      message: typeof o.message === "string" ? o.message : undefined,
      data: o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : null,
      label: typeof o._label === "string" ? o._label : undefined,
    };
  } catch {
    return null;
  }
}

type ToolResultCardProps = {
  toolName: string;
  label?: string | null;
  ok?: boolean;
  error?: string | null;
  /** Risultato strutturato (presente dopo il reload da DB). */
  result?: ParsedToolResult | null;
};

const PROVIDER_LABELS: Record<string, string> = {
  magnific: "Magnific",
};

/**
 * Tool che operano su un contenuto: il loro risultato può essere aperto
 * direttamente in /contents/[id]. Gli altri tool (es. createIdea) non sono
 * inclusi per evitare link verso un id non navigabile.
 */
const CONTENT_TOOLS = new Set([
  "createContent",
  "updateContent",
  "createCarousel",
  "duplicateContent",
]);

function contentIdOf(toolName: string, data: Record<string, unknown> | null): string | null {
  if (!data || !CONTENT_TOOLS.has(toolName)) return null;
  const raw = data.id ?? data.contentId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Card leggibile per i risultati dei tool AI.

 * - generateImage: anteprima, stato, provider e link alla Media Library.
 * - altri tool: messaggio umano senza mai renderizzare JSON grezzo.
 * - stato live (streaming): indicazione di esecuzione senza dettagli.
 */
export function ToolResultCard({ toolName, label, ok, error, result }: ToolResultCardProps) {
  const isImage = toolName === "generateImage";
  const displayLabel = label ?? result?.label ?? toolName;

  const data = result?.data ?? null;
  const imageUrl =
    data && typeof data.url === "string" && data.url.startsWith("/uploads/") ? data.url : null;
  const provider = data && typeof data.provider === "string" ? data.provider : null;
  const message = result?.message || null;
  const failed = ok === false || result?.ok === false;

  // generateImage con anteprima disponibile
  if (isImage && imageUrl) {
    return (
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <a
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          className="group block"
          title="Apri l'immagine originale"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="Immagine generata dall'AI"
            className="aspect-square w-full object-cover transition-opacity group-hover:opacity-95"
          />
        </a>
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Immagine generata e salvata nella Media Library.
          </div>
          {provider ? (
            <div className="mt-0.5 text-[11px] text-slate-400">
              Provider: {PROVIDER_LABELS[provider] ?? provider}
            </div>
          ) : null}
          <Link
            href="/media"
            className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-slate-700"
          >
            <Link2 className="h-3.5 w-3.5" />
            Apri nella Media Library
          </Link>
        </div>
      </div>
    );
  }

  // generateImage completato senza anteprima, oppure fallito
  if (isImage) {
    if (failed) {
      return (
        <div className="flex items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-600">
            <XCircle className="h-4 w-4" />
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
            Non è stato possibile generare l&apos;immagine. Riprova.
            {message ? <span className="mt-0.5 block text-red-600">{message}</span> : null}
          </div>
        </div>
      );
    }
    // in esecuzione
    return (
      <div className="flex items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          Generazione immagine in corso…
          <span className="block text-[11px] opacity-70">{displayLabel}</span>
        </div>
      </div>
    );
  }

  // altri tool: mai JSON grezzo
  if (result) {
    if (failed) {
      return (
        <div className="flex items-start gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-600">
            <XCircle className="h-4 w-4" />
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800">
            {message || "Operazione non riuscita. Riprova."}
          </div>
        </div>
      );
    }
    const contentId = contentIdOf(toolName, data);
    return (
      <div className="flex items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
        </div>
        <div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900">
            {message || `${displayLabel} completato.`}
          </div>
          {contentId ? (
            <Link
              href={`/contents/${contentId}`}
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 hover:text-sky-700"
            >
              <Link2 className="h-3 w-3" />
              Apri in Contenuti
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  // live / esecuzione corrente
  const liveFailed = failed;
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
          liveFailed ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
        )}
      >
        {liveFailed ? <XCircle className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
      </div>
      <div
        className={cn(
          "rounded-lg border px-3 py-1.5 text-xs",
          liveFailed
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        )}
      >
        {liveFailed ? (
          error || "Operazione non riuscita. Riprova."
        ) : (
          <>
            {displayLabel}
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle" />
          </>
        )}
      </div>
    </div>
  );
}