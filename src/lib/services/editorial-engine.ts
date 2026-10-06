/**
 * Motore editoriale infinito: un DRAFT al giorno, per sempre.
 *
 * Contratto:
 *  - un solo DRAFT al giorno, senza data di fine (mai `scheduledDate`);
 *  - venerdì il post nasce dal verticale locandina → creatività sociale
 *    (`createFlyerSocialDraft`, V1.1);
 *  - gli altri giorni nasce da `createContent` con `fromCatalog: true`,
 *    ancorato a una proposta ACTIVE reale del Catalogo;
 *  - mai `approveContent`, `scheduleContent` o `publishContent`: la revisione
 *    e la pubblicazione restano decisioni umane;
 *  - ogni esecuzione è un `EditorialRun` con idempotenza su (data, tipo);
 *  - un fallimento lascia un run FAILED e nessun contenuto parziale.
 *
 * Il catalogo viene riallineato all'inizio di ogni esecuzione con il
 * meccanismo di import già esistente (`syncOfferteCatalog`): se il sito
 * aggiunge offerte, i giorni futuri le trovano e la selezione le propone per
 * prime (mette prima le proposte mai usate).
 */

import type { EditorialRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncOfferteCatalog } from "@/lib/services/catalog";
import { promotable, selectCatalogProposalForAi } from "@/lib/services/catalog-ai";
import { createFlyerSocialDraft } from "@/lib/services/flyer-social";
import { createContentTool } from "@/lib/ai/tools/content";

export const EDITORIAL_KIND_FLYER = "FLYER_SOCIAL" as const;
export const EDITORIAL_KIND_CATALOG = "CATALOG_CONTENT" as const;
export type EditorialKind = typeof EDITORIAL_KIND_FLYER | typeof EDITORIAL_KIND_CATALOG;

export interface EditorialRunRecord {
  id: string;
  date: string;
  kind: EditorialKind;
  status: EditorialRunStatus;
  contentId: string | null;
  proposalId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EditorialRunOutcome {
  reused: boolean;
  run: EditorialRunRecord;
  error?: string;
}

/** Venerdì: giorno della locandina. `getDay()`: 0 = domenica, 5 = venerdì. */
const FRIDAY = 5;

export function editorialKindForDate(date: Date): EditorialKind {
  return date.getDay() === FRIDAY ? EDITORIAL_KIND_FLYER : EDITORIAL_KIND_CATALOG;
}

/** Chiave di idempotenza: la data del giorno nel timezone locale del server. */
export function editorialDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Esegue il motore per un giorno (default: oggi).
 *
 * Idempotente su (data, tipo): se esiste già un run per quel giorno e quel
 * ramo, lo restituisce senza creare nulla. In caso di errore il run resta
 * FAILED con il motivo: i servizi di creazione hanno già annullato le proprie
 * scritture (transazioni e pulizia file), quindi non esistono contenuti
 * parziali da riparare.
 */
export async function runDailyEditorial(options: { date?: Date } = {}): Promise<EditorialRunOutcome> {
  const date = options.date ?? new Date();
  const key = editorialDateKey(date);
  const kind = editorialKindForDate(date);

  const existing = await prisma.editorialRun.findUnique({
    where: { date_kind: { date: key, kind } },
  });
  if (existing) return { reused: true, run: existing as EditorialRunRecord };

  const run = await prisma.editorialRun.create({
    data: { date: key, kind, status: "RUNNING" },
  });

  try {
    // 1. Riallinea il catalogo con l'import esistente: offerte nuove o
    //    aggiornate diventano subito promuovibili nei giorni futuri.
    await syncOfferteCatalog();

    if (kind === EDITORIAL_KIND_FLYER) {
      // 2a. Venerdì: verticale locandina → creatività V1.1. La proposta viene
      //     scelta dalla stessa strategia del catalogo: promuovibile (ACTIVE,
      //     con immagine ufficiale), mai usata prima.
      const dto = await selectCatalogProposalForAi();
      if (!dto || !promotable(dto)) {
        throw new Error(
          "Nessuna proposta di catalogo promuovibile (ACTIVE, con immagine ufficiale): nessun contenuto è stato creato."
        );
      }
      const result = await createFlyerSocialDraft({ proposalId: dto.id, platforms: ["INSTAGRAM"] });
      if (!result.ok) throw new Error(result.message);
      const updated = await prisma.editorialRun.update({
        where: { id: run.id },
        data: { status: "SUCCESS", contentId: result.content.id, proposalId: dto.id },
      });
      return { reused: false, run: updated as EditorialRunRecord };
    }

    // 2b. Giorno normale: `createContent` con `fromCatalog: true`. La proposta
    //     è scelta e verificata dal flusso catalogo (una ACTIVE reale, niente
    //     invenzioni); il DRAFT nasce con il visuale già a terra.
    const result = await createContentTool.execute({ fromCatalog: true, platforms: ["INSTAGRAM"] });
    if (!result.ok) throw new Error(result.message);
    const data = result.data as { id?: string | null; catalogProposalId?: string | null } | undefined;
    const contentId = data?.id ?? null;
    if (!contentId) {
      throw new Error("createContent non ha restituito un contenuto: nessun DRAFT creato.");
    }
    const updated = await prisma.editorialRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", contentId, proposalId: data?.catalogProposalId ?? null },
    });
    return { reused: false, run: updated as EditorialRunRecord };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failed = await prisma.editorialRun.update({
      where: { id: run.id },
      data: { status: "FAILED", error: message },
    });
    return { reused: false, run: failed as EditorialRunRecord, error: message };
  }
}
