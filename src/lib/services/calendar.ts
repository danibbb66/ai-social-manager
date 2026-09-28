import { prisma } from "@/lib/prisma";
import { listContents } from "@/lib/services/content";

export interface CalendarItem {
  date: Date;
  contents: Awaited<ReturnType<typeof listContents>>;
}

/** Contenuti programmati/pubblicati in un intervallo di date (per calendario) */
export async function getCalendar(range: { from: Date; to: Date }) {
  return listContents({
    from: range.from,
    to: range.to,
    status: ["SCHEDULED", "PUBLISHED"],
  });
}

/** Raggruppa per giorno */
export async function getCalendarByDay(range: { from: Date; to: Date }): Promise<CalendarItem[]> {
  const contents = await getCalendar(range);
  const map = new Map<string, CalendarItem>();
  for (const c of contents) {
    const d = c.scheduledDate ?? c.createdAt;
    const key = d.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, { date: d, contents: [] });
    map.get(key)!.contents.push(c);
  }
  return Array.from(map.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );
}

/** Sposta la programmazione di un contenuto (drag & drop sul calendario) */
export async function moveContentOnCalendar(
  id: string,
  newDate: Date
): Promise<{ id: string; scheduledDate: Date | null; status: string }> {
  const content = await prisma.content.findUnique({ where: { id } });
  if (!content) throw new Error("Contenuto non trovato.");

  if (!Number.isNaN(newDate.getTime()) && newDate.getTime() < Date.now() - 60_000) {
    throw new Error("La nuova data di programmazione non può essere nel passato.");
  }

  if (content.status !== "APPROVED" && content.status !== "SCHEDULED") {
    throw new Error(
      `Non puoi spostare nel calendario un contenuto in stato "${content.status}". Deve essere approvato (o già programmato).`
    );
  }

  const data = {
    scheduledDate: Number.isNaN(newDate.getTime()) ? null : newDate,
    status: "SCHEDULED" as const,
  };

  const updated = await prisma.content.update({
    where: { id },
    data,
  });
  return {
    id: updated.id,
    scheduledDate: updated.scheduledDate,
    status: updated.status,
  };
}