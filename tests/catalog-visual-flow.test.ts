/**
 * Materializzazione del visuale di catalogo: ramo immagine ufficiale.
 *
 * Il punto che questa suite dimostra è l'ordine delle operazioni, non la
 * riuscita per sé: il DRAFT non deve mai esistere senza il suo visuale, e ogni
 * errore deve lasciare il filesystem e il database come erano.
 *
 * La rete è sostituita con uno stub di `fetch` (come in `remote-image.test.ts`),
 * il provider immagini è un finto che registra le chiamate, e il fallimento
 * della transazione è provocato davvero: si punta a un `catalogProposalId`
 * inesistente, così è il vincolo di chiave esterna a far fallire la
 * transazione. Nessun aggancio solo-per-test nel codice di produzione.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import {
  CATALOG_VISUAL_ORIGIN,
  materializeCatalogVisual,
  type CatalogVisualMetadata,
} from "../src/lib/services/catalog-visual";
import { setImageProvider } from "../src/lib/images/factory";
import { deleteUploadedFile } from "../src/lib/uploads";
import {
  buildVisualDirection,
  catalogCopyFromProposal,
  pickEditorialFormat,
  type ContentFormat,
  type VisualDirection,
} from "../src/lib/ai/catalog-content";
import { toCatalogProposalDto, type CatalogProposalDto } from "../src/lib/services/catalog-ai";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

const SOURCE_DOMAIN = "catalogo.test";
const IMAGE_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/06/REPUBBLICA-5-NOTTI.webp`;
const IMAGE_NAME = "REPUBBLICA-5-NOTTI.webp";
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

const originalFetch = globalThis.fetch;
const sourceIds: string[] = [];
const contentIds: string[] = [];
const assetIds: string[] = [];
const savedUrls: string[] = [];

let baselineFiles: string[] = [];
let proposalId = "";

const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0, 0, 0, 0]),
]);

/** Provider finto: nessuna chiamata deve arrivargli, in nessun test. */
class SpyImageProvider implements ImageProvider {
  readonly name = "spy";
  readonly canGenerate = true;
  calls: string[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push(`generateImage:${options?.aspectRatio ?? "-"}:${prompt.slice(0, 20)}`);
    throw new Error("Magnific non deve essere chiamato dal flusso catalogo");
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    this.calls.push(`saveUploadedFile:${file.originalName}`);
    throw new Error("il file deve passare da downloadRemoteImage, non dal provider");
  }
}

let provider: SpyImageProvider;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubImage(status = 200, body: Buffer = WEBP, headers: Record<string, string> = {}): void {
  (globalThis as { fetch: FetchStub }).fetch = async () =>
    new Response(new Uint8Array(body), {
      status,
      headers: { "Content-Type": "image/webp", ...headers },
    });
}

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
 * Pulizia fra un test e l'altro: solo ciò che i test producono.
 *
 * Il fixture di catalogo (fonte + proposta) resta per tutta la suite: eliminarlo
 * qui farebbe sparire la proposta sotto i test successivi.
 */
async function cleanupGenerated() {
  for (const url of savedUrls.splice(0)) {
    await deleteUploadedFile(url).catch(() => undefined);
  }
  for (const id of assetIds.splice(0)) {
    await prisma.contentAsset.deleteMany({ where: { id } });
  }
  for (const id of contentIds.splice(0)) {
    await prisma.content.deleteMany({ where: { id } });
  }
  const now = await listUploads();
  for (const f of now.filter((f) => !baselineFiles.includes(f))) {
    await fs.unlink(f).catch(() => undefined);
  }
  await fs.rmdir(path.join(UPLOADS_ROOT, "images")).catch(() => undefined);
}

/** Chiusura suite: rimuove anche il fixture di catalogo. */
async function cleanupAll() {
  await cleanupGenerated();
  for (const id of sourceIds.splice(0)) {
    await prisma.catalogSource.deleteMany({ where: { id } });
  }
}

/**
 * Quante righe sono nate da un certo momento.
 *
 * Serve a dire "non è stato creato nulla" senza dipendere dal contenuto del
 * database, che contiene anche gli asset creati da altre suite.
 */
