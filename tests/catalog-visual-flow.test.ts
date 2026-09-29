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
import { createJobOwnership } from "./helpers/aijob-ownership";
import {
  CATALOG_GENERATED_ORIGIN,
  CATALOG_VISUAL_ORIGIN,
  materializeCatalogVisual,
  type CatalogGeneratedVisualMetadata,
  type CatalogVisualMetadata,
} from "../src/lib/services/catalog-visual";
import { setImageProvider } from "../src/lib/images/factory";
import { deleteUploadedFile, saveUploadedFile } from "../src/lib/uploads";
import {
  buildVisualDirection,
  catalogCopyFromProposal,
  pickEditorialFormat,
  visualPromptFromDirection,
  MAX_VISUAL_PROMPT_LENGTH,
  type ContentFormat,
  type VisualDirection,
} from "../src/lib/ai/catalog-content";
import { toCatalogProposalDto, type CatalogProposalDto } from "../src/lib/services/catalog-ai";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

const SOURCE_DOMAIN = "catalogo.test";
const IMAGE_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/06/REPUBBLICA-5-NOTTI.webp`;
const IMAGE_NAME = "REPUBBLICA-5-NOTTI.webp";
/** Seconda immagine della stessa proposta: serve a provare che l'identità è l'immagine. */
const OTHER_IMAGE_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/06/REPUBBLICA-5-NOTTI-ALTRA.webp`;
const OTHER_IMAGE_NAME = "REPUBBLICA-5-NOTTI-ALTRA.webp";
/** Seconda proposta della stessa fonte: serve a provare che l'identità è anche la proposta. */
const OTHER_IMAGE_2_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/07/GRECIA-7-NOTTI.webp`;
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

const originalFetch = globalThis.fetch;
const sourceIds: string[] = [];
const contentIds: string[] = [];
const assetIds: string[] = [];
const savedUrls: string[] = [];
/** File scritti dal provider finto: vanno ripuliti come quelli scaricati. */
const generatedFiles: string[] = [];
/** Job AI creati dai test, per poterli contare e ripulire. */
const jobIds: string[] = [];
/** I job AI di questa suite si ripuliscono per identità, non per data di nascita. */
const jobOwnership = createJobOwnership(["IMAGE"]);

let baselineFiles: string[] = [];
let proposalId = "";
let otherProposalId = "";
let otherImageId = "";

const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0, 0, 0, 0]),
]);

/**
 * Provider finto che registra ogni generazione.
 *
 * Nel ramo ufficiale non deve mai essere chiamato: i test che lo affermano
 * falliscono se una chiamata arriva. Nel ramo generato è l'unico modo per
 * avere un file a terra senza uscire in rete, quindi qui scrive davvero un
 * file sotto `public/uploads` e restituisce le sue coordinate.
 */
class SpyImageProvider implements ImageProvider {
  readonly name = "magnific";
  canGenerate = true;
  /** Comportamento impostato dal test: `"ok"`, `"fail"` o `"no-file"`. */
  behaviour: "ok" | "fail" | "no-file" = "ok";
  calls: { prompt: string; options?: GenerateImageOptions }[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push({ prompt, options });
    if (this.behaviour === "fail") {
      throw new Error("Magnific ha risposto 500");
    }
    if (this.behaviour === "no-file") {
      // Il provider ha prodotto un URL ma non ha scritto nulla: simula un
      // generatore che mente, così si vede che il servizio non inventa file.
      return { url: "/uploads/images/non-esiste.png", provider: this.name, pathname: "", mimeType: "image/png", size: 0 };
    }
    const saved = await saveUploadedFile({
      buffer: WEBP,
      originalName: `magnific-${this.calls.length}.webp`,
      mimeType: "image/webp",
    });
    generatedFiles.push(saved.url);
    return {
      url: saved.url,
      provider: this.name,
      pathname: saved.pathname,
      mimeType: saved.mimeType,
      size: saved.size,
      sourceUrl: `https://cdn-magnific.freepik.com/gen/${this.calls.length}.webp`,
    };
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    this.calls.push({ prompt: `saveUploadedFile:${file.originalName}` });
    throw new Error("il ramo catalogo non carica file: usa il downloader o la generazione");
  }
}

let provider: SpyImageProvider;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Quante volte il downloader è entrato in rete davvero.
 *
 * È il contatore che rende osservabile l'idempotenza: riusare un asset non
 * significa saltare la verifica, significa non aprire una connessione. Un test
 * che guarda solo il database passerebbe anche se il download avvenisse due
 * volte e il secondo file venisse cancellato in silenzio.
 */
let fetchCalls = 0;

