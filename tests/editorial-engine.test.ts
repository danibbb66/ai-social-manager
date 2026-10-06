/**
 * Motore editoriale infinito: un DRAFT al giorno, senza data di fine.
 *
 * I test non toccano la rete: lo stub di fetch risponde con HTML di offerte
 * per la pagina e con bytes di immagine per le locandine. Il provider immagini
 * è uno spy che scrive una foto vera sotto public/uploads.
 *
 * Le invarianti verificate:
 *  - venerdì il post nasce da createFlyerSocialDraft (verticale V1.1);
 *  - gli altri giorni da createContent con fromCatalog=true, ancorato a una
 *    proposta ACTIVE reale;
 *  - il contenuto creato è sempre e soltanto DRAFT, senza data di fine;
 *  - la stessa data+tipo non crea mai duplicati (idempotenza);
 *  - un fallimento lascia un run FAILED e nessun contenuto parziale;
 *  - l'endpoint di trigger è protetto da x-api-key (fail closed).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../src/lib/prisma";
import { setImageProvider } from "../src/lib/images/factory";
import { deleteUploadedFile, saveUploadedFile } from "../src/lib/uploads";
import {
  EDITORIAL_KIND_CATALOG,
  EDITORIAL_KIND_FLYER,
  editorialDateKey,
  editorialKindForDate,
  runDailyEditorial,
} from "../src/lib/services/editorial-engine";
import { NextRequest } from "next/server";
import { POST as editorialRunPOST } from "../src/app/api/editorial/run/route";
import { GET as editorialStatusGET } from "../src/app/api/editorial/status/route";
import { OFFERTE_PAGE_URL } from "../src/lib/catalog/offerte";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

/** Il titolo della card che lo stub di fetch fa importare al catalogo. */
const STUB_PROPOSAL_NAME = "Isola Verde";

const IMAGE_URL =
  "https://www.mrhromaboccea.it/wp-content/uploads/2026/09/locandina-ISOLA-VERDE-page-0001.webp";
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

/** Locandina fittizia ma valida: WebP 1080x1080 generato con Sharp. */
let imageBuffer: Buffer | null = null;

async function getImage(): Promise<Buffer> {
  if (!imageBuffer) {
    imageBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#3a7ca5" } })
      .webp()
      .toBuffer();
  }
  return imageBuffer;
}

/** Date fisse: oggi è martedì 29 settembre 2026. */
const FRIDAY = new Date(2026, 9, 2);
const MONDAY = new Date(2026, 9, 5);
const TUESDAY = new Date(2026, 9, 6);
const WEDNESDAY = new Date(2026, 9, 7);
const THURSDAY = new Date(2026, 9, 8);

function offersHtml(): string {
  return `<!DOCTYPE html><html><head><style>
.locandina-grid { display: flex; }
.locandina-link { display: block; }
</style></head><body>
<div class="locandina-grid">
  <a href="${IMAGE_URL}" class="locandina-link" data-title="Isola Verde"></a>
</div></body></html>`;
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
let failImages = false;

function stubNetwork(): void {
  (globalThis as { fetch: FetchStub }).fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/offerte/")) {
      return new Response(offersHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (failImages) throw new Error("download immagine rifiutato (test)");
    return new Response(new Uint8Array(await getImage()), {
      status: 200,
      headers: { "Content-Type": "image/webp" },
    });
  };
}

/** Foto vera 1080x1080: la tela della creatività, che la composizione non ingrandisce. */
async function makePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#2b6a8f" } })
    .jpeg()
    .toBuffer();
}

class SpyImageProvider implements ImageProvider {
  readonly name = "magnific";
  canGenerate = true;
  calls: { prompt: string; options?: GenerateImageOptions }[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push({ prompt, options });
    const saved = await saveUploadedFile({
      buffer: await makePhoto(),
      originalName: "magnific-foto.jpg",
      mimeType: "image/jpeg",
    });
    fileUrls.push(saved.url);
    return {
      url: saved.url,
      provider: this.name,
      pathname: saved.pathname,
      mimeType: saved.mimeType,
      size: saved.size,
      sourceUrl: "https://cdn-magnific.freepik.com/gen/1.webp",
    };
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    throw new Error(`il provider spy non carica file: ${file.originalName}`);
  }
}

const suiteStart = new Date();
let baselineFiles: string[] = [];
let provider: SpyImageProvider;
const fileUrls: string[] = [];

async function listUploads(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(UPLOADS_ROOT);
  return out.sort();
}