async function countsSince(marker: Date) {
  return {
    content: await prisma.content.count({ where: { createdAt: { gte: marker } } }),
    asset: await prisma.contentAsset.count({ where: { createdAt: { gte: marker } } }),
  };
}

async function loadProposal(): Promise<CatalogProposalDto> {
  const row = await prisma.catalogProposal.findUniqueOrThrow({
    where: { id: proposalId },
    include: {
      images: { orderBy: { acquiredAt: "asc" } },
      source: true,
      // `toCatalogProposalDto` si aspetta lo stesso include che usa il servizio
      // per l'AI, incluso l'ultimo utilizzo: altrimenti il DTO è incompleto.
      contents: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  return toCatalogProposalDto(row as never);
}

/** DTO con un id di proposta inesistente: fa fallire la transazione davvero. */
async function loadOrphanProposal(): Promise<CatalogProposalDto> {
  const dto = await loadProposal();
  return { ...dto, id: "proposta-inesistente-000000000000" };
}

function directionFor(dto: CatalogProposalDto, format: ContentFormat): VisualDirection {
  return buildVisualDirection(dto, format);
}

before(async () => {
  baselineFiles = await listUploads();
  provider = new SpyImageProvider();
  setImageProvider(provider);

  const source = await prisma.catalogSource.create({
    data: {
      domain: SOURCE_DOMAIN,
      baseUrl: `https://${SOURCE_DOMAIN}`,
      pageUrl: `https://${SOURCE_DOMAIN}/offerte/`,
      lastCrawledAt: new Date(),
    },
  });
  sourceIds.push(source.id);

  const proposal = await prisma.catalogProposal.create({
    data: {
      name: "Offerta Reale Repubblica",
      destination: "Repubblica",
      sourceId: source.id,
      sourceUrl: `https://${SOURCE_DOMAIN}/offerte/#repubblica`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-catalog-visual",
      sourceOrder: 1,
      periodStart: new Date("2026-12-20T00:00:00Z"),
      periodEnd: new Date("2026-12-25T00:00:00Z"),
      durationNights: 5,
      priceFrom: 890,
      priceTo: 1290,
      currency: "EUR",
      included: "volo e hotel",
      images: { create: { url: IMAGE_URL, filename: IMAGE_NAME } },
    },
  });
  proposalId = proposal.id;
});

after(async () => {
  globalThis.fetch = originalFetch;
  setImageProvider(null);
  await cleanupAll();
  const rest = await listUploads();
  assert.deepEqual(rest, baselineFiles, "la suite non deve lasciare file in public/uploads");
});

beforeEach(async () => {
  await cleanupGenerated();
  provider.calls.length = 0;
  stubImage();
});

async function run(dto: CatalogProposalDto, direction: VisualDirection) {
  const format = direction.format;
  const result = await materializeCatalogVisual({
    proposal: dto,
    direction,
    copy: catalogCopyFromProposal(dto, format),
    platforms: ["INSTAGRAM", "FACEBOOK"],
  });
  if (result.ok) {
    contentIds.push(result.content.id);
    assetIds.push(result.asset.id);
    savedUrls.push(result.asset.url);
  }
  return result;
}

describe("materializzazione con immagine ufficiale", () => {
  test("1. crea il DRAFT e un solo asset, con il visuale già a terra", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const result = await run(dto, direction);

    assert.equal(result.ok, true, "la materializzazione doveva riuscire");
    if (!result.ok) return;

    // Il file esiste prima di ogni domanda sul database: è l'ordine che conta.
    const absolute = path.join(process.cwd(), "public", result.asset.url.replace(/^\//, ""));
    assert.equal(absolute.startsWith(UPLOADS_ROOT + path.sep), true);
    const written = await fs.readFile(absolute);
    assert.deepEqual(written, WEBP, "il file deve essere l'immagine ufficiale scaricata");

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: true, approvals: true, platforms: true },
    });
    assert.equal(stored.status, "DRAFT");
    assert.equal(stored.catalogProposalId, proposalId);
    assert.equal(stored.assets.length, 1, "esattamente un asset");
    assert.equal(stored.assets[0].kind, "IMAGE");
    assert.equal(stored.assets[0].contentId, result.content.id, "l'asset deve stare agganciato al contenuto");
    assert.equal(stored.assets[0].url, result.asset.url);
    assert.equal(stored.approvals.length, 0, "nessuna approvazione su un DRAFT");
    assert.deepEqual(
      stored.platforms.map((p) => p.platform).sort(),
      ["FACEBOOK", "INSTAGRAM"]
    );

    const meta = stored.assets[0].metadata as unknown as CatalogVisualMetadata;
    assert.equal(meta.origin, CATALOG_VISUAL_ORIGIN);
    assert.equal(meta.origin, "catalog-official");
    assert.equal(meta.provider, "catalog");
    assert.equal(meta.sourceUrl, IMAGE_URL);
    assert.equal(meta.catalogProposalId, proposalId);
    assert.equal(meta.mimeType, "image/webp");
    assert.equal(meta.size, WEBP.length);
    assert.equal(meta.filename, result.asset.filename);

    const imageRow = await prisma.catalogImage.findFirstOrThrow({ where: { url: IMAGE_URL } });
    assert.equal(meta.catalogImageId, imageRow.id, "la provenienza deve puntare alla riga CatalogImage");
  });

  test("2. la copy e il formato del catalogo restano quelli, senza riscritture", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const copy = catalogCopyFromProposal(dto, format);
    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: true },
    });
    assert.equal(stored.title, copy.title);
    assert.equal(stored.caption, copy.caption);
    assert.equal(stored.hashtags, copy.hashtags);

    const meta = stored.assets[0].metadata as unknown as CatalogVisualMetadata;
    assert.equal(meta.editorialFormat, format, "il formato editoriale deve restare tracciato");
    assert.equal(meta.visualDirection.format, format);
  });

  test("3. la direzione resta grounded: nessun dato commerciale inventato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: true },
    });
    const meta = stored.assets[0].metadata as unknown as CatalogVisualMetadata;

    assert.deepEqual(
      meta.visualDirection,
      result.direction,
      "il metadata deve contenere la direzione ricevuta, non una versione rigenerata"
    );
    assert.equal(meta.visualDirection.groundedOn.catalogProposalId, proposalId);
    assert.equal(meta.visualDirection.useOfficialImage, true);
    assert.equal(meta.visualDirection.needsGeneration, false);
    assert.equal(meta.visualDirection.officialImageUrl, IMAGE_URL);
  });

  test("4. il provider Magnific non viene mai chiamato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    assert.deepEqual(provider.calls, [], "nessuna generazione, nessun upload via provider");
  });
});