function stubImage(status = 200, body: Buffer = WEBP, headers: Record<string, string> = {}): void {
  (globalThis as { fetch: FetchStub }).fetch = async () => {
    fetchCalls += 1;
    return new Response(new Uint8Array(body), {
      status,
      headers: { "Content-Type": "image/webp", ...headers },
    });
  };
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
  for (const url of generatedFiles.splice(0)) {
    await deleteUploadedFile(url).catch(() => undefined);
  }
  for (const id of assetIds.splice(0)) {
    await prisma.contentAsset.deleteMany({ where: { id } });
  }
  // I job del ramo generato restano anche quando il test non ha registrato
  // l'id: sono di questa suite e si riconoscono per identità, non per data.
  // Prima dei contenuti, che azzererebbero il `contentId` dei job.
  await jobOwnership.deleteOwned(contentIds);
  for (const id of contentIds.splice(0)) {
    await prisma.content.deleteMany({ where: { id } });
  }
  for (const id of jobIds.splice(0)) {
    await prisma.aIJob.deleteMany({ where: { id } });
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
  return loadProposalById(proposalId);
}

async function loadProposalById(id: string): Promise<CatalogProposalDto> {
  const row = await prisma.catalogProposal.findUniqueOrThrow({
    where: { id },
    include: {
      // La seconda immagine ha `acquiredAt` successivo, quindi `images[0]`
      // resta l'originale: i test possono scegliere quale passare nel DTO.
      images: { orderBy: { acquiredAt: "asc" } },
      source: true,
      // `toCatalogProposalDto` si aspetta lo stesso include che usa il servizio
      // per l'AI, incluso l'ultimo utilizzo: altrimenti il DTO è incompleto.
      contents: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  return toCatalogProposalDto(row as never);
}

/** Il DTO della proposta, ma con l'altra immagine ufficiale del catalogo. */
async function loadProposalWithOtherImage(): Promise<CatalogProposalDto> {
  const dto = await loadProposal();
  return {
    ...dto,
    officialImage: { id: otherImageId, url: OTHER_IMAGE_URL, filename: OTHER_IMAGE_NAME },
  };
}

/** DTO con un id di proposta inesistente: fa fallire la transazione davvero. */
async function loadOrphanProposal(): Promise<CatalogProposalDto> {
  const dto = await loadProposal();
  return { ...dto, id: "proposta-inesistente-000000000000" };
}

/** Il DTO della proposta, ma senza immagine nel catalogo: si deve generare. */
async function loadProposalWithoutImage(): Promise<CatalogProposalDto> {
  const dto = await loadProposal();
  return { ...dto, officialImage: null };
}

/**
 * La direzione che il flusso catalogo costruirebbe per una proposta senza
 * immagine: niente originale da usare, quindi la generazione è il ramo previsto.
 */
function generationDirectionFor(dto: CatalogProposalDto, format: ContentFormat): VisualDirection {
  const direction = directionFor(dto, format);
  return {
    ...direction,
    useOfficialImage: false,
    officialImageUrl: null,
    officialImageFilename: null,
    needsGeneration: true,
    visualType: "GENERATED_HERO",
  };
}

function directionFor(dto: CatalogProposalDto, format: ContentFormat): VisualDirection {
  return buildVisualDirection(dto, format);
}

before(async () => {
  baselineFiles = await listUploads();
  await jobOwnership.capture();
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
      images: {
        // `acquiredAt` esplicito: creato nella stessa chiamata, le due righe
        // avrebbero lo stesso timestamp e l'ordinamento del DTO diventerebbe
        // arbitrario, rendendo i test instabili fra esecuzioni.
        create: [
          { url: IMAGE_URL, filename: IMAGE_NAME, acquiredAt: new Date("2026-06-01T00:00:00Z") },
          {
            url: OTHER_IMAGE_URL,
            filename: OTHER_IMAGE_NAME,
            acquiredAt: new Date("2026-06-02T00:00:00Z"),
          },
        ],
      },
    },
  });
  proposalId = proposal.id;
  const images = await prisma.catalogImage.findMany({
    where: { proposalId },
    orderBy: { url: "asc" },
  });
  otherImageId = images.find((i) => i.url === OTHER_IMAGE_URL)!.id;

  // Seconda proposta, stessa fonte: esiste solo per il caso non idempotente.
  const other = await prisma.catalogProposal.create({
    data: {
      name: "Offerta Reale Grecia",
      destination: "Grecia",
      sourceId: source.id,
      sourceUrl: `https://${SOURCE_DOMAIN}/offerte/#grecia`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-catalog-visual-grecia",
      sourceOrder: 2,
      periodStart: new Date("2026-07-10T00:00:00Z"),
      periodEnd: new Date("2026-07-17T00:00:00Z"),
      durationNights: 7,
      priceFrom: 1100,
      currency: "EUR",
      images: { create: { url: OTHER_IMAGE_2_URL, filename: "GRECIA-7-NOTTI.webp" } },
    },
  });
  otherProposalId = other.id;
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
  provider.behaviour = "ok";
  provider.canGenerate = true;
  fetchCalls = 0;
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
    // Nel ramo riusato l'url è quello di una materializzazione precedente, già
    // in lista: `includes` evita di registrarlo due volte.
    if (!savedUrls.includes(result.asset.url)) savedUrls.push(result.asset.url);
  }
  return result;
}

/** I job AI nati da un certo momento: il ramo generato ne crea, quello ufficiale no. */
async function jobsSince(marker: Date) {
  return prisma.aIJob.findMany({
    where: { createdAt: { gte: marker } },
    orderBy: { createdAt: "asc" },
  });
}

/** Numeri di riferimento per dire "non è cambiato niente". */
async function snapshot() {
  return {
    content: await prisma.content.count({ where: { catalogProposalId: proposalId } }),
    asset: await prisma.contentAsset.count({
      where: { content: { catalogProposalId: proposalId } },
    }),
    files: (await listUploads()).length,
  };
}

describe("materializzazione con immagine ufficiale", () => {
  test("1. crea il DRAFT e un solo asset, con il visuale già a terra", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const result = await run(dto, direction);

    assert.equal(result.ok, true, "la materializzazione doveva riuscire");
    if (!result.ok) return;
    assert.equal(result.reused, false, "la prima chiamata crea davvero");

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
  test("8. officialImage assente: il provider genera e il file è a terra", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    const direction = generationDirectionFor(dto, format);

    const marker = new Date();
    const result = await run(dto, direction);

    assert.equal(result.ok, true, "senza originale il visuale si genera");
    if (!result.ok) return;
    assert.equal(result.reused, false);
    assert.equal(result.origin, CATALOG_GENERATED_ORIGIN, "il chiamante deve sapere che è un'immagine generata");
    assert.equal(CATALOG_GENERATED_ORIGIN, "magnific", "l'origine generata ha un nome stabile");

    // Una sola generazione, e non un download: i due rami non si confondono.
    assert.equal(provider.calls.length, 1);
    assert.equal(fetchCalls, 0, "senza originale non c'è nulla da scaricare");

    const absolute = path.join(process.cwd(), "public", result.asset.url.replace(/^\//, ""));
    const written = await fs.readFile(absolute);
    assert.deepEqual(written, WEBP, "il file del provider deve essere quello a terra");

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: true, platforms: true, approvals: true },
    });
    assert.equal(stored.status, "DRAFT");
    assert.equal(stored.catalogProposalId, proposalId);
    assert.equal(stored.assets.length, 1, "esattamente un asset");
    assert.equal(stored.assets[0].kind, "IMAGE");
    assert.equal(stored.assets[0].url, result.asset.url);
    assert.equal(stored.assets[0].filename, result.asset.filename);
    assert.equal(stored.assets[0].mimeType, "image/webp");
    assert.equal(stored.assets[0].size, WEBP.length);
    assert.deepEqual(
      stored.platforms.map((p) => p.platform).sort(),
      ["FACEBOOK", "INSTAGRAM"]
    );
    assert.equal(stored.approvals.length, 0, "nessuna approvazione su un DRAFT");

    const meta = stored.assets[0].metadata as unknown as CatalogGeneratedVisualMetadata;
    assert.equal(meta.origin, CATALOG_GENERATED_ORIGIN);
    assert.equal(meta.provider, "magnific");
    assert.equal(meta.catalogProposalId, proposalId);
    assert.equal(meta.catalogImageId, null, "nessuna immagine del catalogo è coinvolta");
    assert.equal(meta.editorialFormat, format);
    assert.deepEqual(meta.visualDirection, direction);
    assert.equal(meta.prompt, visualPromptFromDirection(direction));
    assert.equal(meta.aspectRatio, "square_1_1");
    assert.equal(meta.resolution, "1k");
    assert.ok(
      typeof meta.sourceUrl === "string" && meta.sourceUrl.startsWith("https://"),
      "l'URL del provider resta tracciato, ma non è la fonte del visuale"
    );

    // Una generazione vera lascia un job chiuso con successo: è l'unico modo per
    // sapere domani che quel file è stato prodotto e paid.
    const jobs = await jobsSince(marker);
    assert.equal(jobs.length, 1, "una generazione, un job");
    assert.equal(jobs[0].kind, "IMAGE");
    assert.equal(jobs[0].status, "SUCCESS");
    const jobInput = jobs[0].input as { prompt?: string; aspectRatio?: string; resolution?: string };
    assert.equal(jobInput.prompt, meta.prompt);
    assert.equal(jobInput.aspectRatio, meta.aspectRatio);
    assert.equal(jobInput.resolution, meta.resolution);
  });

  test("8b. DTO con immagine e direzione che non la usa: nulla, nemmeno generato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    // Il caso inverso di 8: qui il catalogo ha un originale, ma la direzione
    // dice di non usarlo. Il servizio non sceglie: non scarica e non genera,
    // perché generare sarebbe decidere quale dei due dati mente.
    const direction: VisualDirection = {
      ...directionFor(dto, format),
      useOfficialImage: false,
      needsGeneration: true,
    };

    const before = await listUploads();
    const marker = new Date();
    const result = await materializeCatalogVisual({
      proposal: dto,
      direction,
      copy: catalogCopyFromProposal(dto, format),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_official_image");
    assert.equal(result.needsGeneration, true);
    assert.deepEqual(result.direction, direction);
    assert.match(result.message, /non concordano/);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
    assert.deepEqual(provider.calls, [], "il disaccordo non è un invito a generare");
    assert.equal(fetchCalls, 0, "e non è un invito a scaricare");
    assert.equal((await jobsSince(marker)).length, 0, "nessun job per una richiesta non eseguita");
  });
});

describe("indipendenza dal chiamante", () => {
  test("9. il servizio non sa nulla dell'agent né sceglie il provider", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "lib", "services", "catalog-visual.ts"),
      "utf8"
    );
    const imports = source.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));

    // La factory è ammessa: il servizio chiede "chi genera", non "usa Magnific".
    // Il resto no: l'implementazione concreta è una scelta dell'infrastruttura,
    // e l'agent è un chiamante che non deve essere importato qui.
    for (const forbidden of ["ai/agent", "images/magnific", "tools/content"]) {
      assert.ok(
        !imports.some((l) => l.includes(forbidden)),
        `catalog-visual.ts non deve importare "${forbidden}"`
      );
    }
    assert.ok(
      !/new\s+MagnificProvider|new\s+\w+Provider\(/.test(source),
      "nessuna istanza di provider: si usa la factory"
    );
    assert.ok(
      !/setImageProvider/.test(source),
      "il servizio non configura il provider, lo chiede"
    );
  });

  test("10. il DRAFT resta un DRAFT: nessuna approvazione, nessuna programmazione", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const marker = new Date();
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
    assert.equal(
      (await jobsSince(marker)).length,
      0,
      "il ramo originale non deve registrare job: non ha generato niente"
    );
  });
});

