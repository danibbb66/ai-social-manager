"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  ImageOff,
  Layers,
  Maximize2,
} from "lucide-react";
import {
  Button,
  EmptyState,
  LinkButton,
  MediaPlaceholder,
  PlatformBadges,
  TypeBadge,
} from "@/components/ui";
import {
  RejectReasonDialog,
  useApprovalActions,
} from "@/components/content/approval-actions";
import { cn, formatDate } from "@/lib/utils";

/**
 * Review Deck: modalità di revisione rapida dei contenuti in attesa di
 * decisione. Non è una gestione contenuti: è approvazione veloce.
 * Per il controllo completo (testo, media, piattaforme, programmazione,
 * pubblicazione) esiste /contents/[id].
 *
 * Animazione: `transform`/`opacity` pilotati da un loop requestAnimationFrame
 * guidato dal puntatore, con smorzamento breve in CSS. Nessuna dipendenza
 * aggiuntiva, nessun loop a riposo, nessuna animazione di layout/reflow.
 */

export type ReviewDeckItem = {
  id: string;
  type: string;
  title: string | null;
  caption: string | null;
  hashtags: string | null;
  scheduledDate: string | null;
  platforms: { platform: string }[];
  assets: { id: string; kind: string; url: string; filename: string }[];
  slideImages: string[];
};

const MAX_SHIFT_PX = 18;
const MAX_LIFT_PX = 8;
const MAX_ROT_DEG = 7;
const SWIPE_THRESHOLD_PX = 80;
const EXIT_MS = 280;
const DRAG_MARK = 0.3;

type Pt = { x: number; y: number };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Rispetta la preferenza di sistema: niente rotazione né parallax. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * Anteprima del media GIÀ associato al contenuto: nessuna query aggiuntiva,
 * nessun accesso alla Media Library, nessun bypass dei gate esistenti.
 */
function DeckMedia({ item }: { item: ReviewDeckItem }) {
  const asset = item.assets[0];

  if (asset?.kind === "VIDEO") {
    return (
      <div className="relative h-full w-full bg-slate-900">
        <video
          src={asset.url}
          muted
          playsInline
          preload="metadata"
          aria-label={`Anteprima video: ${asset.filename}`}
          className="h-full w-full object-cover"
        />
        <span className="absolute bottom-2 left-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-white">
          Video
        </span>
      </div>
    );
  }

  const url = asset?.url ?? item.slideImages[0] ?? null;
  if (!url) {
    return <MediaPlaceholder className="h-full w-full" label="Nessun media" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={asset ? asset.filename : "Slide del carousel"}
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover"
    />
  );
}