describe("rifiuti prima della scrittura", () => {
  test("5. host fuori allowlist: nessun DRAFT, nessun asset, nessun file", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    // Stesso URL del catalogo, ma la allowlist dichiara un'altra fonte.
    const before = await listUploads();
    const marker = new Date();

    const result = await materializeCatalogVisual({
      proposal: { ...dto, source: { ...dto.source, domain: "altro-sito.test" } },
      direction: directionFor(dto, format),
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "download_failed");
    assert.equal(result.detail, "host_not_allowed");

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before, "nessun file residuo");
    assert.deepEqual(provider.calls, []);
  });

  test("6. download fallito: nessun DRAFT, nessun asset, nessun file", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    stubImage(404, Buffer.alloc(0), {});
    const before = await listUploads();
    const marker = new Date();

    const result = await materializeCatalogVisual({
      proposal: dto,
      direction: directionFor(dto, format),
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "download_failed");
    assert.equal(result.detail, "http_error");
    assert.match(result.message, /non viene creato alcun contenuto/);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
    assert.deepEqual(provider.calls, []);
  });

  test("6b. contenuto non immagine: nessun DRAFT e nessun file", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    stubImage(200, Buffer.from("<!DOCTYPE html><html></html>"), { "Content-Type": "text/html" });
    const before = await listUploads();
    const marker = new Date();

    const result = await materializeCatalogVisual({
      proposal: dto,
      direction: directionFor(dto, format),
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "download_failed");
    assert.equal(result.detail, "not_an_image");
    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
  });
});

