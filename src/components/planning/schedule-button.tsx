"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { it } from "date-fns/locale";
import { scheduleAction, unscheduleAction } from "@/lib/actions/content";
import { Button } from "@/components/ui";
import { cn, formatDate } from "@/lib/utils";

const WEEKDAYS = ["Lu", "Ma", "Me", "Gi", "Ve", "Sa", "Do"];

function toDayISO(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  // Mezzogiorno locale: evita slittamenti di fuso sul giorno scelto.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00:00`;
}

/**
 * Pulsante di programmazione: apre un mini calendario (mese) dove si clicca il
 * giorno desiderato; il contenuto viene programmato e la pagina si aggiorna.
 */
export function ScheduleButton({
  contentId,
  scheduledDate,
}: {
  contentId: string;
  scheduledDate: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Date>(() =>
    startOfMonth(scheduledDate ? new Date(scheduledDate) : new Date())
  );
  const router = useRouter();

  async function schedule(day: Date) {
    setBusy(true);
    setErr(null);
    const res = await scheduleAction(contentId, toDayISO(day));
    setBusy(false);
    if (!res.ok) {
      setErr(res.message ?? "Errore di programmazione");
    } else {
      setOpen(false);
      router.refresh();
    }
  }

  async function unschedule() {
    setBusy(true);
    setErr(null);
    const res = await unscheduleAction(contentId);
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  const gridStart = startOfWeek(viewport, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(viewport), { weekStartsOn: 1 });
  const cells: Date[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    cells.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const scheduled = scheduledDate ? new Date(scheduledDate) : null;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant={scheduledDate ? "success" : "secondary"}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <CalendarClock className="h-3.5 w-3.5" />
        {scheduledDate ? formatDate(new Date(scheduledDate), "dd/MM") : "Programma"}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative z-10 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Mese precedente"
                onClick={() => setViewport((v) => addMonths(v, -1))}
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold capitalize text-slate-800 dark:text-slate-200">
                {format(viewport, "MMMM yyyy", { locale: it })}
              </span>
              <button
                type="button"
                aria-label="Mese successivo"
                onClick={() => setViewport((v) => addMonths(v, 1))}
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((w) => (
                <div
                  key={w}
                  className="flex h-7 items-center justify-center text-[11px] font-semibold text-slate-400"
                >
                  {w}
                </div>
              ))}

              {cells.map((d) => {
                const inMonth = isSameMonth(d, viewport);
                const today = isToday(d);
                const isScheduled = scheduled ? isSameDay(d, scheduled) : false;
                return (
                  <button
                    key={d.toISOString()}
                    type="button"
                    disabled={busy || !inMonth}
                    onClick={() => schedule(d)}
                    className={cn(
                      "flex h-8 items-center justify-center rounded-md text-sm transition-colors",
                      !inMonth && "text-slate-300",
                      inMonth && "text-slate-700 dark:text-slate-300 hover:bg-sky-50 hover:text-sky-700",
                      today && "font-bold text-sky-600",
                      isScheduled && "bg-sky-600 font-semibold text-white hover:bg-sky-700 hover:text-white"
                    )}
                  >
                    {format(d, "d")}
                  </button>
                );
              })}
            </div>

            {scheduledDate && (
              <Button
                size="sm"
                variant="danger"
                className="mt-2 w-full"
                disabled={busy}
                onClick={unschedule}
              >
                <X className="h-3.5 w-3.5" />
                Rimuovi programmazione
              </Button>
            )}

            {err ? <p className="mt-2 text-xs text-red-600">{err}</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
