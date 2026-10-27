import * as React from "react";
import Link from "next/link";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_META,
  TYPE_META,
  PLATFORM_LABELS,
} from "@/lib/status";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800",
        className
      )}
    >
      <div>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

const buttonStyles = {
  primary:
    "bg-sky-600 text-white hover:bg-sky-700 focus-visible:ring-sky-300",
  secondary:
    "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus-visible:ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-700",
  danger:
    "bg-white text-red-600 border border-red-200 hover:bg-red-50 focus-visible:ring-red-200 dark:bg-slate-800 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950",
  success:
    "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-300",
  warning:
    "bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-300",
  ghost:
    "text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-200 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonStyles;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "px-2.5 py-1.5 text-xs",
        size === "md" && "px-3.5 py-2 text-sm",
        size === "lg" && "px-5 py-2.5 text-sm",
        buttonStyles[variant],
        className
      )}
      {...props}
    />
  );
}

export function LinkButton({
  href,
  className,
  variant = "primary",
  size = "md",
  ...props
}: React.ComponentProps<typeof Link> & {
  variant?: keyof typeof buttonStyles;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Link
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        size === "sm" && "px-2.5 py-1.5 text-xs",
        size === "md" && "px-3.5 py-2 text-sm",
        size === "lg" && "px-5 py-2.5 text-sm",
        buttonStyles[variant],
        className
      )}
      href={href}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500",
        className
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500",
        className
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
        className
      )}
      {...props}
    />
  );
}

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "block text-xs font-medium text-slate-600 mb-1.5 dark:text-slate-300",
        className
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        className
      )}
      {...props}
    />
  );
}

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const meta =
    STATUS_META[status as keyof typeof STATUS_META] ??
    STATUS_META.DRAFT;
  return (
    <Badge className={cn(meta.badge, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

export function TypeBadge({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  const meta = TYPE_META[type as keyof typeof TYPE_META] ?? TYPE_META.POST;
  return (
    <Badge className={cn("bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700", className)}>
      {meta.label}
    </Badge>
  );
}

export function PlatformBadge({
  platform,
  className,
}: {
  platform: string;
  className?: string;
}) {
  const label =
    PLATFORM_LABELS[platform as keyof typeof PLATFORM_LABELS] ?? platform;
  return (
    <Badge
      className={cn(
        "bg-indigo-50 text-indigo-700 border-indigo-200",
        className
      )}
    >
      {label}
    </Badge>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center dark:border-slate-700">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Placeholder uniforme quando un contenuto non ha media associati. */
export function MediaPlaceholder({
  className,
  label = "Nessun media",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 bg-slate-50 text-slate-300 dark:bg-slate-800 dark:text-slate-600",
        className
      )}
    >
      <ImageIcon className="h-6 w-6" />
      <span className="text-[11px] font-medium">{label}</span>
    </div>
  );
}

type MediaThumbProps = {
  asset: { url: string; filename: string; kind: string };
  className?: string;
};

/** Anteprima uniforme (aspect-ratio fisso) di un asset, con fallback per i video. */
export function MediaThumb({ asset, className }: MediaThumbProps) {
  if (asset.kind === "VIDEO") {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-slate-900 text-white",
          className
        )}
      >
        <span className="text-xs font-medium">Video</span>
      </div>
    );
  }
  if (asset.kind === "AUDIO" || asset.kind === "FILE") {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 bg-slate-100 text-slate-500",
          className
        )}
      >
        <FileText className="h-6 w-6" />
        <span className="text-[11px] font-medium">File</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={asset.url}
      alt={asset.filename}
      loading="lazy"
      className={cn("object-cover", className)}
    />
  );
}

/** Badge piattaforme usato ovunque, con fallback coerente. */
export function PlatformBadges({
  platforms,
  className,
}: {
  platforms: readonly { platform: string }[];
  className?: string;
}) {
  if (platforms.length === 0) {
    return <span className={cn("text-xs text-slate-400", className)}>Nessuna piattaforma</span>;
  }
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {platforms.map((p) => (
        <PlatformBadge key={p.platform} platform={p.platform} />
      ))}
    </div>
  );
}

/**
 * Conteggio globale delle modali aperte.
 *
 * Il blocco dello scroll del body va gestito in modo condiviso: con due
 * modali simultanee (es. errore + operazione) ciascuna catturava il valore
 * corrente di `overflow` e lo ripristinava alla chiusura, lasciando la
 * pagina con lo scroll bloccato per sempre se l'ultima a chiudersi aveva
 * letto "hidden".
 */
let openModalCount = 0;
let savedBodyOverflow = "";

/** Modale accessibile e riusabile, senza dipendenze esterne. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
  /** Blocca la chiusura (Escape / click sul backdrop) mentre un'azione è in corso. */
  busy?: boolean;
}) {
  // Ref stabilizzato: evita di rilanciare l'effect a ogni render del padre.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const busyRef = React.useRef(busy);
  React.useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Focus: aprendo, il focus entra nel dialogo (altrimenti resta sul pulsante
  // che lo ha aperto e i campi interni non sono raggiungibili da tastiera);
  // chiudendo, torna all'elemento che lo aveva aperto invece di finire sul body.
  const panelRef = React.useRef<HTMLDivElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  // Il backdrop si chiude solo se il gesto è INIZIATO sul backdrop: un drag
  // di testo che esce dal pannello genera un click sul contesto comune e, senza
  // questo controllo, chiudeva la modale perdendo quanto digitato.
  const backdropArmedRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    if (openModalCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    openModalCount += 1;
    return () => {
      document.removeEventListener("keydown", onKey);
      openModalCount -= 1;
      if (openModalCount === 0) document.body.style.overflow = savedBodyOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        backdropArmedRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const armed = backdropArmedRef.current;
        backdropArmedRef.current = false;
        if (busy || !armed || e.target !== e.currentTarget) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "my-auto w-full rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none dark:border-slate-800 dark:bg-slate-900",
          size === "lg" ? "max-w-4xl" : "max-w-xl"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Casella formattata per input datetime-local */
export function toDateTimeLocal(d: Date | null | undefined): string {
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export const PLATFORM_VALUES = [
  "INSTAGRAM",
  "FACEBOOK",
  "TIKTOK",
] as const;