describe("transazione fallita dopo il download", () => {
  test("7. il file viene ripulito e non resta nulla", async () => {
    const dto = await loadOrphanProposal();
    const { format } = pickEditorialFormat(dto, null);
    const before = await listUploads();
    const marker = new Date();

    // La proposta non esiste: il download riesce, la transazione no.
    const result = await materializeCatalogVisual({
      proposal: dto,
      direction: directionFor(dto, format),
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "persist_failed");
    assert.equal(result.detail, "file_removed", "il file scaricato deve essere eliminato");

    assert.deepEqual(await listUploads(), before, "nessun file residuo sul disco");
    assert.deepEqual(
      await countsSince(marker),
      { content: 0, asset: 0 },
      "il rollback deve annullare sia il contenuto sia l'asset"
    );
    assert.deepEqual(provider.calls, []);
  });

  test("7b. dopo il rollback nessun asset resta senza contenuto", async () => {
    // La proprietà verificata è "asset e contenuto nascono insieme": ogni
    // asset creato da questa suite deve avere un contenuto, e il DRAFT appena
    // creato deve avere esattamente un asset.
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const result = await run(dto, directionFor(dto, format));
    assert.equal(result.ok, true);

    const created = await prisma.contentAsset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, contentId: true },
    });
    assert.ok(created.length > 0, "la suite deve aver creato almeno un asset");
    for (const asset of created) {
      assert.ok(asset.contentId, `asset orfano: ${asset.id}`);
    }

    const target = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: true },
    });
    assert.equal(target.assets.length, 1, "il DRAFT del catalogo non resta senza visual");
  });
});

describe("proposta senza immagine ufficiale", () => {
  test("8. officialImage null: risultato esplicito e nulla creato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const noImage: CatalogProposalDto = { ...dto, officialImage: null };
    const noImageDirection: VisualDirection = {
      ...direction,
      useOfficialImage: false,
      officialImageUrl: null,
      officialImageFilename: null,
      needsGeneration: true,
      visualType: "GENERATED_HERO",
    };

    const before = await listUploads();
    const marker = new Date();
    const result = await materializeCatalogVisual({
      proposal: noImage,
      direction: noImageDirection,
      copy: catalogCopyFromProposal(noImage, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_official_image");
    assert.equal(result.needsGeneration, true, "il chiamante deve sapere che serve generare");
    assert.deepEqual(result.direction, noImageDirection, "la direzione torna indietro per il ramo generato");
    assert.match(result.message, /non viene creato alcun contenuto/);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
    assert.deepEqual(provider.calls, [], "neppure il ramo assente chiama Magnific");
  });

  test("8b. DTO e direzione in disaccordo non materializzano nulla", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    // La direzione dice "uso l'originale" ma il DTO non ce l'ha: il servizio
    // non sceglie da che parte stare, semplicemente non crea nulla.
    const marker = new Date();
    const result = await materializeCatalogVisual({
      proposal: { ...dto, officialImage: null },
      direction,
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_official_image");
    assert.equal(result.needsGeneration, true);
    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(provider.calls, []);
  });
});

describe("indipendenza dal chiamante", () => {
  test("9. il servizio non sa nulla dell'agent né del provider immagini", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "lib", "services", "catalog-visual.ts"),
      "utf8"
    );
    const imports = source.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    for (const forbidden of ["ai/agent", "images/factory", "images/magnific", "images/provider", "tools/content"]) {
      assert.ok(
        !imports.some((l) => l.includes(forbidden)),
        `catalog-visual.ts non deve importare "${forbidden}"`
      );
    }
    assert.ok(!/getImageProvider|setImageProvider/.test(source), "nessuna chiamata al provider");
  });

  test("10. il DRAFT resta un DRAFT: nessuna approvazione, nessuna programmazione", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { approvals: true, jobs: true },
    });
    assert.equal(stored.status, "DRAFT");
    assert.equal(stored.scheduledDate, null);
    assert.equal(stored.approvals.length, 0);
    assert.equal(stored.jobs.length, 0, "nessun job AI lanciato");
  });
});
