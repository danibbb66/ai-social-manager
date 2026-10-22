import {
  ContentStatus,
  ContentType,
  Platform,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canTransition } from "@/lib/status";
import { logAudit } from "@/lib/audit";
import { deleteUploadedFile } from "@/lib/uploads";
import { assetKindFromMime } from "@/lib/utils";

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
  /** Asset da creare insieme al contenuto (per esempio immagini clonate da una proposta). */
  assets?: {
    kind?: "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
    url: string;
    filename: string;
    mimeType?: string | null;
    size?: number | null;
    metadata?: Prisma.InputJsonValue;
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
}> & {
  /**
   * Anomalie sui legami relazionali in fase di creazione (per esempio un
   * `ideaId` che non esiste e quindi non è stato scritto). Presente solo quando
   * qualcosa è stato sganciato: va letto subito, non è persistito.
   */
  relationWarnings?: string[];
  /**
   * Presente solo in `createContentFromProposal`: true se non è stato creato
   * nulla perché esisteva già una bozza per quella proposta.
   */
  proposalReused?: boolean;
};

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

/** Filtri condivisi da `listContents` e `countContents`. */
export interface ContentListFilters {
  status?: ContentStatus | ContentStatus[];
  type?: ContentType;
  search?: string;
  from?: Date;
  to?: Date;
}

/**
 * Filtro in un unico posto.
 *
 * `listContents` e `countContents` devono applicare esattamente lo stesso
 * filtro: se divergessero, la paginazione contrasterebbe elementi che la
 * pagina non mostra (buchi e duplicati a cavallo delle pagine).
 */
function contentWhere(opts?: ContentListFilters): Prisma.ContentWhereInput {
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
  return where;
}

export async function listContents(
  opts?: ContentListFilters & { limit?: number; offset?: number }
): Promise<ContentWithRelations[]> {
  return prisma.content.findMany({
    where: contentWhere(opts),
    include: contentInclude,
    // `id` è il criterio di spareggio finale: senza un ordinamento totalmente
    // deterministico due pagine consecutive con lo stesso `scheduledDate` e
    // `createdAt` possono mostrare due volte lo stesso contenuto o saltarne uno.
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    take: opts?.limit ?? 200,
    ...(opts?.offset ? { skip: opts.offset } : {}),
  });
}

