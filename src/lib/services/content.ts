import {
  ContentStatus,
  ContentType,
  Platform,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/status";
import { logAudit } from "@/lib/audit";

export type ContentPlatformInput = Platform[];

export interface ContentInput {
  type?: ContentType;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  status?: ContentStatus;
  scheduledDate?: Date | string | null;
  ideaId?: string | null;
  /**
   * Proposta del Catalogo Agenzia da cui deriva il contenuto. Null se il
   * contenuto è nato da una richiesta libera.
   */
  catalogProposalId?: string | null;
  platforms?: ContentPlatformInput;
  /** Slide del carousel (obbligatorie per il tipo CAROUSEL) */
  slides?: {
    title?: string | null;
    text?: string | null;
    imageUrl?: string | null;
    order?: number;
  }[];
}

const VALID_PLATFORMS: Platform[] = ["INSTAGRAM", "FACEBOOK", "TIKTOK"];

export function assertValidPlatforms(platforms: unknown): Platform[] {
  const parsed = parseJsonArray(platforms);
  for (const p of parsed) {
    if (!(VALID_PLATFORMS as string[]).includes(p)) {
      throw new Error(
        `Piattaforma non supportata: "${p}". Valori validi: ${VALID_PLATFORMS.join(", ")}.`
      );
    }
  }
  return parsed as Platform[];
}

/**
 * Regole di business per i contenuti, applicate lato server.
 * La caption testuale è obbligatoria per uscire dallo stato DRAFT.
 */
function assertContentReadyForPublishPath(content: {
  caption: string | null;
  type: ContentType;
  slides: { id: string }[];
}): void {
  if (content.type === "CAROUSEL" && content.slides.length === 0) {
    throw new Error(
      "Un contenuto CAROUSEL deve avere almeno una slide prima di procedere nel flusso. Usa crea carousel dalla chat o aggiungi le slide."
    );
  }
  if (!content.caption || !content.caption.trim()) {
    throw new Error(
      "La caption (testo) è obbligatoria prima di procedere con approvazione, programmazione o pubblicazione."
    );
  }
}

/** Valida la data di programmazione: valida e non nel passato. */
function assertFutureScheduledDate(date: Date | null | undefined, forSchedule = false): Date | null {
  if (!date) {
    if (forSchedule) {
      throw new Error("La programmazione richiede una data valida.");
    }
    return null;
  }
  if (Number.isNaN(date.getTime())) {
    throw new Error("Data di programmazione non valida.");
  }
  if (date.getTime() < Date.now() - 60_000) {
    throw new Error("La data di programmazione non può essere nel passato.");
  }
  return date;
}

export const contentInclude = {
  platforms: { include: { account: true } },
  assets: { orderBy: { createdAt: "asc" as const } },
  slides: { orderBy: { order: "asc" as const } },
  idea: true,
  approvals: { orderBy: { createdAt: "desc" as const }, take: 3 },
} satisfies Prisma.ContentInclude;

export type ContentWithRelations = Prisma.ContentGetPayload<{
  include: typeof contentInclude;
}>;

function normalizeDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

export async function listContents(opts?: {
  status?: ContentStatus | ContentStatus[];
  type?: ContentType;
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<ContentWithRelations[]> {
  const where: Prisma.ContentWhereInput = {};
  if (opts?.status) {
    where.status = Array.isArray(opts.status)
      ? { in: opts.status }
      : opts.status;
  }
  if (opts?.type) where.type = opts.type;
  if (opts?.search) {
    const q = opts.search;
    where.OR = [
      { title: { contains: q } },
      { caption: { contains: q } },
      { hashtags: { contains: q } },
    ];
  }
  if (opts?.from || opts?.to) {
    where.scheduledDate = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lte: opts.to } : {}),
    };
  }

  return prisma.content.findMany({
    where,
    include: contentInclude,
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "desc" }],
    take: opts?.limit ?? 200,
  });
}

export async function getContent(id: string): Promise<ContentWithRelations | null> {
  return prisma.content.findUnique({
    where: { id },
    include: contentInclude,
  });
}

export async function getContentOrThrow(id: string): Promise<ContentWithRelations> {
  const content = await getContent(id);
  if (!content) throw new Error(`Contenuto non trovato (${id}).`);
  return content;
}

export async function createContent(
  input: ContentInput
): Promise<ContentWithRelations> {
  const platforms = assertValidPlatforms(input.platforms);
  const type = input.type ?? "POST";
  const slides = input.slides ?? [];

  if (type === "CAROUSEL" && slides.length === 0) {
    throw new Error(
      "Un contenuto CAROUSEL deve avere almeno una slide. Usa l'operazione di creazione carousel."
    );
  }

  const scheduledDate = assertFutureScheduledDate(normalizeDate(input.scheduledDate), false);

  const content = await prisma.content.create({
    data: {
      type,
      title: input.title ?? null,
      caption: input.caption ?? null,
      hashtags: input.hashtags ?? null,
      status: input.status ?? "DRAFT",
      scheduledDate,
      ideaId: input.ideaId ?? null,
      catalogProposalId: input.catalogProposalId ?? null,
      platforms: {
        create: platforms.map((p) => ({
          platform: p,
          accountId: null,
        })),
      },
      ...(type === "CAROUSEL"
        ? {
            slides: {
              create: slides.map((s, i) => ({
                title: s.title ?? null,
                text: s.text ?? null,
                imageUrl: s.imageUrl ?? null,
                order: s.order ?? i + 1,
              })),
            },
          }
        : {}),
    },
    include: contentInclude,
  });

  await logAudit("CONTENT_CREATED", "Content", content.id, {
    type: content.type,
    title: content.title,
    status: content.status,
    platforms,
  });

  return content;
}

