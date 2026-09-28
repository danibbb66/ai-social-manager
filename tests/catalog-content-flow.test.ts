import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { runAgent, SYSTEM_PROMPT, type AgentStreamEvent } from "../src/lib/ai/agent";
import { setAiProvider } from "../src/lib/ai/factory";
import type {
  AiChatMessage,
  AiCompletion,
  AiPingResult,
  AiProvider,
} from "../src/lib/ai/provider";
import { getOrCreateConversation } from "../src/lib/services/chat";
import { deleteContent } from "../src/lib/services/content";
import { getTool } from "../src/lib/ai/tools/registry";
import {
  searchCatalogForAi,
  selectFromProposals,
  resolveFromProposals,
  toCatalogProposalDto,
  type CatalogProposalDto,
} from "../src/lib/services/catalog-ai";
import {
  CONTENT_FORMATS,
  availableFormats,
  buildVisualDirection,
  catalogCopyFromProposal,
  pickEditorialFormat,
  type ContentFormat,
} from "../src/lib/ai/catalog-content";
import { normalizeForMatch, textMatchesQuery } from "../src/lib/catalog/text";

/**
 * Catalogo → AI → createContent.
 *
 * Qui la garanzia centrale è che il post nasca da una proposta reale: se la
 * destinazione non esiste, non si crea niente. La verifica è sul database e
 * sul testo prodotto, non sulle intenzioni del prompt.
 *
 * I test usano proposte proprie (Testonia, Offerta Reale) invece di quelle
 * vere dell'agenzia: il catalogo reale può essere reimportato in qualsiasi
 * momento e non deve far fallire questa suite.
 */

const SOURCE_DOMAIN = "catalogo.test";
const SOURCE_PAGE = "https://catalogo.test/offerte/";

/** Proposte con dati commerciali nulli: il caso reale del catalogo v1. */
const BARE_NAME = "Testonia Capodanno";
const BARE_DESTINATION = "Testonia";
const BARE_IMAGE = "https://catalogo.test/img/TESTONIA-CAPODANNO.webp";

/** Proposta con dati commerciali completi: qui OFFER è lecito. */
const FULL_NAME = "Offerta Reale Repubblica";
const FULL_DESTINATION = "Repubblica";
const FULL_IMAGE = "https://catalogo.test/img/REPUBBLICA-5-NOTTI.webp";

/** Titolo segnaposto: non è un dato dell'agenzia, quindi non è promuovibile. */
const PLACEHOLDER_NAME = "Nuova Locandina 1";
const PLACEHOLDER_IMAGE = "https://catalogo.test/img/placeholder-1.webp";

/** Nome di prova che il catalogo reale non contiene: serve al caso Calabria. */
const ABSENT_DESTINATION = "Calabria";

const contentIds: string[] = [];
const conversationIds: string[] = [];
const sourceIds: string[] = [];

let bareId = "";
let fullId = "";
let placeholderId = "";

function envelope(calls: { name: string; arguments: Record<string, unknown> }[], message?: string) {
  return JSON.stringify({
    message: message ?? "Procedo.",
    tool_calls: calls,
  });
}

/** Provider finto: una risposta per round, nessuna chiamata a Ollama. */
class ScriptedAiProvider implements AiProvider {
  readonly name = "scripted";
  readonly model = "scripted";
  readonly calls: AiChatMessage[][] = [];

  constructor(private readonly replies: string[]) {
    if (replies.length === 0) throw new Error("serve almeno una risposta");
  }

  async ping(): Promise<AiPingResult> {
    return {
      ok: true,
      provider: this.name,
      model: this.model,
      availableModels: [],
      message: "scripted",
    };
  }

  async chat(messages: AiChatMessage[]): Promise<AiCompletion> {
    this.calls.push(messages);
    const i = Math.min(this.calls.length - 1, this.replies.length - 1);
    return { text: this.replies[i] };
  }
}

type ToolEvent = Extract<AgentStreamEvent, { type: "tool" }>;

