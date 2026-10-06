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
 * Etichette che non sono informative per l'utente.
 *
 * Sono i nomi interni dei tool e dei provider: descrivono *come* il sistema ha
 * lavorato, non che cosa è successo. Un utente che chiede "crea un post su
 * Formentera" non ha bisogno di sapere che è passato da `createContent` o che il
 * file è passato da Magnific, e vederlo lo costringe a leggere una stringa che
 * non può usare. Vengono sostituite da una frase che dice che cosa sta
 * succedendo, o da niente.
 */
const INTERNAL_LABELS = new Set([
  "Creazione contenuto",
  "Aggiornamento contenuto",
  "Lettura contenuto",
  "Elenco contenuti",
  "Duplicazione contenuto",
  "Eliminazione contenuto",
  "Generazione immagine",
  "magnific",
  "Magnific",
]);

/** Il testo da mostrare come etichetta, o `null` se è una stringa interna. */
function userLabel(label: string | null | undefined, fallback: string): string | null {
  const text = (label ?? "").trim();
  if (!text) return fallback;
  return INTERNAL_LABELS.has(text) ? null : text;
}

/**
 * Card leggibile per i risultati dei tool AI.
 *
 * - generateImage: anteprima del file e link alla Media Library, senza nomi di
 *   provider né di layout.
 * - altri tool: la sola frase di conferma del tool, o l'errore se non è andata
 *   a buon fine.
 * - stato live: una frase che dice che si sta lavorando, senza il nome del tool.
 */
export function ToolResultCard({ toolName, label, ok, error, result }: ToolResultCardProps) {
  const isImage = toolName === "generateImage";
  const displayLabel = label ?? result?.label ?? toolName;

  const data = result?.data ?? null;
  const imageUrl =
    data && typeof data.url === "string" && data.url.startsWith("/uploads/") ? data.url : null;
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
              Immagine salvata nella Media Library.
            </div>
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
          Sto generando l&apos;immagine
          <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle" />
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
            {/* Nessun dettaglio tecnico sotto la conferma: il messaggio del tool
                è già scritto per l'utente, e i suoi dati (id, fonti delle
                immagini, layout) sono cose che può aprire lui in Contenuti. */}
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

  // live / esecuzione corrente. Il nome del tool non entra: è una stringa di
  // esecuzione, e quello che l'utente aspetta di vedere è che qualcosa sta
  // succedendo, non come si chiama lo strumento che lo sta facendo.
  const liveFailed = failed;
  const liveLabel = userLabel(displayLabel, "Sto lavorando");
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
            {liveLabel}
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-middle" />
          </>
        )}
      </div>
    </div>
  );
}