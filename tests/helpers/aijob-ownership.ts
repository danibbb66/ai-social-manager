import type { AIJobKind } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";

/**
 * Chi possiede un AIJob creato da una suite di test.
 *
 * `recordJob` (src/lib/ai/generate.ts) crea i job senza `contentId`: la
 * colonna resta null e l'id del contenuto compare, quando c'è, solo dentro
 * `input`. Nelle suite reali la maggior parte dei job ha `contentId: null`
 * anche in input, perché al momento in cui la pipeline genera la caption il
 * contenuto non è ancora stato creato. Per questo la proprietà non si può
 * basare sul solo legame col contenuto.
 *
 * Il criterio è sempre l'identità del record, mai il tempo:
 *   1. `contentId` (colonna) tra i contenuti creati dalla suite;
 *   2. `contentId` dentro `input` tra quegli stessi contenuti;
 *   3. `kind` tra quelli che la suite genera davvero **e** id assente dallo
 *      snapshot preso prima delle fixture.
 *
 * I filtri JSON path di Prisma non funzionano su SQLite, quindi il confronto
 * su `input` avviene in memoria.
 *
 * I job vanno cancellati PRIMA dei contenuti: `deleteContent` azzera
 * `contentId` (SetNull) e dopo quella perdita di legame il criterio 1 non
 * scatterebbe più.
 *
 * @param kinds Tipi di job che la suite produce. Restare stretti è
 *   voluto: un tipo in più non farebbe pulizia, ma allargherebbe la finestra
 *   in cui un job estraneo creato contemporaneamente potrebbe essere scelto.
 */
export function createJobOwnership(kinds: readonly AIJobKind[]) {
  let preExistingJobIds = new Set<string>();

  function inputContentId(input: unknown): string | null {
    if (typeof input !== "object" || input === null) return null;
    const value = (input as { contentId?: unknown }).contentId;
    return typeof value === "string" ? value : null;
  }

  return {
    /** Da chiamare in `before`, prima che qualunque fixture crei record. */
    async capture(): Promise<void> {
      preExistingJobIds = new Set(
        (await prisma.aIJob.findMany({ select: { id: true } })).map((job) => job.id)
      );
    },

    /**
     * Cancella solo i job della suite e restituisce quanti ne ha toccati.
     * Va chiamata prima di cancellare i contenuti.
     */
    async deleteOwned(contentIds: readonly string[]): Promise<number> {
      const jobs = await prisma.aIJob.findMany({
        where: {
          OR: [{ kind: { in: [...kinds] } }, { contentId: { in: [...contentIds] } }],
        },
        select: { id: true, kind: true, contentId: true, input: true },
      });

      const mine = new Set<string>();
      for (const job of jobs) {
        if (job.contentId && contentIds.includes(job.contentId)) {
          mine.add(job.id);
          continue;
        }
        const fromInput = inputContentId(job.input);
        if (fromInput && contentIds.includes(fromInput)) {
          mine.add(job.id);
          continue;
        }
        if (kinds.includes(job.kind) && !preExistingJobIds.has(job.id)) {
          mine.add(job.id);
        }
      }

      // `in: []` non è un filtro valido: niente da cancellare, niente da fare.
      if (mine.size === 0) return 0;
      await prisma.aIJob.deleteMany({ where: { id: { in: [...mine] } } });
      return mine.size;
    },
  };
}