async function runScripted(userMessage: string, replies: string[]) {
  const conversation = await getOrCreateConversation(null, "[TEST] catalogo→AI");
  conversationIds.push(conversation.id);
  setAiProvider(new ScriptedAiProvider(replies));

  const events: AgentStreamEvent[] = [];
  await runAgent({
    conversationId: conversation.id,
    userMessage,
    emit: (e) => events.push(e),
  });

  return {
    toolEvents: events.filter((e): e is ToolEvent => e.type === "tool"),
    finalEvents: events.filter((e) => e.type === "final"),
  };
}

/** Chiamata diretta a un tool, senza passare dal modello. */
async function callTool(name: string, args: Record<string, unknown>) {
  const tool = getTool(name);
  assert.ok(tool, `il tool ${name} deve esistere`);
  const result = await tool.execute(args);
  return result as { ok: boolean; message: string; data?: Record<string, unknown> };
}

const createContentTool = () => {
  const tool = getTool("createContent");
  assert.ok(tool, "createContent deve esistere");
  return tool;
};

/** Conta i DRAFT e ripulisce quelli creati dal test. */
async function draftCount(): Promise<number> {
  return prisma.content.count({ where: { status: "DRAFT" } });
}

before(async () => {
  const source = await prisma.catalogSource.create({
    data: {
      domain: SOURCE_DOMAIN,
      baseUrl: "https://catalogo.test",
      pageUrl: SOURCE_PAGE,
      lastCrawledAt: new Date(),
    },
  });
  sourceIds.push(source.id);

  const bare = await prisma.catalogProposal.create({
    data: {
      name: BARE_NAME,
      destination: BARE_DESTINATION,
      sourceId: source.id,
      sourceUrl: `${SOURCE_PAGE}#testonia`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-bare-testonia",
      sourceOrder: 1,
      images: { create: { url: BARE_IMAGE, filename: "TESTONIA-CAPODANNO.webp" } },
    },
  });
  bareId = bare.id;

  const full = await prisma.catalogProposal.create({
    data: {
      name: FULL_NAME,
      destination: FULL_DESTINATION,
      sourceId: source.id,
      sourceUrl: `${SOURCE_PAGE}#repubblica`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-full-repubblica",
      sourceOrder: 2,
      periodStart: new Date("2026-12-20T00:00:00Z"),
      periodEnd: new Date("2026-12-25T00:00:00Z"),
      departureCities: "Milano e Roma",
      durationNights: 5,
      priceFrom: 890,
      priceTo: 1290,
      currency: "EUR",
      included: "volo e hotel",
      excluded: "scatti e assicurazione",
      images: { create: { url: FULL_IMAGE, filename: "REPUBBLICA-5-NOTTI.webp" } },
    },
  });
  fullId = full.id;

  const placeholder = await prisma.catalogProposal.create({
    data: {
      name: PLACEHOLDER_NAME,
      destination: null,
      sourceId: source.id,
      sourceUrl: `${SOURCE_PAGE}#placeholder`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-placeholder",
      sourceOrder: 3,
      images: { create: { url: PLACEHOLDER_IMAGE, filename: "placeholder-1.webp" } },
    },
  });
  placeholderId = placeholder.id;
});