export async function updateContent(
  id: string,
  input: ContentInput & { slides?: unknown }
): Promise<ContentWithRelations> {
  const existing = await getContentOrThrow(id);
  const platforms = input.platforms ? assertValidPlatforms(input.platforms) : null;

  // Se si cambia lo stato direttamente, si applicano le stesse regole di sicurezza
  // usate da changeStatus (nessun bypass delle transizioni consentite).
  if (input.status && input.status !== existing.status) {
    if (!canTransition(existing.status, input.status)) {
      throw new Error(
        `Transizione non consentita: ${existing.status} → ${input.status}.`
      );
    }
    // APPROVED e PUBLISHED richiedono operazioni dedicate per non aggirare
    // la verifica dell'approvazione esplicita a livello di servizio.
    if (input.status === "APPROVED") {
      throw new Error(
        `Non puoi portare direttamente il contenuto in APPROVED: l'approvazione richiede l'azione esplicita di approvazione.`
      );
    }
    if (input.status === "PUBLISHED") {
      throw new Error(
        "La pubblicazione richiede il flusso di pubblicazione esplicito, non un semplice cambio di stato."
      );
    }
    const nextCaption = input.caption !== undefined ? input.caption ?? "" : existing.caption;
    const nextSlides =
      input.slides !== undefined && Array.isArray(input.slides)
        ? (input.slides as { id?: string }[])
        : existing.slides;
    if (
      input.status !== "DRAFT" &&
      input.status !== "REJECTED" &&
      input.status !== "FAILED"
    ) {
      assertContentReadyForPublishPath({
        caption: nextCaption,
        type: input.type ?? existing.type,
        slides: nextSlides as { id: string }[],
      });
    }
    if (input.status === "SCHEDULED") {
      assertFutureScheduledDate(
        normalizeDate(
          input.scheduledDate !== undefined ? input.scheduledDate : existing.scheduledDate
        ),
        true
      );
    }
  }

  const scheduledDate =
    input.scheduledDate !== undefined
      ? assertFutureScheduledDate(normalizeDate(input.scheduledDate), false)
      : undefined;

  const [, updated] = await prisma.$transaction([
    prisma.contentPlatform.deleteMany({ where: { contentId: id } }),
    prisma.content.update({
      where: { id },
      data: {
        ...(input.type ? { type: input.type } : {}),
        ...(input.title !== undefined ? { title: input.title ?? null } : {}),
        ...(input.caption !== undefined ? { caption: input.caption ?? null } : {}),
        ...(input.hashtags !== undefined ? { hashtags: input.hashtags ?? null } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(scheduledDate !== undefined
          ? { scheduledDate: scheduledDate ?? null }
          : {}),
        ...(input.ideaId !== undefined ? { ideaId: input.ideaId ?? null } : {}),
        ...(platforms
          ? {
              platforms: {
                create: platforms.map((p) => ({
                  platform: p,
                  accountId: null,
                })),
              },
            }
          : {}),
      },
      include: contentInclude,
    }),
  ]);

  await logAudit("CONTENT_UPDATED", "Content", id, {
    type: updated.type,
    title: updated.title,
    status: updated.status,
    platforms,
  });

  return updated;
}

/**
 * Cambio di stato con verifica delle transizioni consentite e regole di business.
 * - caption obbligatoria per APPROVED/SCHEDULED/PUBLISHED
 * - CAROUSEL: almeno una slide per uscire da DRAFT
 * - SCHEDULED: richiede una data valida e futura
 */
export async function changeStatus(
  id: string,
  target: ContentStatus,
  note?: string
): Promise<ContentWithRelations> {
  const content = await getContentOrThrow(id);
  if (!canTransition(content.status, target)) {
    throw new Error(
      `Transizione non consentita: ${content.status} → ${target}.`
    );
  }
  if (target === "REJECTED" && !note) {
    note = "Rifiutato senza motivazione";
  }

  // APPROVED e PUBLISHED richiedono operazioni dedicate (approvazione/pubblicazione
  // esplicita) e non possono essere raggiunti con un cambio di stato generico:
  // in questo modo il record di approvazione non può essere aggirato.
  if (target === "APPROVED" && content.status !== "APPROVED") {
    throw new Error(
      `Non puoi portare direttamente il contenuto in APPROVED: l'approvazione richiede l'azione esplicita di approvazione.`
    );
  }
  if (target === "PUBLISHED") {
    throw new Error(
      "La pubblicazione richiede il flusso di pubblicazione esplicito, non un semplice cambio di stato."
    );
  }

  if (["APPROVED", "SCHEDULED", "PUBLISHED"].includes(target)) {
    assertContentReadyForPublishPath(content);
  }
  if (target === "SCHEDULED") {
    assertFutureScheduledDate(content.scheduledDate, true);
  }

  const updated = await prisma.$transaction(
    async (tx) => {
      const updatedContent = await tx.content.update({
        where: { id },
        data: { status: target },
        include: contentInclude,
      });

      if (target === "REJECTED") {
        await tx.approval.create({
          data: { contentId: id, decision: "REJECTED", note },
        });
      }

      return updatedContent;
    },
    { timeout: 15_000 }
  );

  if (target === "REJECTED") {
    await logAudit("CONTENT_REJECTED", "Content", id, { note });
  }

  await logAudit("CONTENT_STATUS_CHANGED", "Content", id, {
    from: content.status,
    to: target,
    note,
  });

  return updated;
}

/** Rifiuto esplicito con motivazione (DRAFT → REJECTED) */
export async function rejectContent(
  id: string,
  note?: string
): Promise<ContentWithRelations> {
  return changeStatus(id, "REJECTED", note);
}

/**
 * Approvazione ESPLICITA: crea un record Approval e porta il contenuto APPROVED.
 * È l'unico varco applicativo verso APPROVED (DRAFT → APPROVED).
 * Atomic via transaction.
 */
export async function approveContent(
  id: string,
  note?: string
): Promise<ContentWithRelations> {
  const content = await getContentOrThrow(id);
  if (content.status !== "DRAFT") {
    throw new Error(
      `Il contenuto è in stato "${content.status}". Per approvarlo deve essere "Bozza" (DRAFT).`
    );
  }
  assertContentReadyForPublishPath(content);

  const updated = await prisma.$transaction(
    async (tx) => {
      await tx.approval.create({
        data: { contentId: id, decision: "APPROVED", note: note ?? null },
      });
      return tx.content.update({
        where: { id },
        data: { status: "APPROVED" },
        include: contentInclude,
      });
    },
    { timeout: 15_000 }
  );

  await logAudit("CONTENT_APPROVED", "Content", id, { note });

  return updated;
}

/**
 * Programma il contenuto: richiede stato APPROVED e data valida e futura.
 */
export async function scheduleContent(
  id: string,
  date: Date | string
): Promise<ContentWithRelations> {
  const content = await getContentOrThrow(id);
  const scheduledDate = assertFutureScheduledDate(normalizeDate(date), true);

  if (content.status !== "APPROVED") {
    throw new Error(
      `Non puoi programmare un contenuto in stato "${content.status}". Deve essere prima approvato.`
    );
  }
  assertContentReadyForPublishPath(content);

  const updated = await prisma.content.update({
    where: { id },
    data: { status: "SCHEDULED", scheduledDate },
    include: contentInclude,
  });

  await logAudit("CONTENT_SCHEDULED", "Content", id, { scheduledDate });
  return updated;
}

export async function unscheduleContent(
  id: string
): Promise<ContentWithRelations> {
  const content = await getContentOrThrow(id);
  if (content.status !== "SCHEDULED") {
    throw new Error("Il contenuto non è programmato.");
  }
  const updated = await prisma.content.update({
    where: { id },
    data: { status: "APPROVED", scheduledDate: null },
    include: contentInclude,
  });
  await logAudit("CONTENT_UNSCHEDULED", "Content", id, {});
  return updated;
}

export async function duplicateContent(id: string): Promise<ContentWithRelations> {
  const content = await getContentOrThrow(id);
  const copies = await prisma.content.findMany({
    where: { title: { startsWith: `${content.title ?? "Contenuto"} (copia` } },
    select: { title: true },
  });

  const base = content.title ?? "Contenuto";
  const title = `${base} (copia${copies.length ? ` ${copies.length + 1}` : ""})`;

  const duplicated = await prisma.content.create({
    data: {
      type: content.type,
      title,
      caption: content.caption,
      hashtags: content.hashtags,
      status: "DRAFT",
      ideaId: content.ideaId,
      platforms: {
        create: content.platforms.map((p) => ({
          platform: p.platform,
          accountId: p.accountId,
        })),
      },
      slides: {
        create: content.slides.map((s, i) => ({
          imageUrl: s.imageUrl,
          title: s.title,
          text: s.text,
          order: i ?? s.order,
        })),
      },
      assets: {
        create: content.assets.map((a) => ({
          kind: a.kind,
          url: a.url,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      },
    },
    include: contentInclude,
  });

  await logAudit("CONTENT_DUPLICATED", "Content", duplicated.id, {
    sourceId: id,
  });
  return duplicated;
}

export async function deleteContent(id: string): Promise<void> {
  await prisma.content.delete({ where: { id } });
  await logAudit("CONTENT_DELETED", "Content", id, {});
}

/** Index rapidi per il calendario/dashboard */
export async function countsByStatus(): Promise<
  Record<ContentStatus, number>
> {
  const grouped = await prisma.content.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const result = {} as Record<ContentStatus, number>;
  for (const g of grouped) result[g.status] = g._count._all;
  return result;
}