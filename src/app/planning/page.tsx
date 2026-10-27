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
import { listContents } from "@/lib/services/content";
import {
  Card,
  PageHeader,
  LinkButton,
  StatusBadge,
  TypeBadge,
  PlatformBadges,
  MediaThumb,
  MediaPlaceholder,
  EmptyState,
} from "@/components/ui";
import { ScheduleButton } from "@/components/planning/schedule-button";
import { cn } from "@/lib/utils";
import { PLATFORM_LABELS } from "@/lib/status";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ m?: string; y?: string }>;

const WEEKDAYS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

function toLocalISODate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default async function PlanningPage({
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

  const [items, contents] = await Promise.all([
    getCalendarByDay({ from, to }).catch((e) => {
      console.error("[page:planning] calendario", e);
      return [] as Awaited<ReturnType<typeof getCalendarByDay>>;
    }),
    listContents({ limit: 100 }).catch((e) => {
      console.error("[page:planning] contenuti", e);
      return [] as Awaited<ReturnType<typeof listContents>>;
    }),
  ]);

  const byDay = new Map<string, (typeof items)[number]["contents"]>();
  for (const item of items) {
    byDay.set(toLocalISODate(item.date), item.contents);
  }

  const days: Date[] = [];
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
        title="Pianificazione"
        description="Calendario e contenuti in un'unica vista: scegli il giorno e programma ogni video o post in tempo reale."
      />

      {/* Calendario grande */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <LinkButton
            href={`/planning?m=${prev.getMonth()}&y=${prev.getFullYear()}`}
            variant="secondary"
            size="sm"
            aria-label="Mese precedente"
          >
            <ChevronLeft className="h-4 w-4" />
          </LinkButton>
          <span className="min-w-40 text-center text-base font-semibold capitalize text-slate-800">
            {format(current, "MMMM yyyy", { locale: it })}
          </span>
          <LinkButton
            href={`/planning?m=${next.getMonth()}&y=${next.getFullYear()}`}
            variant="secondary"
            size="sm"
            aria-label="Mese successivo"
          >
            <ChevronRight className="h-4 w-4" />
          </LinkButton>
        </div>

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
                  "min-h-32 border-b border-r border-slate-100 p-1.5",
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
                        ) : (
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-sky-100 text-[8px] font-bold">
                            {c.type === "VIDEO" ? "VID" : "POST"}
                          </div>
                        )}
                        <span className="min-w-0">
                          <span className="line-clamp-2 block font-medium">
                            {c.title ?? "Senza titolo"}
                          </span>
                          <span className="block text-slate-400">
                            {c.scheduledDate ? format(c.scheduledDate, "HH:mm") : ""}
                            {" · "}
                            {c.platforms.map((p) => PLATFORM_LABELS[p.platform]).join("/")}
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

      {/* Elenco contenuti */}
      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Contenuti ({contents.length})
          </h2>
        </div>

        {contents.length === 0 ? (
          <EmptyState
            title="Nessun contenuto"
            description="Crea video e post dalla sezione «Crea video & post», poi programmali qui giorno per giorno."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {contents.map((c) => {
              const first =
                c.assets.find((a) => a.kind === "IMAGE") ?? c.assets[0];
              return (
                <div
                  key={c.id}
                  className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-all hover:border-sky-300 hover:shadow-md"
                >
                  <Link
                    href={`/contents/${c.id}`}
                    className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100"
                  >
                    {first ? (
                      <MediaThumb asset={first} className="h-full w-full" />
                    ) : (
                      <MediaPlaceholder className="h-full w-full" />
                    )}
                  </Link>

                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 text-sm font-semibold text-slate-900">
                        {c.title ?? "Senza titolo"}
                      </h3>
                      <StatusBadge status={c.status} className="shrink-0" />
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <TypeBadge type={c.type} />
                      <PlatformBadges platforms={c.platforms} />
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                      <span className="text-[11px] text-slate-400">
                        {c.scheduledDate
                          ? `Programmato ${format(c.scheduledDate, "dd/MM/yyyy")}`
                          : "Non programmato"}
                      </span>
                      <ScheduleButton
                        contentId={c.id}
                        scheduledDate={c.scheduledDate ? c.scheduledDate.toISOString() : null}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