/**
 * Idempotenza: la stessa coppia proposta + immagine non si materializza due
 * volte.
 *
 * L'errore da evitare qui non è solo "una riga in più": è scaricare due volte,
 * tenere due copie dello stesso file su disco e lasciare due DRAFT che l'utente
 * non saprà distinguere. Per questo ogni test guarda tre cose insieme: le
 * righe, i file e il numero di connessioni aperte.
 */
describe("idempotenza sulla stessa proposta e immagine", () => {
  test("11. seconda chiamata identica: nessuna riga, nessun file, nessun download", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.reused, false);
    const afterFirst = await snapshot();
    const filesAfterFirst = await listUploads();
    assert.deepEqual(afterFirst, { content: 1, asset: 1, files: filesAfterFirst.length });

    // Stessa proposta, stessa direzione, stessa copy: la richiesta che l'utente
    // può davvero ripetere.
    const second = await run(dto, direction);

    assert.equal(second.ok, true, "il riuso è un successo, non un errore");
    if (!second.ok) return;
    assert.equal(second.reused, true, "la seconda chiamata deve dichiarare il riuso");
    assert.equal(fetchCalls, 1, "il downloader deve essere entrato in rete una volta sola");
    assert.deepEqual(await snapshot(), afterFirst, "nessuna riga nuova");
    assert.deepEqual(await listUploads(), filesAfterFirst, "nessun file nuovo");
    assert.deepEqual(provider.calls, [], "nessuna chiamata al provider immagini");
  });

  test("12. l'asset riusato è lo stesso contenuto, lo stesso asset, lo stesso file", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = await run(dto, direction);
    assert.equal(second.ok, true);
    if (!second.ok) return;

    assert.equal(second.content.id, first.content.id, "stesso contenuto");
    assert.equal(second.asset.id, first.asset.id, "stesso asset");
    assert.equal(second.asset.url, first.asset.url, "stesso url locale");
    assert.equal(second.asset.filename, first.asset.filename, "nessun secondo file con nome diverso");
    assert.equal(second.asset.contentId, first.content.id);
    assert.equal(second.image, null, "senza download non c'è un file appena scaricato");

    // Il riuso non riscrive: la copia salvata resta quella della prima
    // materializzazione, non quella che il chiamante passa adesso.
    assert.deepEqual(second.metadata, first.metadata);
    assert.deepEqual(second.direction, first.direction);

    const stored = await prisma.content.findUniqueOrThrow({
      where: { id: first.content.id },
      include: { assets: true },
    });
    assert.equal(stored.assets.length, 1, "un solo asset sul contenuto riusato");
  });

  test("13. una seconda immagine della stessa proposta non viene confusa con la prima", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // Stessa proposta, altra immagine: è un visuale diverso e deve poter
    // esistere accanto al primo.
    const otherDto = await loadProposalWithOtherImage();
    const other = await run(otherDto, directionFor(otherDto, format));

    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.reused, false, "l'altra immagine è una nuova materializzazione");
    assert.notEqual(other.content.id, first.content.id);
    assert.notEqual(other.asset.id, first.asset.id);
    assert.notEqual(other.asset.url, first.asset.url);
    assert.equal(fetchCalls, 2, "un download per immagine");
    assert.deepEqual(
      await snapshot(),
      { content: 2, asset: 2, files: (await listUploads()).length },
      "due materializzazioni distinte"
    );

    // E tornare alla prima immagine la riusa ancora, invece di crearne una terza.
    const again = await run(dto, direction);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.reused, true);
    assert.equal(again.asset.id, first.asset.id);
    assert.equal(fetchCalls, 2, "il ritorno alla prima immagine non riscarica");
  });

  test("14. un'altra proposta non eredita l'asset", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);

    const first = await run(dto, directionFor(dto, format));
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const otherDto = await loadProposalById(otherProposalId);
    const other = await run(otherDto, directionFor(otherDto, pickEditorialFormat(otherDto, null).format));

    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.reused, false, "proposta diversa, materializzazione diversa");
    assert.notEqual(other.content.id, first.content.id);
    assert.notEqual(other.asset.id, first.asset.id);
    assert.equal(other.content.id !== first.content.id, true);
    assert.equal(fetchCalls, 2);
  });

  test("15. un asset generico sullo stesso contenuto non viene riusato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);

    // Un contenuto legato a questa proposta, con un'immagine che NON viene dal
    // catalogo (metadata generico da upload utente). Riusarla sarebbe un falso
    // positivo: il visuale non è quello ufficiale.
    const generic = await prisma.content.create({
      data: {
        status: "DRAFT",
        catalogProposalId: proposalId,
        title: "Bozza con immagine caricata a mano",
        assets: {
          create: {
            kind: "IMAGE",
            url: "/uploads/images/immagine-caricata-dallutente.png",
            filename: "immagine-caricata-dallutente.png",
            mimeType: "image/png",
            size: 1234,
            metadata: { uploadedBy: "user" },
          },
        },
      },
      include: { assets: true },
    });
    contentIds.push(generic.id);
    for (const a of generic.assets) assetIds.push(a.id);

    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reused, false, "un asset non di catalogo non è la stessa materializzazione");
    assert.notEqual(result.asset.id, generic.assets[0].id);
    assert.equal(result.asset.url.startsWith("/uploads/images/"), true);
    assert.notEqual(result.asset.filename, "immagine-caricata-dallutente.png");

    // E l'asset generico resta intatto: il servizio non si è portato via
    // immagini che non gli appartengono.
    const untouched = await prisma.contentAsset.findUniqueOrThrow({
      where: { id: generic.assets[0].id },
    });
    assert.equal(untouched.contentId, generic.id);
  });

  test("16. il rollback non lascia tracce che blocchino la ripartenza", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    // Prima materializzazione: transazione destinata a fallire.
    const failed = await run(await loadOrphanProposal(), direction);
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.reason, "persist_failed");
    assert.equal(fetchCalls, 1, "il download era avvenuto");

    // Seconda materializzazione, stessa proposta valida: deve ripartire
    // normalmente, perché il fallimento non ha lasciato nulla da riusare.
    const retry = await run(dto, direction);

    assert.equal(retry.ok, true, "dopo un rollback la materializzazione deve poter ripartire");
    if (!retry.ok) return;
    assert.equal(retry.reused, false, "il rollback non ha lasciato una materializzazione da riusare");
    assert.equal(fetchCalls, 2, "il tentativo fallito non blocca il download successivo");
    assert.deepEqual(await snapshot(), { content: 1, asset: 1, files: (await listUploads()).length });
  });

  test("17. un asset con metadata non riconoscibile non viene riusato", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);

    // Metadata che non è quello del catalogo: lo stesso schema, un altro
    // produttore. Riusarlo mostrerebbe all'utente un'immagine non ufficiale
    // come se fosse l'originale del catalogo. Nota che l'origine dichiarata è
    // quella del ramo generato: il ramo originale non la confonde con la sua,
    // e il ramo generato (test 29) non la riusa perché le manca il prompt.
    const impostor = await prisma.content.create({
      data: {
        status: "DRAFT",
        catalogProposalId: proposalId,
        title: "Bozza con visuale generato",
        assets: {
          create: {
            kind: "IMAGE",
            url: "/uploads/images/magnific-1755000000000.png",
            filename: "magnific-1755000000000.png",
            mimeType: "image/png",
            size: 4321,
            metadata: { origin: "magnific", provider: "magnific", catalogProposalId: proposalId },
          },
        },
      },
      include: { assets: true },
    });
    contentIds.push(impostor.id);
    for (const a of impostor.assets) assetIds.push(a.id);

    const result = await run(dto, directionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reused, false, "solo gli asset di origine catalogo-official si riusano");
    assert.notEqual(result.asset.id, impostor.assets[0].id);
  });

  test("18. il riuso non tocca il database in scrittura", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const before = await prisma.content.findUniqueOrThrow({
      where: { id: first.content.id },
      include: { assets: true, platforms: true },
    });

    const second = await run(dto, direction);
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const after = await prisma.content.findUniqueOrThrow({
      where: { id: first.content.id },
      include: { assets: true, platforms: true },
    });
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "nessuna riscrittura");
    assert.deepEqual(after.assets, before.assets, "l'asset non è stato toccato");
    assert.deepEqual(
      after.platforms.map((p) => p.platform).sort(),
      before.platforms.map((p) => p.platform).sort(),
      "le piattaforme del primo materializzazione sono intatte"
    );
  });

  test("19. il riuso non registra un secondo audit di creazione", async () => {
    const dto = await loadProposal();
    const { format } = pickEditorialFormat(dto, null);
    const direction = directionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const marker = new Date();
    const firstAsset = first.asset.id;

    const second = await run(dto, direction);
    assert.equal(second.ok, true);
    if (!second.ok) return;

    // Solo ciò che è nato dopo il marker: le righe della prima materializzazione
    // appartengono a un'altra esecuzione del test e non sono un duplicato.
    const replayed = await prisma.auditLog.count({
      where: {
        createdAt: { gte: marker },
        OR: [
          { action: "CONTENT_CREATED", entityId: first.content.id },
          { action: "ASSET_CREATED", entityId: firstAsset },
        ],
      },
    });
    assert.equal(replayed, 0, "un riuso non è una creazione e non va in audit come se lo fosse");

    const audits = await prisma.auditLog.count({
      where: {
        OR: [
          { action: "CONTENT_CREATED", entityId: first.content.id },
          { action: "ASSET_CREATED", entityId: firstAsset },
        ],
      },
    });
    assert.equal(audits, 2, "una sola CONTENT_CREATED e una sola ASSET_CREATED in assoluto");
  });
});