export function ReviewDeck({
  items,
  totalPending,
  historyHref,
  allHref,
}: {
  items: ReviewDeckItem[];
  /** Numero totale di DRAFT lato server: contatore e avviso di troncamento. */
  totalPending: number;
  historyHref: string;
  allHref: string;
}) {
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const { approve, reject, pending, error, setError } = useApprovalActions();

  const [queue, setQueue] = useState<ReviewDeckItem[]>(items);
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const [askReject, setAskReject] = useState(false);

  const current = queue[0] ?? null;
  const total = items.length;
  const decided = total - queue.length;
  const position = total > 0 ? Math.min(decided + 1, total) : 0;

  // --- puntatore ------------------------------------------------------------
  const cardRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const target = useRef<Pt>({ x: 0, y: 0 });
  const shown = useRef<Pt>({ x: 0, y: 0 });
  const pointerLive = useRef(false);
  const dragged = useRef(false);
  const exitingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const running = useRef(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Rettangolo cache: misurarlo a ogni pointermove riporterebbe dentro la
  // normalizzazione il transform che stiamo scrivendo (feedback loop) e
  // costerebbe un layout read per evento.
  const rectRef = useRef<DOMRect | null>(null);

  const measure = useCallback(() => {
    const el = cardRef.current;
    rectRef.current = el ? el.getBoundingClientRect() : null;
  }, []);

  useEffect(() => {
    const onViewportChange = () => measure();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [measure]);

  const write = useCallback(
    (p: Pt) => {
      if (exitingRef.current) return;
      const el = cardRef.current;
      if (!el) return;
      const px = p.x;
      const py = p.y;
      const shift = px * MAX_SHIFT_PX;
      const lift = -py * MAX_LIFT_PX;
      const rot = px * MAX_ROT_DEG;
      el.style.transform = `translate3d(${shift}px, ${lift}px, 0) rotate(${rot}deg)`;
      if (leftRef.current) leftRef.current.style.opacity = String(clamp(-px, 0, 1));
      if (rightRef.current) rightRef.current.style.opacity = String(clamp(px, 0, 1));
    },
    []
  );

  const tick = useCallback(() => {
    const c = shown.current;
    const t = target.current;
    const k = pointerLive.current ? 0.34 : 0.16;
    c.x += (t.x - c.x) * k;
    c.y += (t.y - c.y) * k;
    write(c);
    const settled =
      !pointerLive.current &&
      Math.abs(t.x - c.x) < 0.002 &&
      Math.abs(t.y - c.y) < 0.002;
    if (settled) {
      c.x = t.x;
      c.y = t.y;
      write(c);
      running.current = false;
      rafRef.current = null;
      return;
    }
    rafRef.current = window.requestAnimationFrame(tick);
  }, [write]);

  const requestFrames = useCallback(() => {
    if (running.current) return;
    running.current = true;
    rafRef.current = window.requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (exitTimer.current) clearTimeout(exitTimer.current);
    };
  }, []);

  const resetTransform = useCallback(() => {
    target.current = { x: 0, y: 0 };
    pointerLive.current = false;
    requestFrames();
  }, [requestFrames]);

  const forgetRect = useCallback(() => {
    rectRef.current = null;
  }, []);

  // --- azioni ---------------------------------------------------------------

  /** Rimuove la card dalla coda locale: nessun refresh di pagina necessario. */
  const dropCurrent = useCallback(() => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
    setQueue((prev) => prev.slice(1));
    setExiting(null);
    exitingRef.current = false;
    dragged.current = false;
    target.current = { x: 0, y: 0 };
    shown.current = { x: 0, y: 0 };
    const el = cardRef.current;
    if (el) {
      el.style.transition = "";
      el.style.opacity = "";
      el.style.transform = "";
    }
    if (leftRef.current) leftRef.current.style.opacity = "0";
    if (rightRef.current) rightRef.current.style.opacity = "0";
  }, []);

  /** Animazione di uscita + avanzamento alla card successiva. */
  const advance = useCallback(
    (dir: "left" | "right") => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      setExiting(dir);
      const el = cardRef.current;
      if (el && !reduced) {
        const off = dir === "right" ? 130 : -130;
        const angle = dir === "right" ? 14 : -14;
        el.style.transition = `transform ${EXIT_MS}ms cubic-bezier(.2,.7,.3,1), opacity ${EXIT_MS}ms linear`;
        el.style.transform = `translate3d(${off}%, 0, 0) rotate(${angle}deg)`;
        el.style.opacity = "0";
        exitTimer.current = setTimeout(dropCurrent, EXIT_MS);
        return;
      }
      dropCurrent();
    },
    [dropCurrent, reduced]
  );

  const doApprove = useCallback(() => {
    const item = current;
    if (!item || pending || exitingRef.current) return;
    // Click su metà card e frecce della tastiera devono rispettare lo stesso
    // gate del pulsante "Approva": senza questo l'azione partiva comunque e
    // il rifiuto del server restava senza alcun feedback per l'utente.
    if (!item.caption || item.caption.trim().length === 0) {
      setError("La caption è obbligatoria per approvare.");
      return;
    }
    setError(null);
    approve(item.id, undefined, () => advance("right"));
  }, [advance, approve, current, pending, setError]);

  const doReject = useCallback(
    (note?: string) => {
      const item = current;
      if (!item || pending || exitingRef.current) return;
      setError(null);
      reject(item.id, note, () => {
        // Chiude il dialog: senza questa chiusura restava aperto sopra la
        // card successiva anche dopo un rifiuto riuscito.
        setAskReject(false);
        advance("left");
      });
    },
    [advance, current, pending, reject, setError]
  );

  const openContent = useCallback(() => {
    if (!current) return;
    router.push(`/contents/${current.id}`);
  }, [current, router]);

  // --- eventi puntatore -----------------------------------------------------

  const normalized = (e: React.PointerEvent<HTMLDivElement>): Pt => {
    const rect = rectRef.current ?? e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: clamp((e.clientX - rect.left - rect.width / 2) / (rect.width / 2), -1, 1),
      y: clamp((e.clientY - rect.top - rect.height / 2) / (rect.height / 2), -1, 1),
    };
  };

  const onPointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    measure();
    pointerLive.current = true;
    target.current = normalized(e);
    requestFrames();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduced) return;
    const p = normalized(e);
    if (Math.abs(p.x) > DRAG_MARK) dragged.current = true;
    target.current = p;
    requestFrames();
  };

  const onPointerLeave = () => {
    dragged.current = false;
    forgetRect();
    resetTransform();
  };

  const onPointerDown = () => {
    dragged.current = false;
    measure();
  };

  // Il sistema può annullare il gesto (scroll, presa multi-touch, browser):
  // senza questo reset la card resterebbe ruotata e gli overlay visibili.
  const onPointerCancel = () => {
    dragged.current = false;
    forgetRect();
    resetTransform();
  };

  // Swipe: solo su touch/pen. Su desktop il mouse usa hover + click.
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" && !exitingRef.current && !pending) {
      const rect = rectRef.current ?? e.currentTarget.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
        if (dx > 0) doApprove();
        else setAskReject(true);
      }
    }
    forgetRect();
    resetTransform();
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if ((e.target as HTMLElement).closest("a,button")) return;
    if (pending || exitingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX >= rect.left + rect.width / 2) doApprove();
    else setAskReject(true);
  };

  // --- tastiera -------------------------------------------------------------
  // Lo shell è focalizzabile e prende il focus all'ingresso nella vista.
  // Le scorciatoie non rubano input a campi di testo, select o dialog.
  useEffect(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (askReject || pending || exitingRef.current) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      t?.isContentEditable
    ) {
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      doApprove();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setAskReject(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openContent();
    }
  };

  // --- stati vuoti ----------------------------------------------------------

  if (total === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Nessun contenuto da approvare"
          description="Quando crei un contenuto, la bozza resta in attesa qui finché non la approvi o la scarti."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href={allHref} variant="secondary" size="sm">
                Tutti i contenuti
              </LinkButton>
            </div>
          }
        />
      </div>
    );
  }

  if (!current) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <EmptyState
          title="Coda svuotata"
          description={`Hai deciso su tutti i ${total} contenuti in attesa.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href={allHref} size="sm">
                Tutti i contenuti
              </LinkButton>
              <LinkButton href={historyHref} variant="secondary" size="sm">
                Storico decisioni
              </LinkButton>
            </div>
          }
        />
        <p className="text-center text-xs text-slate-400">
          Le approvazioni portano il contenuto in stato Approvato: da lì lo
          programmi e pubblichi.
        </p>
      </div>
    );
  }

  const noCaption = !current.caption || current.caption.trim().length === 0;
  const noMedia = current.assets.length === 0 && current.slideImages.length === 0;
  const instagramNoMedia =
    noMedia && current.platforms.some((p) => p.platform === "INSTAGRAM");
  const blocked = pending || exiting !== null;

  return (
    <div
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Revisione dei contenuti in attesa di approvazione"
      className="mx-auto max-w-2xl outline-none"
    >
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="text-xs font-medium text-slate-400">
          {position} / {total}
        </p>
        <p className="hidden text-xs text-slate-400 sm:block">
          <kbd className="rounded border border-slate-200 bg-white px-1">←</kbd>{" "}
          scarta ·{" "}
          <kbd className="rounded border border-slate-200 bg-white px-1">→</kbd>{" "}
          approva ·{" "}
          <kbd className="rounded border border-slate-200 bg-white px-1">Invio</kbd>{" "}
          apri
        </p>
      </div>

      {totalPending > total ? (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          In coda ci sono {totalPending} bozze: viene mostrata la più vecchia
          ({total}).
        </p>
      ) : null}

      <div className="relative mx-auto w-full max-w-md pb-2">
        {/* Profondità: due carte statiche dietro, nessun costo di layout. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-4 -bottom-1 h-full rounded-2xl border border-slate-200 bg-white/70"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-2 top-2 h-full rounded-2xl border border-slate-200 bg-white"
        />

        <div
          ref={cardRef}
          role="group"
          aria-label={`Contenuto in attesa: ${current.title ?? "senza titolo"}`}
          onPointerEnter={onPointerEnter}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onClick={onClick}
          style={{ touchAction: "pan-y" }}
          className={cn(
            "deck-card relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg select-none",
            reduced && "deck-card-reduced"
          )}
        >
          {/* Overlay di anteprima: opacità pilotata dal puntatore via ref. */}
          <div
            ref={leftRef}
            aria-hidden
            style={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-start bg-gradient-to-r from-red-600/90 via-red-600/55 to-transparent pl-5"
          >
            <span className="inline-flex items-center rounded-lg bg-white/95 px-3 py-1.5 text-sm font-bold uppercase tracking-wide text-red-700 shadow">
              Scarta
            </span>
          </div>
          <div
            ref={rightRef}
            aria-hidden
            style={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-end bg-gradient-to-l from-emerald-600/90 via-emerald-600/55 to-transparent pr-5"
          >
            <span className="inline-flex items-center rounded-lg bg-white/95 px-3 py-1.5 text-sm font-bold uppercase tracking-wide text-emerald-700 shadow">
              Approva
            </span>
          </div>

          <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
            <DeckMedia item={current} />
            <div className="absolute left-2 top-2 flex flex-wrap gap-1">
              <TypeBadge type={current.type} className="bg-white/90" />
              {current.type === "CAROUSEL" ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/90 px-2 py-0.5 text-xs font-medium text-slate-600">
                  <Layers className="h-3 w-3" /> {current.slideImages.length} slide
                </span>
              ) : null}
            </div>
            {current.assets.length > 1 ? (
              <span className="absolute bottom-2 right-2 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-white">
                +{current.assets.length - 1}
              </span>
            ) : null}
          </div>

          <div className="flex flex-1 flex-col gap-3 p-5">
            <h2 className="text-base font-semibold text-slate-900">
              {current.title ?? "Senza titolo"}
            </h2>

            {current.caption ? (
              <p className="whitespace-pre-line text-sm text-slate-600">
                {current.caption}
              </p>
            ) : (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Caption mancante: obbligatoria per approvare.
              </p>
            )}

            {current.hashtags ? (
              <p className="text-xs text-sky-700">{current.hashtags}</p>
            ) : null}

            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
              <PlatformBadges platforms={current.platforms} />
              {current.scheduledDate ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
                  <CalendarClock className="h-3 w-3" />
                  {formatDate(current.scheduledDate, "dd/MM/yyyy HH:mm")}
                </span>
              ) : null}
            </div>

            {noMedia ? (
              <p
                className={cn(
                  "inline-flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs",
                  instagramNoMedia
                    ? "border border-amber-200 bg-amber-50 text-amber-800"
                    : "border border-slate-200 bg-slate-50 text-slate-600"
                )}
              >
                {instagramNoMedia ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                {instagramNoMedia
                  ? "Media mancante: Instagram richiede almeno un'immagine o un video. Apri il contenuto per aggiungerlo."
                  : "Nessun media associato."}
              </p>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Azioni accessibili: funzionano senza hover, senza swipe e con tastiera. */}
      <div className="mt-4 flex items-center justify-center gap-3">
        <Button
          variant="danger"
          size="md"
          onClick={() => setAskReject(true)}
          disabled={blocked}
          aria-label="Scarta questo contenuto"
        >
          Scarta
        </Button>
        <Button
          variant="success"
          size="md"
          onClick={doApprove}
          disabled={noCaption || blocked}
          title={noCaption ? "La caption è obbligatoria per approvare" : undefined}
          aria-label="Approva questo contenuto"
        >
          Approva
        </Button>
      </div>

      <div className="mt-3 flex justify-center">
        <Link
          href={`/contents/${current.id}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-sky-700"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Apri contenuto completo
        </Link>
      </div>

      <p className="mt-2 text-center text-[11px] text-slate-400">
        Approvare porta il contenuto in stato Approvato. Programmare e pubblicare
        restano nel contenuto completo.
      </p>

      <RejectReasonDialog
        open={askReject}
        busy={pending}
        error={error}
        onClose={() => setAskReject(false)}
        onConfirm={doReject}
      />
    </div>
  );
}
