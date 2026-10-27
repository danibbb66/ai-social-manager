import type {
  ContentStatus,
  ContentType,
  Platform,
} from "@prisma/client";

export const STATUS_META: Record<
  ContentStatus,
  { label: string; color: string; badge: string; dot: string }
> = {
  DRAFT: {
    label: "Bozza",
    color: "text-gray-600",
    badge: "bg-gray-100 text-gray-700 border-gray-200",
    dot: "bg-gray-400",
  },
  // Stato legacy dormiente: non è più raggiungibile dal workflow applicativo.
  // Resta nell'enum Prisma (SQLite: rimuoverlo farebbe rebuild della tabella)
  // e può comparire solo su dati storici. Nessuna UI lo propone.
  REVIEW: {
    label: "Revisione (legacy)",
    color: "text-slate-500",
    badge: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
  APPROVED: {
    label: "Approvato",
    color: "text-emerald-700",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
  },
  SCHEDULED: {
    label: "Programmato",
    color: "text-sky-700",
    badge: "bg-sky-50 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
  },
  PUBLISHED: {
    label: "Pubblicato",
    color: "text-violet-700",
    badge: "bg-violet-50 text-violet-700 border-violet-200",
    dot: "bg-violet-500",
  },
  REJECTED: {
    label: "Rifiutato",
    color: "text-red-700",
    badge: "bg-red-50 text-red-700 border-red-200",
    dot: "bg-red-500",
  },
  FAILED: {
    label: "Fallito",
    color: "text-red-800",
    badge: "bg-red-100 text-red-800 border-red-300",
    dot: "bg-red-600",
  },
};

export const TYPE_META: Record<ContentType, { label: string; icon: string }> = {
  POST: { label: "Post", icon: "file-text" },
  CAROUSEL: { label: "Carousel", icon: "layers" },
  VIDEO: { label: "Video / Reel", icon: "video" },
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
};

/**
 * Stati esposti all'utente, nell'ordine del percorso normale.
 * REVIEW è escluso di proposito: è legacy e non viene più proposto da nulla.
 */
export const STATUS_ORDER: ContentStatus[] = [
  "DRAFT",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
  "REJECTED",
  "FAILED",
];

export const STATUS_OPTIONS: { value: ContentStatus; label: string }[] =
  STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label }));

export const TYPE_OPTIONS: { value: ContentType; label: string }[] = [
  { value: "POST", label: "Post" },
  { value: "CAROUSEL", label: "Carousel" },
  { value: "VIDEO", label: "Video / Reel" },
];

export const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "FACEBOOK", label: "Facebook" },
  { value: "TIKTOK", label: "TikTok" },
];

/**
 * Regole di transizione di stato.
 *
 * Percorso normale: DRAFT → APPROVED → SCHEDULED → PUBLISHED.
 *   - APPROVED richiede sempre un'approvazione umana esplicita con record
 *     Approval: changeStatus/updateContent lo bloccano di proposito
 *     (l'approvazione si fa solo con approveContent).
 *   - REJECTED = contenuto rifiutato, torna in lavorazione con DRAFT.
 *   - FAILED = errore tecnico, recuperabile solo tornando a DRAFT.
 *   - REVIEW = legacy dormiente: nessuno stato transiziona PIÙ verso REVIEW.
 *     Si lascia DRAFT come via di fuga per eventuali dati storici.
 */
export type TransitionRules = Record<ContentStatus, ContentStatus[]>;

export const LEGACY_STATUSES: ContentStatus[] = ["REVIEW"];

export const ALLOWED_TRANSITIONS: TransitionRules = {
  DRAFT: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["SCHEDULED", "PUBLISHED", "DRAFT"],
  SCHEDULED: ["PUBLISHED", "APPROVED", "DRAFT", "REJECTED"],
  PUBLISHED: ["DRAFT"],
  REJECTED: ["DRAFT"],
  FAILED: ["DRAFT"],
  REVIEW: ["DRAFT"],
};

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

