import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Platform } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { config } from "../src/lib/env";
import {
  createContent,
  approveContent,
  deleteContent,
} from "../src/lib/services/content";
import { unpublishContent } from "../src/lib/services/publish";

const createdIds: string[] = [];
const createdJobIds: string[] = [];
const originalFetch = globalThis.fetch;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchCalls: string[] = [];

async function cleanup() {
  for (const id of createdJobIds.splice(0)) {
    await prisma.aIJob.deleteMany({ where: { id } }).catch(() => {});
  }
  for (const id of createdIds.splice(0)) {
    try {
      await deleteContent(id);
    } catch {
      // già eliminato
    }
  }
}

before(async () => {
  await cleanup();
  // Il servizio non deve parlare con nessuno: se qualcuno provasse a
  // contattare Meta, il test lo registra e fallisce.
  (globalThis as { fetch: FetchStub }).fetch = async (input) => {
    fetchCalls.push(String(input));
    throw new Error("chiamata di rete non ammessa in questo test");
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  config.facebook.token = undefined;
  await cleanup();
});

/**
 * Ricrea la forma che un publish riuscito lascia nel DB: Approval APPROVED,
 * ContentPlatform con externalId/publishedAt, stato PUBLISHED e il job
 * storico PUBLISH SUCCESS.
 */
async function seedPublished(opts: {
  platforms: Platform[];
  externalIds: Partial<Record<Platform, string>>;
  job?: boolean;
}) {
  const content = await createContent({
    title: "[TEST] rimozione manuale",
    caption: "Cappella di prova per il riallineamento dopo rimozione manuale.",
    hashtags: "#test",
    platforms: opts.platforms,
  });
  createdIds.push(content.id);
  await approveContent(content.id, "approvazione di test");

  for (const platform of opts.platforms) {
    const externalId = opts.externalIds[platform];
    if (!externalId) continue;
    await prisma.contentPlatform.update({
      where: { contentId_platform: { contentId: content.id, platform } },
      data: { externalId, publishedAt: new Date("2026-09-29T15:19:50.915Z") },
    });
  }
  await prisma.content.update({
    where: { id: content.id },
    data: { status: "PUBLISHED" },
  });

  if (opts.job !== false) {
    const job = await prisma.aIJob.create({
      data: {
        kind: "PUBLISH",
        status: "SUCCESS",
        contentId: content.id,
        output: {
          results: opts.platforms
            .filter((p) => opts.externalIds[p])
            .map((platform) => ({
              platform,
              ok: true,
              message: `pubblicato su ${platform}`,
            })),
        },
      },
    });
    createdJobIds.push(job.id);
  }

  return content.id;
}

function auditsFor(contentId: string) {
  return prisma.auditLog.findMany({
    where: { action: "CONTENT_UNPUBLISHED", entityId: contentId },
    orderBy: { createdAt: "asc" },
  });
}

describe("unpublishContent — rimozione manuale dopo publish riuscito", () => {
  test("1) PUBLISHED + una piattaforma pubblicata → APPROVED e riferimenti azzerati", async () => {
    fetchCalls = [];
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });

    const res = await unpublishContent(
      contentId,
      Platform.INSTAGRAM,
      "Post rimosso manualmente su Instagram."
    );

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(res.removedExternalId, "18099138482074374");
    assert.equal(res.status, "APPROVED");

    const after = await prisma.content.findUniqueOrThrow({
      where: { id: contentId },
      include: { platforms: true },
    });
    assert.equal(after.status, "APPROVED");

    const ig = after.platforms.find((p) => p.platform === Platform.INSTAGRAM)!;
    assert.equal(ig.externalId, null);
    assert.equal(ig.publishedAt, null);

    // Nessuna chiamata esterna.
    assert.deepEqual(fetchCalls, []);
  });

  test("2) con Facebook e Instagram pubblicati, rimuovere Instagram lascia Facebook e PUBLISHED", async () => {
    fetchCalls = [];
    const contentId = await seedPublished({
      platforms: [Platform.FACEBOOK, Platform.INSTAGRAM],
      externalIds: { FACEBOOK: "987654321_001122", INSTAGRAM: "18099138482074374" },
    });

    const res = await unpublishContent(
      contentId,
      Platform.INSTAGRAM,
      "Post Instagram rimosso a mano, Facebook ancora online."
    );

    assert.equal(res.changed, true);
    assert.equal(res.status, "PUBLISHED");

    const after = await prisma.content.findUniqueOrThrow({
      where: { id: contentId },
      include: { platforms: true },
    });
    assert.equal(after.status, "PUBLISHED");

    const ig = after.platforms.find((p) => p.platform === Platform.INSTAGRAM)!;
    const fb = after.platforms.find((p) => p.platform === Platform.FACEBOOK)!;
    assert.equal(ig.externalId, null, "Instagram deve essere ripulita");
    assert.equal(ig.publishedAt, null);
    assert.equal(fb.externalId, "987654321_001122", "Facebook non deve essere toccata");
    assert.ok(fb.publishedAt instanceof Date);

    assert.deepEqual(fetchCalls, []);
  });

  test("3) externalId già null → nessuna modifica e nessun audit", async () => {
    fetchCalls = [];
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: {},
      job: false,
    });
    await prisma.content.update({
      where: { id: contentId },
      data: { status: "APPROVED" },
    });
    const before = await prisma.contentPlatform.findUniqueOrThrow({
      where: { contentId_platform: { contentId, platform: Platform.INSTAGRAM } },
    });
    const beforeContent = await prisma.content.findUniqueOrThrow({
      where: { id: contentId },
    });
    assert.equal(before.externalId, null);

    const res = await unpublishContent(
      contentId,
      Platform.INSTAGRAM,
      "Secondo tentativo, il post era già stato rimosso."
    );

    assert.equal(res.ok, true);
    assert.equal(res.changed, false, "deve dirlo esplicitamente");
    assert.equal(res.removedExternalId, null);
    assert.equal(res.status, "APPROVED");
    assert.match(res.message, /Nessuna pubblicazione attiva/);

    // La riga è quella di prima, campo per campo: nessuna scrittura.
    const after = await prisma.contentPlatform.findUniqueOrThrow({
      where: { contentId_platform: { contentId, platform: Platform.INSTAGRAM } },
    });
    assert.equal(after.id, before.id);
    assert.equal(after.externalId, before.externalId);
    assert.equal(after.publishedAt, before.publishedAt);
    assert.equal(after.error, before.error);
    assert.equal(after.accountId, before.accountId);

    // Nemmeno il Content è stato toccato.
    const afterContent = await prisma.content.findUniqueOrThrow({
      where: { id: contentId },
    });
    assert.equal(afterContent.updatedAt.getTime(), beforeContent.updatedAt.getTime());

    assert.equal(await auditsFor(contentId).then((r) => r.length), 0, "nessun audit");
    assert.deepEqual(fetchCalls, []);
  });

  test("4) l'Approval esistente resta una sola e APPROVED", async () => {
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });
    const approvalId = (
      await prisma.approval.findFirstOrThrow({ where: { contentId } })
    ).id;

    await unpublishContent(contentId, Platform.INSTAGRAM, "Rimosso a mano.");

    const approvals = await prisma.approval.findMany({ where: { contentId } });
    assert.equal(approvals.length, 1, "nessuna nuova Approval");
    assert.equal(approvals[0].id, approvalId, "la stessa Approval di prima");
    assert.equal(approvals[0].decision, "APPROVED");
  });

  test("5) il job storico PUBLISH SUCCESS resta presente e intatto", async () => {
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });
    const job = await prisma.aIJob.findFirstOrThrow({ where: { contentId } });
    assert.equal(job.status, "SUCCESS");

    await unpublishContent(contentId, Platform.INSTAGRAM, "Rimosso a mano.");

    const stillThere = await prisma.aIJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stillThere.status, "SUCCESS", "lo storico non si tocca");
    assert.equal(stillThere.id, job.id);
    assert.ok(stillThere.output);
  });

  test("6) l'audit CONTENT_UNPUBLISHED conserva i dati richiesti", async () => {
    fetchCalls = [];
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });

    await unpublishContent(
      contentId,
      Platform.INSTAGRAM,
      "Cancellato direttamente dall'account Instagram."
    );

    const audits = await auditsFor(contentId);
    assert.equal(audits.length, 1);
    const detail = audits[0].detail as Record<string, unknown>;
    assert.equal(audits[0].entityType, "Content");
    assert.equal(audits[0].entityId, contentId);
    assert.equal(detail.platform, "INSTAGRAM");
    assert.equal(detail.removedExternalId, "18099138482074374");
    assert.equal(detail.reason, "Cancellato direttamente dall'account Instagram.");
    assert.ok(audits[0].createdAt instanceof Date, "timestamp presente");
    assert.deepEqual(fetchCalls, []);
  });

  test("7) piattaforma assente e reason vuoto vengono rifiutati", async () => {
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });

    await assert.rejects(
      () => unpublishContent(contentId, Platform.FACEBOOK, "Non esiste."),
      /non ha la piattaforma FACEBOOK/
    );
    await assert.rejects(
      () => unpublishContent(contentId, Platform.INSTAGRAM, "   "),
      /motivo della rimozione/
    );

    // Nessuna delle due ha scritto nulla.
    const ig = await prisma.contentPlatform.findUniqueOrThrow({
      where: { contentId_platform: { contentId, platform: Platform.INSTAGRAM } },
    });
    assert.equal(ig.externalId, "18099138482074374");
    assert.equal(await auditsFor(contentId).then((r) => r.length), 0);
  });

  test("8) i segreti nel motivo vengono redatti prima dell'audit", async () => {
    const secret = "EAATESTsecretvalue123";
    config.facebook.token = secret;
    const contentId = await seedPublished({
      platforms: [Platform.INSTAGRAM],
      externalIds: { INSTAGRAM: "18099138482074374" },
    });

    await unpublishContent(
      contentId,
      Platform.INSTAGRAM,
      `Rimosso a mano, token ${secret} usato per il check.`
    );

    const detail = (await auditsFor(contentId))[0].detail as Record<string, unknown>;
    assert.ok(!String(detail.reason).includes(secret), "il token non deve finire in chiaro");
    assert.match(String(detail.reason), /\[REDACTED\]/);
  });
});
