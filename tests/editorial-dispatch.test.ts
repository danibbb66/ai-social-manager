import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { createContent, deleteContent } from "../src/lib/services/content";
import { dispatchDueContents } from "../src/lib/services/dispatch";
import { setImageProvider, setStockProvider } from "../src/lib/images/factory";
import { ImageProvider } from "../src/lib/images/provider";
import { installFakeStock } from "./helpers/stock";

class NoopImageProvider implements ImageProvider {
  readonly name = "test-noop";
  readonly canGenerate = false;
  async generateImage(): Promise<never> {
    throw new Error("il provider di test non genera immagini");
  }
  async saveUploadedFile(): Promise<never> {
    throw new Error("il provider di test non salva file");
  }
}

const createdIds: string[] = [];

async function cleanup() {
  for (const id of createdIds.splice(0)) {
    await prisma.contentAsset.deleteMany({ where: { contentId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: id } }).catch(() => {});
    try {
      await deleteContent(id);
    } catch {
      // già eliminato
    }
  }
}

async function makeScheduled(title: string, scheduledDate: Date) {
  const c = await createContent({
    title,
    caption: "Caption di test",
    platforms: ["INSTAGRAM"],
  });
  createdIds.push(c.id);
  await prisma.content.update({
    where: { id: c.id },
    data: { status: "SCHEDULED", scheduledDate },
  });
  return c;
}

before(async () => {
  setImageProvider(new NoopImageProvider());
  installFakeStock();
  await cleanup();
});

after(async () => {
  setImageProvider(null);
  setStockProvider(null);
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
});

describe("dispatchDueContents", () => {
  test("un contenuto di oggi viene pubblicato, quelli dei giorni prima tornano in bozza", async () => {
    const now = new Date("2026-10-22T14:00:00.000Z");
    const publishedIds: string[] = [];
    const yesterday = await makeScheduled(
      "[TEST] missed yesterday",
      new Date("2026-10-21T12:00:00.000Z")
    );
    const today = await makeScheduled(
      "[TEST] due today",
      new Date("2026-10-22T12:00:00.000Z")
    );

    const outcome = await dispatchDueContents(now, async (id) => {
      publishedIds.push(id);
      return { ok: true, message: "ok", jobId: "job-1" };
    });

    assert.deepEqual(publishedIds, [today.id]);
    assert.equal(outcome.published, 1);
    assert.equal(outcome.returnedToDraft, 1);

    const missed = await prisma.content.findUnique({ where: { id: yesterday.id } });
    const current = await prisma.content.findUnique({ where: { id: today.id } });
    assert.equal(missed?.status, "DRAFT");
    assert.equal(missed?.scheduledDate, null);
    assert.equal(current?.status, "SCHEDULED", "il fake publish non cambia lo stato");
  });

  test("se oggi ci sono due programmati esce solo il primo, l'altro torna in bozza", async () => {
    const now = new Date("2026-10-22T14:00:00.000Z");
    const publishedIds: string[] = [];
    const first = await makeScheduled(
      "[TEST] first today",
      new Date("2026-10-22T11:00:00.000Z")
    );
    const second = await makeScheduled(
      "[TEST] second today",
      new Date("2026-10-22T12:00:00.000Z")
    );

    const outcome = await dispatchDueContents(now, async (id) => {
      publishedIds.push(id);
      return { ok: true, message: "ok", jobId: "job-2" };
    });

    assert.deepEqual(publishedIds, [first.id]);
    assert.equal(outcome.published, 1);
    assert.equal(outcome.returnedToDraft, 1);

    const extra = await prisma.content.findUnique({ where: { id: second.id } });
    assert.equal(extra?.status, "DRAFT");
    assert.equal(extra?.scheduledDate, null);
  });

  test("se c'è solo un arretrato, non pubblica nulla e lo rimette in bozza", async () => {
    const now = new Date("2026-10-22T14:00:00.000Z");
    const publishedIds: string[] = [];
    const yesterday = await makeScheduled(
      "[TEST] only missed",
      new Date("2026-10-21T12:00:00.000Z")
    );

    const outcome = await dispatchDueContents(now, async (id) => {
      publishedIds.push(id);
      return { ok: true, message: "ok", jobId: "job-3" };
    });

    assert.deepEqual(publishedIds, []);
    assert.equal(outcome.published, 0);
    assert.equal(outcome.returnedToDraft, 1);

    const missed = await prisma.content.findUnique({ where: { id: yesterday.id } });
    assert.equal(missed?.status, "DRAFT");
  });
});