/**
 * Il ramo generato: cosa succede quando il catalogo non ha un originale.
 *
 * Le proprietà osservate sono le stesse del ramo ufficiale, e contano per le
 * stesse ragioni: il file a terra prima del DRAFT, la transazione unica, la
 * ripulitura in caso di fallimento, il riuso senza rigenerare. In più qui il
 * denaro è speso a ogni generazione, quindi ogni chiamata inutile al provider
 * è un costo reale, non solo tempo.
 */
describe("generazione del visuale senza originale", () => {
  test("20. al provider va il prompt della direzione, con i suoi parametri", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    const direction = generationDirectionFor(dto, format);

    const result = await run(dto, direction);
    assert.equal(result.ok, true);

    assert.equal(provider.calls.length, 1, "una sola generazione");
    const call = provider.calls[0];
    assert.equal(call.prompt, visualPromptFromDirection(direction), "il prompt non è ricostruito");
    assert.ok(
      call.prompt.length <= MAX_VISUAL_PROMPT_LENGTH,
      `prompt troppo lungo: ${call.prompt.length}`
    );
    assert.match(call.prompt, /Offerta Reale Repubblica/, "la proposta reale è il soggetto");
    assert.match(call.prompt, /Repubblica/, "la destinazione reale è il luogo");
    for (const forbidden of ["890", "1290", "EUR", "€"]) {
      assert.ok(!call.prompt.includes(forbidden), `il prompt non può contenere "${forbidden}"`);
    }
    assert.deepEqual(call.options, { aspectRatio: "square_1_1", resolution: "1k" });
  });

  test("21. seconda chiamata identica: nessuna generazione, nessuna riga, nessun file", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    const direction = generationDirectionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.reused, false);
    const filesAfterFirst = await listUploads();
    const afterFirst = await snapshot();
    assert.equal(provider.calls.length, 1);
    const marker = new Date();
    const jobsAfterFirst = (await jobsSince(marker)).length;

    const second = await run(dto, direction);

    assert.equal(second.ok, true, "il riuso è un successo, non un errore");
    if (!second.ok) return;
    assert.equal(second.reused, true);
    assert.equal(second.origin, CATALOG_GENERATED_ORIGIN);
    assert.equal(second.content.id, first.content.id);
    assert.equal(second.asset.id, first.asset.id);
    assert.equal(second.asset.url, first.asset.url);
    assert.equal(second.image, null, "senza generazione non c'è un file appena prodotto");
    assert.deepEqual(second.metadata, first.metadata);
    assert.equal(provider.calls.length, 1, "la seconda richiesta non paga una seconda generazione");
    assert.deepEqual(await snapshot(), afterFirst, "nessuna riga nuova");
    assert.deepEqual(await listUploads(), filesAfterFirst, "nessun file nuovo");
    assert.equal(
      (await jobsSince(marker)).length,
      jobsAfterFirst,
      "il riuso non registra un secondo job"
    );
  });

  test("22. una direzione diversa è un visuale diverso, quindi una nuova generazione", async () => {
    const dto = await loadProposalWithoutImage();
    const first = generationDirectionFor(dto, "HERO_DESTINATION");
    const second = generationDirectionFor(dto, "STORYTELLING");
    assert.notEqual(
      visualPromptFromDirection(first),
      visualPromptFromDirection(second),
      "i due formati producono prompt diversi: è ciò che rende Diverse le richieste"
    );

    const a = await run(dto, first);
    const b = await run(dto, second);

    assert.equal(a.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(b.ok, true);
    assert.equal(b.reused, false, "prompt diverso, materializzazione diversa");
    assert.notEqual(b.content.id, a.content.id);
    assert.notEqual(b.asset.url, a.asset.url);
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(await snapshot(), {
      content: 2,
      asset: 2,
      files: (await listUploads()).length,
    });
  });

  test("23. provider che non sa generare: nulla creato, nessun job", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    provider.canGenerate = false;

    const before = await listUploads();
    const marker = new Date();
    const result = await run(dto, generationDirectionFor(dto, format));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "generation_unavailable");
    assert.equal(result.needsGeneration, true);
    assert.match(result.detail ?? "", /^provider:/);
    assert.match(result.message, /non sa generare/);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
    assert.deepEqual(provider.calls, [], "un provider che non genera non va nemmeno interrogato");
    assert.equal(
      (await jobsSince(marker)).length,
      0,
      "nessun job: la generazione non è mai partita"
    );
  });

  test("24. generazione fallita: job FAILED, nulla a terra", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    provider.behaviour = "fail";

    const before = await listUploads();
    const marker = new Date();
    const result = await run(dto, generationDirectionFor(dto, format));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "generation_failed");
    assert.equal(result.needsGeneration, true);
    assert.match(result.message, /Generazione del visuale fallita/);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before, "nessun file: il provider non ne ha prodotti");

    const jobs = await jobsSince(marker);
    assert.equal(jobs.length, 1, "una generazione tentata, un job");
    assert.equal(jobs[0].status, "FAILED", "un job di una generazione fallita non resta PENDING");
    assert.match(String(jobs[0].error), /Magnific ha risposto 500/);
  });

  test("25. il provider dichiara un file che non esiste: il DRAFT non nasce", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    provider.behaviour = "no-file";

    const before = await listUploads();
    const marker = new Date();
    const result = await run(dto, generationDirectionFor(dto, format));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "generation_failed");
    assert.equal(result.detail, "file_missing");
    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), before);
    const jobs = await jobsSince(marker);
    assert.equal(jobs[0].status, "FAILED");
  });

  test("26. transazione fallita: il file generato viene ripulito e il job chiuso", async () => {
    // Stesso trucco del ramo ufficiale: la proposta non esiste, quindi è il
    // vincolo di chiave esterna a far fallire la transazione davvero.
    const dto: CatalogProposalDto = { ...(await loadOrphanProposal()), officialImage: null };
    const { format } = pickEditorialFormat(dto, null);

    const before = await listUploads();
    const marker = new Date();
    const result = await run(dto, generationDirectionFor(dto, format));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "persist_failed");
    assert.equal(result.detail, "file_removed", "il file generato deve essere eliminato");
    assert.deepEqual(await listUploads(), before, "nessun file residuo");
    assert.deepEqual(
      await countsSince(marker),
      { content: 0, asset: 0 },
      "il rollback annulla contenuto e asset"
    );

    const jobs = await jobsSince(marker);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "FAILED", "il file è sparito: il job non può risultare riuscito");
    assert.match(String(jobs[0].error), /Salvataggio non riuscito/);
  });

  test("27. originale e generato non si confondono, in nessuna delle due direzioni", async () => {
    const withImage = await loadProposal();
    const { format } = pickEditorialFormat(withImage, null);
    const noImage = await loadProposalWithoutImage();

    const official = await run(withImage, directionFor(withImage, format));
    const generated = await run(noImage, generationDirectionFor(noImage, format));

    assert.equal(official.ok, true);
    if (!official.ok || !generated.ok) return;
    assert.equal(generated.ok, true);
    assert.equal(official.origin, "catalog-official");
    assert.equal(generated.origin, CATALOG_GENERATED_ORIGIN);
    assert.notEqual(generated.content.id, official.content.id);
    assert.notEqual(generated.asset.id, official.asset.id);
    assert.equal(fetchCalls, 1, "solo il ramo ufficiale ha scaricato qualcosa");
    assert.equal(provider.calls.length, 1, "solo il ramo generato ha generato qualcosa");

    // E tornare a chiedere l'originale non riusa il generato, né viceversa:
    // sono due visuali distinti, non due copie dello stesso.
    const officialAgain = await run(withImage, directionFor(withImage, format));
    const generatedAgain = await run(noImage, generationDirectionFor(noImage, format));
    assert.equal(officialAgain.ok && officialAgain.reused, true);
    assert.equal(generatedAgain.ok && generatedAgain.reused, true);
    assert.equal(fetchCalls, 1, "il ritorno all'originale non riscarica");
    assert.equal(provider.calls.length, 1, "il ritorno al generato non rigenera");
  });

  test("28. un asset di origine generata senza prompt non viene riusato", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);

    // Un asset che dichiara l'origine giusta ma non sa dire cosa è stato
    // generato: senza prompt non c'è la prova che sia la stessa richiesta, e
    // riusarlo mostrerebbe all'utente un'immagine che non ha chiesto.
    const impostor = await prisma.content.create({
      data: {
        status: "DRAFT",
        catalogProposalId: proposalId,
        title: "Bozza con visuale generato da un altro prompt",
        assets: {
          create: {
            kind: "IMAGE",
            url: "/uploads/images/immagine-di-altro-prompt.png",
            filename: "immagine-di-altro-prompt.png",
            mimeType: "image/png",
            size: 4321,
            metadata: {
              origin: "magnific",
              provider: "magnific",
              catalogProposalId: proposalId,
              catalogImageId: null,
              editorialFormat: "HERO_DESTINATION",
              visualDirection: { format: "HERO_DESTINATION" },
            },
          },
        },
      },
      include: { assets: true },
    });
    contentIds.push(impostor.id);
    for (const a of impostor.assets) assetIds.push(a.id);

    const result = await run(dto, generationDirectionFor(dto, format));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reused, false, "senza prompt l'asset non è la stessa materializzazione");
    assert.notEqual(result.asset.id, impostor.assets[0].id);
    assert.equal(provider.calls.length, 1, "è stato generato davvero il visuale richiesto");
  });

  test("29. il riuso generato non registra un secondo audit di creazione", async () => {
    const dto = await loadProposalWithoutImage();
    const { format } = pickEditorialFormat(dto, null);
    const direction = generationDirectionFor(dto, format);

    const first = await run(dto, direction);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const marker = new Date();
    const second = await run(dto, direction);
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const replayed = await prisma.auditLog.count({
      where: {
        createdAt: { gte: marker },
        OR: [
          { action: "CONTENT_CREATED", entityId: first.content.id },
          { action: "ASSET_CREATED", entityId: first.asset.id },
        ],
      },
    });
    assert.equal(replayed, 0, "un riuso non è una creazione");

    const audits = await prisma.auditLog.findMany({
      where: {
        OR: [
          { action: "CONTENT_CREATED", entityId: first.content.id },
          { action: "ASSET_CREATED", entityId: first.asset.id },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(audits.length, 2);
    const creation = audits.find((a) => a.action === "CONTENT_CREATED")!;
    const assetLog = audits.find((a) => a.action === "ASSET_CREATED")!;
    assert.equal(
      (creation.detail as { visualOrigin?: string } | null)?.visualOrigin,
      CATALOG_GENERATED_ORIGIN,
      "l'audit deve dire che il visuale è generato, non ufficiale"
    );
    assert.equal((assetLog.detail as { origin?: string } | null)?.origin, CATALOG_GENERATED_ORIGIN);
  });
});
