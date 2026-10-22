import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  isTeaserFormat,
  pickTeaserFormat,
  TEASER_FORMATS,
  type ContentFormat,
} from "../src/lib/ai/catalog-content";
import {
  resolvePublicationFlow,
  type PublicationFlow,
} from "../src/lib/ai/publication-flow";
import { createContentFromProposal, deleteContent } from "../src/lib/services/content";
import { getTool } from "../src/lib/ai/tools/registry";

const contentIds: string[] = [];
const proposalIds: string[] = [];
const sourceIds: string[] = [];

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeProposal(opts?: { withOffer?: boolean }) {
  const source = await prisma.catalogSource.create({
    data: {
      domain: uniq("example"),
      baseUrl: "https://example.com",
      pageUrl: `https://example.com/${uniq("page")}`,
    },
  });
  sourceIds.push(source.id);
  const proposal = await prisma.catalogProposal.create({
    data: {
      name: `Proposta ${uniq("test")}`,
      destination: "Rodi",
      sourceId: source.id,
      sourceUrl: "https://example.com/proposta",
      contentHash: uniq("hash"),
      ...(opts?.withOffer
        ? {
            priceFrom: 300,
            priceTo: 500,
            currency: "EUR",
            periodStart: new Date("2027-06-01"),
            periodEnd: new Date("2027-06-08"),
          }
        : {}),
    },
  });
  proposalIds.push(proposal.id);
  return proposal;
}

async function cleanup() {
  for (const id of contentIds.splice(0)) {
    try {
      await deleteContent(id);
    } catch {
      /* già eliminato */
    }
  }
  for (const id of proposalIds.splice(0)) {
    await prisma.catalogProposal.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const id of sourceIds.splice(0)) {
    await prisma.catalogSource.deleteMany({ where: { id } }).catch(() => undefined);
  }
}

after(() => cleanup());

describe("resolvePublicationFlow", () => {
  test("un VIDEO è sempre teaser, anche se il modello chiede OFFER", () => {
    const r = resolvePublicationFlow({
      requested: "OFFER",
      contentType: "VIDEO",
      hasUsableOffer: true,
      defaultFlow: "OFFER",
    });
    assert.equal(r.flow, "TEASER");
    assert.equal(r.warnings.length > 0, true);
  });

  test("OFFER richiesto e sostenibile viene onorato", () => {
    const r = resolvePublicationFlow({ requested: "OFFER", hasUsableOffer: true });
    assert.equal(r.flow, "OFFER");
    assert.equal(r.warnings.length, 0);
  });

  test("OFFER senza dati commerciali devia su TEASER e lo dichiara", () => {
    const r = resolvePublicationFlow({ requested: "OFFER", hasUsableOffer: false });
    assert.equal(r.flow, "TEASER");
    assert.match(r.warnings.join(" "), /TEASER/);
  });

  test("TEASER esplicito vince anche con l'offerta disponibile", () => {
    const r = resolvePublicationFlow({ requested: "TEASER", hasUsableOffer: true });
    assert.equal(r.flow, "TEASER");
  });

  test("flow sconosciuto: warning e default del chiamante", () => {
    const r = resolvePublicationFlow({
      requested: "PROMO",
      hasUsableOffer: true,
      defaultFlow: "OFFER",
    });
    assert.equal(r.flow, "OFFER");
    assert.match(r.warnings.join(" "), /sconosciuto/);
  });

  test("il default viene usato quando il modello non dichiara nulla", () => {
    const offer: PublicationFlow = resolvePublicationFlow({
      hasUsableOffer: true,
      defaultFlow: "OFFER",
    }).flow;
    const teaser = resolvePublicationFlow({ defaultFlow: "TEASER" }).flow;
    assert.equal(offer, "OFFER");
    assert.equal(teaser, "TEASER");
  });
});

describe("pickTeaserFormat", () => {
  test("non restituisce mai un format commerciale", () => {
    const proposalId = "x".repeat(25);
    for (let i = 0; i < 30; i += 1) {
      const { format } = pickTeaserFormat(
        { id: `${proposalId}${i}`, commercialFieldsPresent: [] } as never,
        null
      );
      assert.equal(isTeaserFormat(format), true, `format ${format} non è teaser`);
      assert.notEqual(format, "OFFER");
    }
  });

  test("OFFER richiesto viene rifiutato con un warning, non applicato", () => {
    const { format, warnings } = pickTeaserFormat(
      { id: "abcdefghij012345678901234", commercialFieldsPresent: [] } as never,
      "OFFER" as ContentFormat
    );
    assert.equal(isTeaserFormat(format), true);
    assert.match(warnings.join(" "), /flusso offerta/);
  });

  test("i format teaser elencati non contengono OFFER, ITINERARY o FAQ", () => {
    assert.equal((TEASER_FORMATS as readonly string[]).includes("OFFER"), false);
    assert.equal((TEASER_FORMATS as readonly string[]).includes("ITINERARY"), false);
    assert.equal((TEASER_FORMATS as readonly string[]).includes("FAQ"), false);
  });
});

describe("createContentTool: separazione dei flussi", () => {
  test("flow OFFER senza ancora al catalogo: rifiutato, non creato un quasi-offerta", async () => {
    const tool = getTool("createContent");
    assert.ok(tool);
    const result = await tool.execute({
      topic: "Maldive",
      type: "POST",
      flow: "OFFER",
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Catalogo/);
    const data = result.data as { createdContentId: unknown; catalogRequired: unknown };
    assert.equal(data.createdContentId, null);
    assert.equal(data.catalogRequired, true);
  });

  test("il tool dichiara il parametro flow nello schema", () => {
    const tool = getTool("createContent");
    assert.ok(tool);
    const shape = (tool.schema as unknown as { shape: Record<string, unknown> }).shape;
    assert.ok("flow" in shape, "lo schema deve esporre il campo flow");
  });
});

describe("createContentFromProposal: caption per flusso", () => {
  test("un VIDEO da proposta nasce teaser: la caption non cita l'offerta", async () => {
    const proposal = await makeProposal({ withOffer: true });
    const content = await createContentFromProposal({
      proposalId: proposal.id,
      type: "VIDEO",
    });
    contentIds.push(content.id);
    assert.equal(content.type, "VIDEO");
    assert.doesNotMatch(content.caption ?? "", /offerta|prezz|€/i);
  });

  test("un POST da proposta nasce nel flusso offerta: la caption presenta l'offerta", async () => {
    const proposal = await makeProposal({ withOffer: true });
    const content = await createContentFromProposal({
      proposalId: proposal.id,
      type: "POST",
    });
    contentIds.push(content.id);
    assert.equal(content.type, "POST");
    assert.match(content.caption ?? "", /Offerta speciale/i);
  });
});