after(async () => {
  setAiProvider(null);
  // `Set`: lo stesso DRAFT può essere stato registrato da più test.
  for (const id of new Set(contentIds.splice(0))) {
    await deleteContent(id).catch(() => {});
  }
  for (const id of conversationIds.splice(0)) {
    await prisma.chatConversation.delete({ where: { id } }).catch(() => {});
  }
  // I contenuti creati dal test che non sono finiti in contentIds.
  await prisma.content.deleteMany({ where: { catalogProposalId: { in: [bareId, fullId] } } });
  await prisma.catalogSource.deleteMany({ where: { id: { in: sourceIds } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ *
 * 1 + 2. destinazione presente -> 1 DRAFT riferibile alla proposta
 * ------------------------------------------------------------------ */

test("1. una destinazione presente nel Catalogo produce esattamente un DRAFT", async () => {
  const before = await draftCount();

  const result = await createContentTool().execute({
    fromCatalog: true,
    destination: BARE_DESTINATION,
    platforms: ["INSTAGRAM", "FACEBOOK"],
  }) as { ok: boolean; message: string; data?: Record<string, unknown> };

  assert.equal(result.ok, true, result.message);
  const id = String(result.data!.id);
  contentIds.push(id);

  const created = await prisma.content.findUnique({
    where: { id },
    include: { platforms: true },
  });
  assert.ok(created, "il DRAFT deve esistere");
  assert.equal(created.status, "DRAFT");
  assert.equal(await draftCount(), before + 1, "una richiesta = un solo DRAFT");
  assert.deepEqual(
    created.platforms.map((p) => p.platform).sort(),
    ["FACEBOOK", "INSTAGRAM"]
  );

  // 2. il DRAFT risale alla proposta giusta
  assert.equal(created.catalogProposalId, bareId, "il DRAFT deve puntare alla proposta");
  const linked = await prisma.content.findUnique({
    where: { id },
    include: { catalogProposal: { include: { source: true } } },
  });
  const proposal = linked!.catalogProposal!;
  assert.equal(proposal.name, BARE_NAME);
  assert.equal(proposal.sourceUrl, `${SOURCE_PAGE}#testonia`);
  assert.equal(proposal.sourceType, "FLYER");
  assert.equal(proposal.source.domain, SOURCE_DOMAIN, "provenance: content → proposta → fonte");
  assert.equal(result.data!.catalogProposalId, bareId);
  assert.equal(
    (result.data!.provenance as { sourceUrl: string }).sourceUrl,
    `${SOURCE_PAGE}#testonia`
  );
});

/* ------------------------------------------------------------------ *
 * 3. destinazione assente -> nessun DRAFT
 * ------------------------------------------------------------------ */

test("3. una destinazione assente dal Catalogo non produce nessun DRAFT", async () => {
  const before = await draftCount();
  const start = new Date();

  const { proposals } = await searchCatalogForAi({ query: ABSENT_DESTINATION });
  assert.equal(
    proposals.filter((p) => p.usable).length,
    0,
    "il catalogo di test non deve contenere la destinazione cercata"
  );

  const search = await callTool("searchCatalog", { query: ABSENT_DESTINATION });
  assert.equal(search.ok, false, "la ricerca deve dichiarare l'assenza");
  assert.match(search.message, /Nessuna proposta del Catalogo/);
  assert.match(search.message, /Non creare contenuti/);

  const created = await createContentTool().execute({
    fromCatalog: true,
    destination: ABSENT_DESTINATION,
    platforms: ["INSTAGRAM"],
  }) as { ok: boolean; message: string; data?: Record<string, unknown> };

  assert.equal(created.ok, false, "niente DRAFT senza una proposta reale");
  assert.equal(created.data!.catalogFailure, "destination_absent");
  assert.equal(created.data!.createdContentId, null);
  assert.match(created.message, new RegExp(ABSENT_DESTINATION));
  assert.match(created.message, /NON creare il DRAFT/);
  assert.equal(await draftCount(), before, "nessun contenuto creato");
  // Nessun DRAFT nuovo che parli della destinazione richiesta. Il confronto
  // è limitato a questo test: il database può contenere DRAFT storici.
  assert.equal(
    await prisma.content.count({
      where: { createdAt: { gte: start }, title: { contains: ABSENT_DESTINATION } },
    }),
    0,
    "nemmeno un DRAFT dall'argomento"
  );
});

test("3b. lo stesso vale per un id di proposta inesistente", async () => {
  const before = await draftCount();
  const created = await createContentTool().execute({
    catalogProposalId: "cm-non-esiste-000000000000",
    platforms: ["INSTAGRAM"],
  }) as { ok: boolean; message: string; data?: Record<string, unknown> };

  assert.equal(created.ok, false);
  assert.equal(created.data!.catalogFailure, "proposal_not_found");
  assert.equal(await draftCount(), before);
});

test("3c. il placeholder non è promuovibile", async () => {
  const { proposals } = await searchCatalogForAi({ query: PLACEHOLDER_NAME });
  const found = proposals.find((p) => p.id === placeholderId);
  assert.ok(found, "il placeholder deve comparire in ricerca");
  assert.equal(found.usable, false, "un titolo segnaposto non è un dato utilizzabile");
  assert.ok(found.anomalies.some((a) => a.code === "PLACEHOLDER_TITLE"));

  const before = await draftCount();
  const created = await createContentTool().execute({
    catalogProposalId: placeholderId,
    platforms: ["INSTAGRAM"],
  }) as { ok: boolean; data?: Record<string, unknown> };
  assert.equal(created.ok, false);
  assert.equal(created.data!.catalogFailure, "proposal_unusable");
  assert.equal(await draftCount(), before);
});

/* ------------------------------------------------------------------ *
 * 4 + 5. nessuna invenzione di prezzo e durata
 * ------------------------------------------------------------------ */

const PRICE_TOKENS = /(€|euro|prezzo|costo|quanto costa|a partire da|disponibil)/i;
const DURATION_TOKENS = /(\d+\s*(giorni|notti|notte|giorno))/i;

test("4. senza prezzi in catalogo la copy non cita prezzi", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;
  assert.deepEqual(bare.commercialFieldsPresent, [], "la proposta di test non ha dati commerciali");
  assert.equal(bare.commercial.priceFrom, null);

  const { format } = pickEditorialFormat(bare, null);
  const copy = catalogCopyFromProposal(bare, format);

  assert.equal(copy.usesCommercialData, false);
  assert.doesNotMatch(copy.caption, PRICE_TOKENS, `caption: ${copy.caption}`);
  assert.doesNotMatch(copy.title, PRICE_TOKENS, `titolo: ${copy.title}`);
  assert.doesNotMatch(copy.hashtags, PRICE_TOKENS);
});

test("5. senza durata in catalogo la copy non cita giorni o notti", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;

  for (const format of CONTENT_FORMATS) {
    const copy = catalogCopyFromProposal(bare, format);
    assert.doesNotMatch(
      copy.caption,
      DURATION_TOKENS,
      `il format ${format} ha inventato una durata: ${copy.caption}`
    );
    assert.doesNotMatch(copy.title, DURATION_TOKENS, `il format ${format}: ${copy.title}`);
  }
});

test("4b. con dati reali la copy li usa e non li inventa", async () => {
  const { proposals } = await searchCatalogForAi({ query: FULL_DESTINATION });
  const full = proposals.find((p) => p.id === fullId)!;
  assert.ok(full.commercialFieldsPresent.includes("priceFrom"));
  assert.ok(full.commercialFieldsPresent.includes("durationNights"));

  const { format } = pickEditorialFormat(full, "OFFER");
  assert.equal(format, "OFFER", "con prezzo e date OFFER è ammesso");
  const copy = catalogCopyFromProposal(full, format);
  assert.equal(copy.usesCommercialData, true);
  assert.match(copy.caption, /890/);
  assert.match(copy.caption, /EUR/);
  assert.match(copy.caption, /5 notti/);
  assert.doesNotMatch(copy.caption, /\d+\s*giorni/i, "le notti non diventano giorni");
});

/* ------------------------------------------------------------------ *
 * 6. format coerenti con i dati
 * ------------------------------------------------------------------ */

test("6. una proposta senza dati commerciali non può usare OFFER, ITINERARY o FAQ", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;

  const available = availableFormats(bare);
  for (const forbidden of ["OFFER", "ITINERARY", "FAQ"] as ContentFormat[]) {
    assert.equal(available.includes(forbidden), false, `${forbidden} non deve essere disponibile`);
  }
  for (const allowed of ["HERO_DESTINATION", "STORYTELLING", "INSPIRATION", "TRAVEL_TIPS"]) {
    assert.ok(available.includes(allowed as ContentFormat), `${allowed} deve restare disponibile`);
  }

  // Se il modello chiede OFFER, il codice scende a un formato onesto e lo dice.
  const forced = pickEditorialFormat(bare, "OFFER");
  assert.notEqual(forced.format, "OFFER");
  assert.match(forced.warnings.join(" "), /manca il prezzo nel catalogo/);

  // E il DRAFT davvero creato non è OFFER.
  const result = await createContentTool().execute({
    fromCatalog: true,
    destination: BARE_DESTINATION,
    format: "OFFER",
    platforms: ["INSTAGRAM"],
  }) as { ok: boolean; data?: Record<string, unknown> };
  const id = String(result.data!.id);
  contentIds.push(id);
  assert.notEqual(result.data!.editorialFormat, "OFFER");
  assert.ok(
    (result.data!.warnings as string[]).some((w) => /non usabile/.test(w)),
    "il rifiuto del format deve essere rendicato"
  );
});

test("6b. la scelta del format è deterministica e varia sulla stessa proposta", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;

  const a = pickEditorialFormat(bare, null);
  const b = pickEditorialFormat(bare, null);
  assert.equal(a.format, b.format, "stessa proposta = stesso format");
  assert.deepEqual(a.warnings, b.warnings);

  // Su proposte diverse l'angolo cambia: due post non escono identici per
  // costruzione, non per caso. La varietà si verifica sull'insieme, non su un
  // id scelto a mano.
  const seen = new Set<ContentFormat>();
  for (let i = 0; i < 12; i += 1) {
    const dto: CatalogProposalDto = { ...bare, id: `proposta-${i}` };
    const first = pickEditorialFormat(dto, null);
    const second = pickEditorialFormat(dto, null);
    assert.equal(first.format, second.format, "stessa proposta = stesso format");
    assert.notEqual(first.format, "OFFER", "mai OFFER senza dati commerciali");
    seen.add(first.format);
  }
  assert.ok(seen.size > 1, `attesi più format sul catalogo, visti solo: ${[...seen]}`);
});

/* ------------------------------------------------------------------ *
 * 7. direzione visual
 * ------------------------------------------------------------------ */

test("7. la direzione visual usa l'immagine ufficiale del catalogo", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;

  const { format } = pickEditorialFormat(bare, null);
  const visual = buildVisualDirection(bare, format);

  assert.equal(visual.useOfficialImage, true);
  assert.equal(visual.officialImageUrl, BARE_IMAGE);
  assert.equal(visual.officialImageFilename, "TESTONIA-CAPODANNO.webp");
  assert.equal(visual.visualType, "OFFICIAL_IMAGE");
  assert.equal(visual.needsGeneration, false, "con l'originale non serve generare");
  assert.equal(visual.generationBrief, null);
  assert.equal(visual.textOverlay.allowed, true);
  assert.deepEqual(visual.textOverlay.lines, [BARE_DESTINATION]);
  assert.ok(visual.concept.length > 10 && visual.subject.length > 10);
  assert.ok(visual.composition.length > 10 && visual.mood.length > 10);

  // La direzione viaggia nel risultato del tool: è il contratto del prossimo step.
  const result = await createContentTool().execute({
    fromCatalog: true,
    destination: BARE_DESTINATION,
    platforms: ["INSTAGRAM"],
  }) as { ok: boolean; data?: Record<string, unknown> };
  const id = String(result.data!.id);
  contentIds.push(id);
  const visualFromTool = result.data!.visualDirection as { useOfficialImage: boolean; officialImageUrl: string };
  assert.equal(visualFromTool.useOfficialImage, true);
  assert.equal(visualFromTool.officialImageUrl, BARE_IMAGE);
  assert.equal(result.data!.withMedia, false, "nessuna immagine generata");
  assert.equal(result.data!.assetId, null);

  const draft = await prisma.content.findUnique({
    where: { id },
    include: { assets: true },
  });
  assert.equal(draft!.assets.length, 0, "nessun asset generato o scaricato");
});