/** Quanti contenuti soddisfano i filtri: serve a calcolare le pagine. */
export async function countContents(opts?: ContentListFilters): Promise<number> {
  return prisma.content.count({ where: contentWhere(opts) });
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

export interface ContentRelationCheck {
  ideaId: string | null;
  catalogProposalId: string | null;
  /** Perché un legame richiesto è stato sganciato. Vuoto nel caso normale. */
  warnings: string[];
}

/**
 * Verifica che gli id relazionali esistano prima di scriverli.
 *
 * `ideaId` e `catalogProposalId` arrivano spesso dal modello, che può inventarli.
 * Scriverli senza controllarli fa esplodere `prisma.content.create` con un
 * P2003 ("Foreign key constraint violated") che descrive un sintomo invece della
 * causa, e che lascia l'utente senza spiegazione. Un legame che non può esistere
 * semplicemente non viene scritto: il contenuto nasce comunque, sganciato, e il
 * fatto viene dichiarato in `warnings` invece di essere nascosto.
 *
 * La verifica costa due `findUnique` su chiave primaria, e solo quando un id è
 * stato passato: il percorso normale resta una sola query.
 */
export async function resolveContentRelations(input: {
  ideaId?: string | null;
  catalogProposalId?: string | null;
}): Promise<ContentRelationCheck> {
  const warnings: string[] = [];

  const ideaId = input.ideaId?.trim() || null;
  let resolvedIdeaId: string | null = null;
  if (ideaId) {
    const idea = await prisma.contentIdea.findUnique({
      where: { id: ideaId },
      select: { id: true },
    });
    if (idea) resolvedIdeaId = idea.id;
    else warnings.push(`l'idea "${ideaId}" non esiste: il contenuto è stato creato senza collegamento.`);
  }

  const catalogProposalId = input.catalogProposalId?.trim() || null;
  let resolvedProposalId: string | null = null;
  if (catalogProposalId) {
    const proposal = await prisma.catalogProposal.findUnique({
      where: { id: catalogProposalId },
      select: { id: true },
    });
    if (proposal) resolvedProposalId = proposal.id;
    else
      warnings.push(
        `la proposta di catalogo "${catalogProposalId}" non esiste: il contenuto è stato creato senza ancoraggio al catalogo.`
      );
  }

  return { ideaId: resolvedIdeaId, catalogProposalId: resolvedProposalId, warnings };
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

  // Gli id relazionali si scrivono solo se la riga collegata esiste: un id
  // inventato non deve trasformare la creazione in un errore di vincolo.
  const relations = await resolveContentRelations({
    ideaId: input.ideaId,
    catalogProposalId: input.catalogProposalId,
  });

  const content = await prisma.content.create({
    data: {
      type,
      title: input.title ?? null,
      caption: input.caption ?? null,
      hashtags: input.hashtags ?? null,
      status: input.status ?? "DRAFT",
      scheduledDate,
      ideaId: relations.ideaId,
      catalogProposalId: relations.catalogProposalId,
      platforms: {
        create: platforms.map((p) => ({
          platform: p,
          accountId: null,
        })),
      },
      ...(input.assets && input.assets.length > 0
        ? {
            assets: {
              create: input.assets.map((a) => ({
                // Il kind è quello dichiarato dal chiamante; in sua assenza
                // lo decide il MIME: un URL video non diventa mai un asset IMAGE.
                kind: a.kind ?? assetKindFromMime(a.mimeType ?? undefined),
                url: a.url,
                filename: a.filename,
                mimeType: a.mimeType ?? null,
                size: a.size ?? null,
                metadata: a.metadata ?? Prisma.JsonNull,
              })),
            },
          }
        : {}),
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
    // Un legame sganciato è un'anomalia da poter rivedere, non una nota da perdere.
    droppedRelations: relations.warnings,
  });

  // Le anomalie di relazione viaggiano con il contenuto: il chiamante deve poter
  // dichiarare che il DRAFT è nato sganciato, senza rileggere il database.
  return relations.warnings.length > 0 ? { ...content, relationWarnings: relations.warnings } : content;
}

/**
 * Crea (o recupera) la bozza derivata da una proposta del Catalogo Agenzia.
 *
 * Il flusso `?fromProposal=<id>` può innescare la creazione più volte per la
 * stessa proposta (il client rimonta il componente e React in StrictMode
 * esegue l'effetto due volte): senza un controllo di unicità prima dell'
 * insert finiscono nel database due bozze identiche. Qui la prima bozza
 * esistente per quella proposta viene restituita al chiamante invece di
 * crearne una seconda.
 *
 * Le immagini ufficiali della proposta (`CatalogImage`) puntano agli originali
 * remoti e non hanno alcun legame con i contenuti: vengono clonate qui come
 * `ContentAsset` agganciati alla nuova bozza, così il contenuto nasce con le
 * stesse immagini della proposta.
 */
export async function createContentFromProposal(input: {
  proposalId: string;
  type?: ContentType;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  scheduledDate?: Date | string | null;
  platforms?: ContentPlatformInput;
}): Promise<ContentWithRelations> {
  const proposalId = input.proposalId.trim();

  // De-duplicazione: una proposta ha al più una bozza. Se esiste già, si
  // restituisce quella invece di creare un doppio.
  const existing = await prisma.content.findFirst({
    where: { catalogProposalId: proposalId },
    orderBy: { createdAt: "desc" },
    include: contentInclude,
  });

  if (existing) {
    // Backfill: bozze nate prima di questo controllo non hanno asset. Se la
    // proposta ha immagini e la bozza ne è priva, si colmano ora invece di
    // lasciare in giro una bozza senza locandina.
    if (existing.assets.length === 0) {
      const proposal = await prisma.catalogProposal.findUnique({
        where: { id: proposalId },
        select: { images: { orderBy: { acquiredAt: "asc" as const } } },
      });
      if (proposal && proposal.images.length > 0) {
        await prisma.contentAsset.createMany({
          data: proposal.images.map((img) => ({
            kind: "IMAGE" as const,
            contentId: existing.id,
            url: img.url,
            filename: img.filename,
            metadata: {
              source: "catalog-proposal",
              catalogImageId: img.id,
              role: img.role,
              isOfficial: img.isOfficial,
            },
          })),
        });
        await logAudit("CONTENT_PROPOSAL_ASSETS_COPIED", "Content", existing.id, {
          proposalId,
          assets: proposal.images.length,
        });
      }
    }
    return { ...existing, proposalReused: true };
  }

  const proposal = await prisma.catalogProposal.findUnique({
    where: { id: proposalId },
    include: { images: { orderBy: { acquiredAt: "asc" as const } } },
  });
  if (!proposal) {
    throw new Error(`La proposta "${proposalId}" non esiste più nel catalogo.`);
  }

  const content = await createContent({
    type: input.type,
    title: input.title || proposal.name,
    // La caption di default segue il flusso: un VIDEO è un teaser di
    // incuriosimento e non cita l'offerta; per un POST la proposta è il punto
    // di partenza del flusso offerta/locandina e il testo la presenta come tale.
    caption:
      input.caption ||
      (input.type === "VIDEO"
        ? `${proposal.destination || proposal.name}: il posto che vale il viaggio. Scopri di più sulla nostra pagina.`
        : `Offerta speciale per ${proposal.destination || proposal.name}! \n\nScopri tutti i dettagli sulla nostra pagina integrata.`),
    hashtags: input.hashtags,
    scheduledDate: input.scheduledDate,
    platforms: input.platforms,
    // Il legame con la proposta è ciò che rende la de-duplicazione possibile:
    // senza questo campo il controllo precedente non troverebbe mai nulla.
    catalogProposalId: proposal.id,
    assets: proposal.images.map((img) => ({
      kind: "IMAGE" as const,
      url: img.url,
      filename: img.filename,
      metadata: {
        source: "catalog-proposal",
        catalogImageId: img.id,
        role: img.role,
        isOfficial: img.isOfficial,
      },
    })),
  });

  return { ...content, proposalReused: false };
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
        ...(input.ideaId !== undefined
          ? { ideaId: (await resolveContentRelations({ ideaId: input.ideaId })).ideaId }
          : {}),
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

  // Stessa regola del gate di pubblicazione: serve l'approvazione esplicita,
  // non basta lo stato. Un contenuto APPROVED senza record Approval è solo un
  // bypass lato database, e programmarlo creerebbe un contenuto in coda che
  // nessuno potrà mai pubblicare.
  //
  // La regola vive in `services/approvals.ts` (`hasExplicitApproval`), che
  // importa da questo file: qui si interroga direttamente per non creare un
  // ciclo di import fra i due moduli.
  const explicitApprovals = await prisma.approval.count({
    where: { contentId: id, decision: "APPROVED" },
  });
  if (explicitApprovals === 0) {
    throw new Error(
      "Programmazione rifiutata: il contenuto non ha un'approvazione esplicita."
    );
  }

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

/**
 * Cancella i file locali che appartenevano a un contenuto eliminato.
 *
 * Senza questo passo la cancellazione del record lascia in `/public/uploads` un
 * file orfano per ogni contenuto con visual: la riga `ContentAsset` sparisce
 * con il cascade, il file resta e non è più raggiungibile da nessuna parte.
 *
 * Un file non viene mai cancellato se un altro asset lo usa ancora: duplicare
 * un contenuto copia le righe asset senza copiare il file, quindi due
 * contenuti possono condividere lo stesso upload. Un file già assente non è
 * un errore e `deleteUploadedFile` rifiuta comunque qualsiasi url fuori da
 * `/uploads/<cartella>/<file>`.
 */
async function removeContentUploadFiles(urls: (string | null | undefined)[]): Promise<void> {
  for (const url of new Set(urls.filter((u): u is string => typeof u === "string"))) {
    if (await prisma.contentAsset.count({ where: { url } })) continue;
    await deleteUploadedFile(url).catch(() => false);
  }
}

export async function deleteContent(id: string): Promise<void> {
  const owned = await prisma.content.findUnique({
    where: { id },
    select: {
      assets: { select: { url: true } },
      slides: { select: { imageUrl: true } },
    },
  });
  await prisma.content.delete({ where: { id } });
  await removeContentUploadFiles([
    ...(owned?.assets.map((a) => a.url) ?? []),
    ...(owned?.slides.map((s) => s.imageUrl) ?? []),
  ]);
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