/**
 * Pulizia totale di ciò che la suite ha creato: il marker di inizio evita di
 * toccare righe di test precedenti che girano sullo stesso DB.
 */
async function cleanupGenerated() {
  for (const url of fileUrls.splice(0)) {
    await deleteUploadedFile(url).catch(() => undefined);
  }
  await prisma.editorialRun.deleteMany({ where: { createdAt: { gte: suiteStart } } });
  // I contenuti prima: la cascade porta via gli asset a loro collegati. Gli
  // asset con contentId nullo (la locandina del verticale) restano e vengono
  // cancellati dal passaggio successivo.
  await prisma.content.deleteMany({ where: { createdAt: { gte: suiteStart } } });
  await prisma.contentAsset.deleteMany({ where: { createdAt: { gte: suiteStart } } });
  const proposalFilter = {
    OR: [{ acquiredAt: { gte: suiteStart } }, { name: STUB_PROPOSAL_NAME }],
  };
  const proposalIds = (
    await prisma.catalogProposal.findMany({
      where: proposalFilter,
      select: { id: true },
    })
  ).map((p) => p.id);
  await prisma.catalogImage.deleteMany({ where: { proposalId: { in: proposalIds } } });
  await prisma.catalogProposal.deleteMany({ where: proposalFilter });
  await prisma.catalogSource.deleteMany({ where: { pageUrl: OFFERTE_PAGE_URL } });
  const now = await listUploads();
  for (const f of now.filter((f) => !baselineFiles.includes(f))) {
    await fs.unlink(f).catch(() => undefined);
  }
  await fs.rmdir(path.join(UPLOADS_ROOT, "images")).catch(() => undefined);
}

async function assetsOf(contentId: string) {
  return prisma.contentAsset.findMany({ where: { contentId } });
}