test("7b. senza immagine ufficiale la direzione visual chiede una generazione futura", () => {
  const dto = {
    ...toCatalogProposalDto({
      id: "senza-immagine",
      name: "Proposta Senza Immagine",
      destination: "Valle",
      status: "ACTIVE",
      confidence: "UNVERIFIED",
      sourceUrl: "https://catalogo.test/offerte/#valle",
      sourceType: "FLYER",
      contentHash: "h",
      tripType: null,
      category: null,
      periodStart: null,
      periodEnd: null,
      departureCities: null,
      durationNights: null,
      priceFrom: null,
      priceTo: null,
      currency: null,
      priceNote: null,
      included: null,
      excluded: null,
      sourceId: "s",
      extraction: "HTML",
      sourceOrder: null,
      acquiredAt: new Date(),
      sourceUpdatedAt: null,
      lastSeenAt: new Date(),
      missingSince: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [],
      source: {
        id: "s",
        domain: SOURCE_DOMAIN,
        baseUrl: "https://catalogo.test",
        pageUrl: SOURCE_PAGE,
        kind: "SITE_WORDPRESS",
        authority: "PRESENTATION",
        lastCrawledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      contents: [],
    } as never),
  } as CatalogProposalDto;

  const visual = buildVisualDirection(dto, "HERO_DESTINATION");
  assert.equal(visual.useOfficialImage, false);
  assert.equal(visual.officialImageUrl, null);
  assert.equal(visual.needsGeneration, true);
  assert.ok(visual.generationBrief && visual.generationBrief.length > 20);
});

/* ------------------------------------------------------------------ *
 * 8. richiesta generica
 * ------------------------------------------------------------------ */

test("8. una richiesta generica seleziona una proposta ACTIVE reale", async () => {
  const before = await draftCount();

  const { toolEvents } = await runScripted("Crea un post Instagram/Facebook", [
    envelope([{ name: "createContent", arguments: { fromCatalog: true, platforms: ["INSTAGRAM"] } }]),
  ]);

  const create = toolEvents.find((e) => e.name === "createContent");
  assert.ok(create, "createContent deve essere stato chiamato");
  assert.equal(create.ok, true, create.error ?? "");

  const id = await prisma.content.findFirst({
    where: { catalogProposalId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, catalogProposalId: true },
  });
  assert.ok(id, "deve esistere un DRAFT ancorato a una proposta");
  contentIds.push(id.id);
  assert.equal(await draftCount(), before + 1, "un solo DRAFT");

  const proposal = await prisma.catalogProposal.findUnique({
    where: { id: id.catalogProposalId! },
  });
  assert.ok(proposal, "la proposta selezionata deve esistere");
  assert.equal(proposal.status, "ACTIVE", "solo proposte ACTIVE");
  assert.equal(proposal.missingSince, null);
});

test("8b. la selezione è deterministica e preferisce le proposte non ancora usate", async () => {
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;
  const { proposals: full } = await searchCatalogForAi({ query: FULL_DESTINATION });
  const fullDto = full.find((p) => p.id === fullId)!;

  // DTO con `lastUsedAt` forzato: il test non deve dipendere da quali
  // proposte i test precedenti hanno già usato.
  const freshBare: CatalogProposalDto = { ...bare, lastUsedAt: null };
  const freshFull: CatalogProposalDto = { ...fullDto, lastUsedAt: null };
  const controlled = [freshBare, freshFull];  const a = selectFromProposals(controlled);
  const b = selectFromProposals(controlled);
  assert.equal(a?.id, b?.id, "stesso input = stessa scelta");

  // A parità di condizioni vince l'ordine stabile della fonte.
  assert.equal(a?.id, freshBare.id, "ordine stabile");

  // Chi è già stato usato perde il posto rispetto a chi non lo è mai stato.
  const usedBare: CatalogProposalDto = {
    ...freshBare,
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
  };
  assert.equal(
    selectFromProposals([usedBare, freshFull])?.id,
    freshFull.id,
    "la proposta già usata cede il posto"
  );

  // Con query la selezione è comunque deterministica e rispetta il filtro.
  assert.equal(selectFromProposals(controlled, FULL_DESTINATION)?.id, freshFull.id);
  assert.equal(selectFromProposals(controlled, ABSENT_DESTINATION), null);

  // Il placeholder non entra mai, anche se è l'unico disponibile.
  const { proposals: ph } = await searchCatalogForAi({ query: PLACEHOLDER_NAME });
  const placeholder = ph.find((p) => p.id === placeholderId)!;
  assert.equal(selectFromProposals([placeholder]), null, "placeholder non selezionabile");
});

/* ------------------------------------------------------------------ *
 * 9. una richiesta = un solo DRAFT
 * ------------------------------------------------------------------ */

test("9. una seconda createContent nello stesso turno resta bloccata", async () => {
  const before = await draftCount();

  const { toolEvents } = await runScripted("Crea un post per Testonia", [
    envelope([
      {
        name: "createContent",
        arguments: { fromCatalog: true, destination: BARE_DESTINATION, platforms: ["INSTAGRAM"] },
      },
      {
        name: "createContent",
        arguments: { fromCatalog: true, destination: BARE_DESTINATION, platforms: ["FACEBOOK"] },
      },
    ]),
  ]);

  const creates = toolEvents.filter((e) => e.name === "createContent");
  assert.equal(creates.length, 2, "entrambe le chiamate restano visibili");
  assert.equal(creates[0].ok, true, creates[0].error ?? "");
  assert.equal(creates[1].ok, false, "la seconda non viene eseguita");
  assert.match(String(creates[1].error ?? ""), /già creato in questo turno/);
  assert.equal(await draftCount(), before + 1, "un solo DRAFT per richiesta");

  const drafts = await prisma.content.findMany({
    where: { catalogProposalId: bareId },
    orderBy: { createdAt: "desc" },
  });
  for (const d of drafts) contentIds.push(d.id);
});

/* ------------------------------------------------------------------ *
 * 10. catalogo vuoto
 * ------------------------------------------------------------------ */

test("10. con il catalogo vuoto la risposta è controllata e non nasce nessun DRAFT", () => {
  const resolution = resolveFromProposals([], { destination: BARE_DESTINATION });
  assert.equal(resolution.ok, false);
  assert.equal(resolution.ok === false && resolution.reason, "destination_absent");
  assert.match(resolution.ok === false ? resolution.message : "", /NON creare il DRAFT/);

  const generic = resolveFromProposals([], {});
  assert.equal(generic.ok, false);
  assert.equal(generic.ok === false && generic.reason, "catalog_empty");
  assert.match(generic.ok === false ? generic.message : "", /Catalogo Agenzia/);
  assert.match(generic.ok === false ? generic.message : "", /NON creare il DRAFT/);

  assert.equal(selectFromProposals([], null), null);
});

test("10b. con il solo placeholder il catalogo non è promuovibile", async () => {
  const { proposals } = await searchCatalogForAi({ query: PLACEHOLDER_NAME });
  const placeholder = proposals.find((p) => p.id === placeholderId)!;
  const resolution = resolveFromProposals([placeholder], {});
  assert.equal(resolution.ok, false);
  assert.equal(resolution.ok === false && resolution.reason, "catalog_empty");
});

/* ------------------------------------------------------------------ *
 * Contratto del tool e del prompt
 * ------------------------------------------------------------------ */

test("il tool di ricerca è registrato, dichiarato e read-only", async () => {
  const tool = getTool("searchCatalog");
  assert.ok(tool, "searchCatalog deve essere nel registry");
  assert.match(tool.description, /Catalogo Agenzia/);
  assert.match(tool.description, /PRIMA di createContent/);
  assert.match(tool.description, /NON devi creare il DRAFT/);

  // sola lettura: nessuna scrittura, quindi nessun DRAFT
  const before = await draftCount();
  await callTool("searchCatalog", { query: BARE_DESTINATION });
  await callTool("searchCatalog", {});
  assert.equal(await draftCount(), before);

  // il DTO non contiene HTML grezzo
  const { proposals } = await searchCatalogForAi({ query: BARE_DESTINATION });
  const bare = proposals.find((p) => p.id === bareId)!;
  assert.doesNotMatch(JSON.stringify(bare), /<[a-z]/i, "il DTO non deve contenere markup");
  assert.equal(bare.sourceUrl, `${SOURCE_PAGE}#testonia`);
  assert.equal(bare.sourceType, "FLYER");
  assert.equal(bare.officialImage?.url, BARE_IMAGE);
});

test("il prompt dichiara il catalogo come fonte dei post", () => {
  assert.match(SYSTEM_PROMPT, /## CATALOGO/);
  assert.match(SYSTEM_PROMPT, /fonte di verità per i post/);
  assert.match(SYSTEM_PROMPT, /searchCatalog/);
  assert.match(SYSTEM_PROMPT, /fromCatalog/);
  assert.match(SYSTEM_PROMPT, /NON creare il DRAFT/);
});

test("il confronto testuale del catalogo ignora maiuscole e accenti", () => {
  assert.equal(normalizeForMatch("Rodì"), "rodi");
  assert.ok(textMatchesQuery("Rodi da Milano e Roma", "RODI"));
  assert.ok(textMatchesQuery("Maldive Natale", "maldive"));
  assert.ok(!textMatchesQuery("Cipro", "Rodi"));
});
