import Link from "next/link";
import {
  addDays,
  addMonths,
  format,
  isSameDay,
  isSameMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
} from "date-fns";
import { it } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getCalendarByDay } from "@/lib/services/calendar";
import { Card, PageHeader, LinkButton, StatusBadge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PLATFORM_LABELS } from "@/lib/status";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ m?: string; y?: string }>;

const WEEKDAYS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

function toLocalISODate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const now = new Date();
  const month = params.m ? Number(params.m) : now.getMonth();
  const year = params.y ? Number(params.y) : now.getFullYear();
  const current = new Date(year, month, 1);

  const from = startOfWeek(current, { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(current), { weekStartsOn: 1 });

  const items = await getCalendarByDay({ from, to }).catch((e) => {
    console.error("[page:calendar] caricamento fallito", e);
    return [] as Awaited<ReturnType<typeof getCalendarByDay>>;
  });
  const byDay = new Map<string, (typeof items)[number]["contents"]>();
  for (const item of items) {
    byDay.set(toLocalISODate(item.date), item.contents);
  }

  const days = [];
  let cursor = from;
  while (!isSameDay(cursor, to) || days.length === 0) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const prev = addMonths(current, -1);
  const next = addMonths(current, 1);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Calendario"
        description="Contenuti programmati e pubblicati, mese per mese."
        action={
          <div className="flex items-center gap-2">
            <LinkButton
              href={`/calendar?m=${prev.getMonth()}&y=${prev.getFullYear()}`}
              variant="secondary"
              size="sm"
              aria-label="Mese precedente"
            >
              <ChevronLeft className="h-4 w-4" />
            </LinkButton>
            <span className="min-w-36 text-center text-sm font-semibold text-slate-700">
              {format(current, "MMMM yyyy", { locale: it })}
            </span>
            <LinkButton
              href={`/calendar?m=${next.getMonth()}&y=${next.getFullYear()}`}
              variant="secondary"
              size="sm"
              aria-label="Mese successivo"
            >
              <ChevronRight className="h-4 w-4" />
            </LinkButton>
          </div>
        }
      />

      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const key = toLocalISODate(d);
            const dayContents = byDay.get(key) ?? [];
            const today = isSameDay(d, now);
            const inMonth = isSameMonth(d, current);
            return (
              <div
                key={key}
                className={cn(
                  "min-h-28 border-b border-r border-slate-100 p-1.5",
                  i % 7 === 6 && "border-r-0",
                  !inMonth && "bg-slate-50/60"
                )}
              >
                <div
                  className={cn(
                    "mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                    today
                      ? "bg-sky-600 text-white"
                      : inMonth
                        ? "text-slate-700"
                        : "text-slate-400"
                  )}
                >
                  {format(d, "d")}
                </div>
                <div className="space-y-1">
                  {dayContents.map((c) => {
                    const thumb = c.assets.find(
                      (a) => a.kind === "IMAGE" && /\.(png|jpe?g|webp|gif|avif)$/i.test(a.url)
                    );
                    return (
                      <Link
                        key={c.id}
                        href={`/contents/${c.id}`}
                        className="flex gap-1.5 rounded-md border border-transparent bg-sky-50 px-1.5 py-1 text-[10px] leading-snug text-sky-700 transition-colors hover:border-sky-200"
                      >
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumb.url}
                            alt=""
                            className="h-7 w-7 shrink-0 rounded object-cover"
                          />
                        ) : null}
                        <span className="min-w-0">
                          <span className="line-clamp-2 block font-medium">
                            {c.title ?? "Senza titolo"}
                          </span>
                          <span className="block text-slate-400">
                            {c.scheduledDate ? format(c.scheduledDate, "HH:mm") : ""}
                            {" · "}
                            {c.platforms
                              .map((p) => PLATFORM_LABELS[p.platform])
                              .join("/")}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                  {dayContents.length > 3 ? (
                    <div className="px-1 text-[10px] font-medium text-slate-400">
                      +{dayContents.length - 3} altri
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">Legenda:</span>
        <StatusBadge status="SCHEDULED" />
        <StatusBadge status="PUBLISHED" />
      </div>
    </div>
  );
}