describe("motore editoriale", () => {
  before(async () => {
    baselineFiles = await listUploads();
    provider = new SpyImageProvider();
    setImageProvider(provider);
    stubNetwork();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    setImageProvider(null);
    await cleanupGenerated();
    const rest = await listUploads();
    assert.deepEqual(rest, baselineFiles, "la suite non deve lasciare file in public/uploads");
  });

  beforeEach(async () => {
    await prisma.approval.deleteMany();
    await prisma.editorialRun.deleteMany();
    await prisma.content.deleteMany();
    await cleanupGenerated();
    provider.calls.length = 0;
    failImages = false;
    stubNetwork();
  });

  test("venerdì: usa createFlyerSocialDraft V1.1 e crea un DRAFT", async () => {
    assert.equal(editorialKindForDate(FRIDAY), EDITORIAL_KIND_FLYER);

    const outcome = await runDailyEditorial({ date: FRIDAY });
    assert.equal(outcome.reused, false);
    assert.equal(outcome.run.kind, EDITORIAL_KIND_FLYER);
    assert.equal(outcome.run.status, "SUCCESS");
    assert.ok(outcome.run.contentId);

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: outcome.run.contentId! },
    });
    assert.equal(content.status, "DRAFT");
    assert.equal(content.scheduledDate, null, "nessuna data di fine");
    assert.ok(content.catalogProposalId, "ancorato a una proposta reale");

    // La creatività V1.1 è l'unico asset del DRAFT.
    const assets = await assetsOf(content.id);
    assert.equal(assets.length, 1);
    const meta = assets[0].metadata as unknown as Record<string, unknown>;
    assert.equal(meta.origin, "flyer-social-creative");
    assert.equal(meta.vertical, "flyer-social-v1");
    assert.equal(provider.calls.length, 1, "la fotografia è generata una sola volta");
  });

  test("giorno normale: createContent fromCatalog con proposta ACTIVE reale", async () => {
    assert.equal(editorialKindForDate(MONDAY), EDITORIAL_KIND_CATALOG);

    const outcome = await runDailyEditorial({ date: MONDAY });
    assert.equal(outcome.reused, false);
    assert.equal(outcome.run.kind, EDITORIAL_KIND_CATALOG);
    assert.equal(outcome.run.status, "SUCCESS");

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: outcome.run.contentId! },
    });
    assert.equal(content.status, "DRAFT");
    assert.equal(content.scheduledDate, null, "nessuna data di fine");
    assert.ok(content.catalogProposalId);

    const proposal = await prisma.catalogProposal.findUniqueOrThrow({
      where: { id: content.catalogProposalId! },
    });
    assert.equal(proposal.status, "ACTIVE");

    // Il visuale è la creatività dell'agenzia: una foto generata composta col
    // template, mai la locandina del fornitore.
    const assets = await assetsOf(content.id);
    assert.equal(assets.length, 1);
    const meta = assets[0].metadata as unknown as Record<string, unknown>;
    assert.equal(meta.origin, "catalog-social-creative");
    assert.equal(meta.template, "social-creative-v1");
    assert.ok(meta.brandMark !== null, "il marchio dell'agenzia è sul fotogramma");
    assert.equal(provider.calls.length, 1, "una fotografia generata sotto il template");
  });

  test("idempotenza: la stessa data+tipo non crea mai duplicati", async () => {
    const first = await runDailyEditorial({ date: TUESDAY });
    const second = await runDailyEditorial({ date: TUESDAY });

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.run.id, first.run.id, "la seconda esecuzione riusa il run esistente");

    const runs = await prisma.editorialRun.count({
      where: { date: editorialDateKey(TUESDAY), kind: EDITORIAL_KIND_CATALOG },
    });
    assert.equal(runs, 1, "un solo run per data+tipo");
    const contents = await prisma.content.count({ where: { id: first.run.contentId! } });
    assert.equal(contents, 1, "un solo DRAFT per giorno");
  });

  test("DRAFT obbligatorio: nessuna approvazione, programmazione o pubblicazione", async () => {
    const outcome = await runDailyEditorial({ date: THURSDAY });
    assert.equal(outcome.run.status, "SUCCESS");

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: outcome.run.contentId! },
    });
    assert.equal(content.status, "DRAFT", "il contenuto resta una bozza");
    assert.equal(content.scheduledDate, null, "mai una data di fine");

    const platforms = await prisma.contentPlatform.findMany({ where: { contentId: content.id } });
    assert.ok(platforms.length > 0, "il DRAFT dichiara le piattaforme");
    for (const p of platforms) {
      assert.equal(p.publishedAt, null, "mai pubblicato");
    }
    const approvals = await prisma.approval.count({ where: { contentId: content.id } });
    assert.equal(approvals, 0, "mai approvato");
  });

  test("fallimento: run FAILED senza contenuti parziali", async () => {
    failImages = true;
    const marker = new Date();

    const outcome = await runDailyEditorial({ date: WEDNESDAY });
    assert.equal(outcome.reused, false);
    assert.equal(outcome.run.status, "FAILED");
    assert.ok(outcome.run.error, "il motivo del fallimento è registrato");
    assert.equal(outcome.run.contentId, null);

    const contents = await prisma.content.count({ where: { createdAt: { gte: marker } } });
    assert.equal(contents, 0, "nessun contenuto parziale");
    const assets = await prisma.contentAsset.count({ where: { createdAt: { gte: marker } } });
    assert.equal(assets, 0, "nessun asset parziale");
  });
});

describe("endpoint editoriale", () => {
  const originalKey = process.env.EDITORIAL_API_KEY;
  const originalCronSecret = process.env.CRON_SECRET;

  before(async () => {
    baselineFiles = await listUploads();
    provider = new SpyImageProvider();
    setImageProvider(provider);
    stubNetwork();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    setImageProvider(null);
    if (originalKey === undefined) delete process.env.EDITORIAL_API_KEY;
    else process.env.EDITORIAL_API_KEY = originalKey;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    await cleanupGenerated();
    const rest = await listUploads();
    assert.deepEqual(rest, baselineFiles, "la suite non deve lasciare file in public/uploads");
  });

  beforeEach(async () => {
    await prisma.approval.deleteMany();
    await prisma.editorialRun.deleteMany();
    await prisma.content.deleteMany();
    await cleanupGenerated();
    provider.calls.length = 0;
    failImages = false;
    stubNetwork();
  });

  test("401 senza chiave e senza chiave configurata (fail closed)", async () => {
    delete process.env.EDITORIAL_API_KEY;
    const req = new NextRequest("http://localhost/api/editorial/run", { method: "POST" });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 401);
  });

  test("401 con chiave errata", async () => {
    process.env.EDITORIAL_API_KEY = "chiave-giusta";
    const req = new NextRequest("http://localhost/api/editorial/run", {
      method: "POST",
      headers: { "x-api-key": "chiave-sbagliata" },
    });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 401);
  });

  test("200 con chiave valida: il run giornaliero parte", async () => {
    process.env.EDITORIAL_API_KEY = "chiave-giusta";
    const req = new NextRequest("http://localhost/api/editorial/run", {
      method: "POST",
      headers: { "x-api-key": "chiave-giusta" },
    });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; reused: boolean; run: { id: string } };
    assert.equal(body.ok, true);
    assert.ok(body.run.id, "il run giornaliero è partito");
  });

  test("200 con Bearer corretto (Vercel Cron)", async () => {
    process.env.CRON_SECRET = "cron-segreto";
    const req = new NextRequest("http://localhost/api/editorial/run", {
      method: "POST",
      headers: { authorization: "Bearer cron-segreto" },
    });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; reused: boolean; run: { id: string } };
    assert.equal(body.ok, true);
    assert.ok(body.run.id, "il run giornaliero è partito via cron");
  });

  test("401 con Bearer errato", async () => {
    process.env.CRON_SECRET = "cron-segreto";
    const req = new NextRequest("http://localhost/api/editorial/run", {
      method: "POST",
      headers: { authorization: "Bearer sbagliato" },
    });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 401);
  });

  test("401 con Bearer ma CRON_SECRET non configurato (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const req = new NextRequest("http://localhost/api/editorial/run", {
      method: "POST",
      headers: { authorization: "Bearer qualsiasi-cosa" },
    });
    const res = await editorialRunPOST(req);
    assert.equal(res.status, 401);
  });

  test("GET status: 401 senza auth", async () => {
    delete process.env.EDITORIAL_API_KEY;
    delete process.env.CRON_SECRET;
    const req = new NextRequest("http://localhost/api/editorial/status", { method: "GET" });
    const res = await editorialStatusGET(req);
    assert.equal(res.status, 401);
  });

  test("GET status: 401 Bearer errato", async () => {
    process.env.CRON_SECRET = "cron-segreto";
    const req = new NextRequest("http://localhost/api/editorial/status", {
      method: "GET",
      headers: { authorization: "Bearer sbagliato" },
    });
    const res = await editorialStatusGET(req);
    assert.equal(res.status, 401);
  });

  test("GET status: 200 con x-api-key valido", async () => {
    process.env.EDITORIAL_API_KEY = "chiave-giusta";
    const req = new NextRequest("http://localhost/api/editorial/status", {
      method: "GET",
      headers: { "x-api-key": "chiave-giusta" },
    });
    const res = await editorialStatusGET(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      today: string;
      run: unknown;
      pendingDraftsCount: number;
      latestDraft: unknown;
    };
    assert.equal(body.ok, true);
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof body.pendingDraftsCount, "number");
    assert.equal(body.latestDraft, null, "senza run né DRAFT oggi, latestDraft è null");
  });

  test("GET status: 200 con Bearer valido", async () => {
    process.env.CRON_SECRET = "cron-segreto";
    const req = new NextRequest("http://localhost/api/editorial/status", {
      method: "GET",
      headers: { authorization: "Bearer cron-segreto" },
    });
    const res = await editorialStatusGET(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      today: string;
      run: unknown;
      pendingDraftsCount: number;
      latestDraft: unknown;
    };
    assert.equal(body.ok, true);
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof body.pendingDraftsCount, "number");
    assert.equal(body.latestDraft, null, "senza run né DRAFT oggi, latestDraft è null");
  });

  test("GET status: 200 con latestDraft popolato dal DRAFT più recente di oggi", async () => {
    process.env.EDITORIAL_API_KEY = "chiave-giusta";
    const draft = await prisma.content.create({
      data: { type: "POST", title: "Bozza di prova", status: "DRAFT" },
    });

    try {
      const req = new NextRequest("http://localhost/api/editorial/status", {
        method: "GET",
        headers: { "x-api-key": "chiave-giusta" },
      });
      const res = await editorialStatusGET(req);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        latestDraft: {
          id: string;
          title: string | null;
          status: string;
          createdAt: string;
          catalogProposalId: string | null;
        } | null;
      };
      assert.equal(body.ok, true);
      assert.ok(body.latestDraft, "latestDraft deve essere popolato");
      assert.equal(body.latestDraft.id, draft.id);
      assert.equal(body.latestDraft.title, "Bozza di prova");
      assert.equal(body.latestDraft.status, "DRAFT");
      assert.equal(body.latestDraft.catalogProposalId, null);
      assert.ok(body.latestDraft.createdAt);
    } finally {
      await prisma.content.delete({ where: { id: draft.id } });
    }
  });
});
