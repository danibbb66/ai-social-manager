/**
 * Flusso completo: `createContent({fromCatalog:true})` → visuale a terra.
 *
 * `catalog-visual-flow.test.ts` dimostra che il servizio visuale funziona.
 * Questa suite dimostra che il tool gli affida davvero il lavoro: nessun DRAFT
 * senza immagine, un solo DRAFT per richiesta, originale del catalogo quando
 * esiste, generazione solo quando non esiste, e ogni errore dichiarato al
 * modello senza lasciare content, asset o file a metà.
 *
 * La rete è sostituita da uno stub di `fetch` e il provider immagini è un
 * finto che registra le chiamate e scrive file veri sotto `public/uploads`:
 * nessuna richiesta esce davvero e i test possono comunque provare che il file
 * esiste a terra.
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
  type CatalogVisualMetadata,
  type CatalogGeneratedVisualMetadata,
  type AnyCatalogVisualMetadata,
} from "../src/lib/services/catalog-visual";
import { setImageProvider } from "../src/lib/images/factory";
import { deleteUploadedFile, saveUploadedFile } from "../src/lib/uploads";
import { getTool } from "../src/lib/ai/tools/registry";
import {
  buildVisualDirection,
  pickEditorialFormat,
  visualPromptFromDirection,
} from "../src/lib/ai/catalog-content";
import { toCatalogProposalDto, type CatalogProposalDto } from "../src/lib/services/catalog-ai";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

/**
 * Dominio proprio di questa suite: le immagini ufficiali devono stare
 * nell'allowlist del downloader, che è il dominio della fonte in database.
 */
const SOURCE_DOMAIN = "catalogo-tool-flow.test";
const OFFICIAL_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/06/REPUBBLICA-5-NOTTI.webp`;
const OFFICIAL_NAME = "REPUBBLICA-5-NOTTI.webp";
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

/** Proposta con immagine ufficiale: il ramo in cui non si deve generare nulla. */
const WITH_IMAGE_NAME = "Offerta Reale Repubblica";
const WITH_IMAGE_DESTINATION = "Repubblica";
/** Proposta senza immagine: il ramo in cui la generazione è l'unica strada. */
const NO_IMAGE_NAME = "Offerta Reale Grecia";
const NO_IMAGE_DESTINATION = "Grecia";

const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0, 0, 0, 0]),
]);

const originalFetch = globalThis.fetch;
const sourceIds: string[] = [];
const contentIds: string[] = [];
const assetIds: string[] = [];
const savedUrls: string[] = [];
/** File scritti dal provider finto: vanno ripuliti come quelli scaricati. */
const generatedFiles: string[] = [];

let baselineFiles: string[] = [];
/** I job AI di questa suite si ripuliscono per identità, non per data di nascita. */
const jobOwnership = createJobOwnership(["IMAGE"]);
let withImageId = "";
let noImageId = "";
let provider: SpyImageProvider;

type ToolResponse = { ok: boolean; message: string; data?: Record<string, unknown> };

type FetchBehaviour = "ok" | "http_error" | "delete_proposal";

/**
 * Provider finto che registra ogni generazione.
 *
 * Nel ramo ufficiale non deve mai essere chiamato: i test che lo affermano
 * falliscono se una chiamata arriva. Nel ramo generato è l'unico modo per
 * avere un file a terra senza uscire in rete, quindi qui scrive davvero un
 * file e restituisce le sue coordinate.
 */
class SpyImageProvider implements ImageProvider {
  readonly name = "magnific";
  canGenerate = true;
  behaviour: "ok" | "fail" = "ok";
  calls: { prompt: string; options?: GenerateImageOptions }[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push({ prompt, options });
    if (this.behaviour === "fail") {
      throw new Error("Magnific ha risposto 500");
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

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Volte in cui il downloader è entrato in rete davvero. */
let fetchCalls = 0;

/**
 * Stub del downloader.
 *
 * `"delete_proposal"` cancella la proposta indicata dal database *durante* il
 * download: quando il servizio proverà a scrivere il DRAFT, il vincolo di chiave
 * esterna farà fallire la transazione davvero. È il modo di provare il rollback
 * senza un aggancio solo-per-test nel codice di produzione.
 */
function stubFetch(behaviour: FetchBehaviour = "ok", status = 200, deleteTargetId = withImageId): void {
  (globalThis as { fetch: FetchStub }).fetch = async () => {
    fetchCalls += 1;
    if (behaviour === "delete_proposal") {
      await prisma.catalogProposal.deleteMany({ where: { id: deleteTargetId } });
    }
    if (behaviour === "http_error") {
      return new Response("non trovato", { status, headers: { "Content-Type": "text/plain" } });
    }
    return new Response(new Uint8Array(WEBP), {
      status,
      headers: { "Content-Type": "image/webp" },
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

/** Ripulisce ciò che i test producono, lasciando in piedi le proposte del fixture. */
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
    // I job AI del ramo generato restano anche quando il test non ha
    // registrato l'id: sono di questa suite e si riconoscono per identità,
    // non per data. Prima dei contenuti, che azzererebbero il loro `contentId`.
    await jobOwnership.deleteOwned(contentIds);
    for (const id of contentIds.splice(0)) {
      await prisma.content.deleteMany({ where: { id } });
    }
  const now = await listUploads();
  for (const f of now.filter((f) => !baselineFiles.includes(f))) {
    await fs.unlink(f).catch(() => undefined);
  }
  await fs.rmdir(path.join(UPLOADS_ROOT, "images")).catch(() => undefined);
}

async function cleanupAll() {
  await cleanupGenerated();
  for (const id of sourceIds.splice(0)) {
    await prisma.catalogSource.deleteMany({ where: { id } });
  }
}

/** Quante righe sono nate da un certo momento: serve a dire "non è stato creato nulla". */
async function countsSince(marker: Date) {
  return {
    content: await prisma.content.count({ where: { createdAt: { gte: marker } } }),
    asset: await prisma.contentAsset.count({ where: { createdAt: { gte: marker } } }),
  };
}

async function loadProposal(id: string): Promise<CatalogProposalDto> {
  const row = await prisma.catalogProposal.findUniqueOrThrow({
    where: { id },
    include: {
      images: { orderBy: { acquiredAt: "asc" } },
      source: true,
      contents: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
  });
  return toCatalogProposalDto(row as never);
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

  const withImage = await prisma.catalogProposal.create({
    data: {
      name: WITH_IMAGE_NAME,
      destination: WITH_IMAGE_DESTINATION,
      sourceId: source.id,
      sourceUrl: `https://${SOURCE_DOMAIN}/offerte/#repubblica`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-tool-flow-repubblica",
      sourceOrder: 1,
      periodStart: new Date("2026-12-20T00:00:00Z"),
      periodEnd: new Date("2026-12-25T00:00:00Z"),
      durationNights: 5,
      priceFrom: 890,
      priceTo: 1290,
      currency: "EUR",
      included: "volo e hotel",
      images: {
        create: { url: OFFICIAL_URL, filename: OFFICIAL_NAME, acquiredAt: new Date("2026-06-01T00:00:00Z") },
      },
    },
  });
  withImageId = withImage.id;

  // Nessuna immagine in catalogo: è l'unico modo legittimo in cui la
  // generazione entra, e la suite deve dimostrare che entra.
  const noImage = await prisma.catalogProposal.create({
    data: {
      name: NO_IMAGE_NAME,
      destination: NO_IMAGE_DESTINATION,
      sourceId: source.id,
      sourceUrl: `https://${SOURCE_DOMAIN}/offerte/#grecia`,
      sourceType: "FLYER",
      extraction: "HTML",
      confidence: "UNVERIFIED",
      contentHash: "hash-tool-flow-grecia",
      sourceOrder: 2,
    },
  });
  noImageId = noImage.id;
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
  stubFetch();
});

/** Chiama il tool dal registro e registra ciò che va ripulito. */
async function createContentTool(args: Record<string, unknown>): Promise<ToolResponse> {
  const tool = getTool("createContent");
  assert.ok(tool, "createContent deve esistere");
  const result = (await tool.execute(args)) as ToolResponse;
  const data = result.data ?? {};
  if (data.id) contentIds.push(String(data.id));
  if (data.assetId) {
    const id = String(data.assetId);
    assetIds.push(id);
    const asset = await prisma.contentAsset.findUnique({ where: { id } });
    if (asset && !savedUrls.includes(asset.url)) savedUrls.push(asset.url);
  }
  return result;
}

/** Contenuto con i suoi asset, per guardare la verità sul database. */
async function storedWithAssets(id: string) {
  return prisma.content.findUniqueOrThrow({
    where: { id },
    include: { assets: true, platforms: true, approvals: true },
  });
}

describe("createContent con Catalogo: il visuale parte con il DRAFT", () => {
  test("1. con immagine ufficiale nasce un DRAFT con l'originale, senza generare nulla", async () => {
    const marker = new Date();

    const result = await createContentTool({
      catalogProposalId: withImageId,
      type: "POST",
      platforms: ["INSTAGRAM", "FACEBOOK"],
    });

    assert.equal(result.ok, true, result.message);
    const data = result.data!;

    // Il minimo che il modello deve poter leggere per rispondere all'utente.
    assert.equal(typeof data.id, "string");
    assert.equal(data.status, "DRAFT");
    assert.equal(typeof data.title, "string");
    assert.equal(typeof data.editorialFormat, "string");
    assert.equal(data.visualOrigin, CATALOG_VISUAL_ORIGIN);
    assert.equal(data.visualOrigin, "catalog-official");
    assert.equal(data.visualReused, false);
    assert.equal(data.withMedia, true);
    assert.equal(typeof data.assetId, "string");
    assert.equal(data.catalogProposalId, withImageId);
    assert.match(result.message, /immagine ufficiale del catalogo/);

    // Un solo DRAFT, un solo asset: la stessa richiesta non si sdoppia.
    assert.deepEqual(await countsSince(marker), { content: 1, asset: 1 });

    const stored = await storedWithAssets(String(data.id));
    assert.equal(stored.catalogProposalId, withImageId);
    assert.equal(stored.approvals.length, 0, "nessuna approvazione su un DRAFT");
    assert.equal(stored.assets.length, 1, "il DRAFT non può esistere senza visuale");
    assert.equal(stored.assets[0].id, data.assetId);
    assert.equal(stored.assets[0].kind, "IMAGE");
    assert.deepEqual(
      stored.platforms.map((p) => p.platform).sort(),
      ["FACEBOOK", "INSTAGRAM"]
    );

    // Il file a terra è l'originale del catalogo, non un'immagine prodotta qui.
    const meta = stored.assets[0].metadata as unknown as CatalogVisualMetadata;
    assert.equal(meta.origin, CATALOG_VISUAL_ORIGIN);
    assert.equal(meta.provider, "catalog");
    assert.equal(meta.sourceUrl, OFFICIAL_URL);
    assert.equal(meta.catalogProposalId, withImageId);
    const absolute = path.join(process.cwd(), "public", stored.assets[0].url.replace(/^\//, ""));
    assert.equal(absolute.startsWith(UPLOADS_ROOT + path.sep), true);
    assert.deepEqual(await fs.readFile(absolute), WEBP, "il file è l'immagine ufficiale scaricata");

    // Con l'originale non si genera: il provider non deve nemmeno essere stato interrogato.
    assert.equal(provider.calls.length, 0, "l'originale non si sostituisce con una generazione");
    assert.equal(fetchCalls, 1, "una sola richiesta di rete, per il download");
    assert.equal(
      await prisma.aIJob.count({ where: { createdAt: { gte: marker } } }),
      0,
      "il ramo ufficiale non consuma crediti di generazione"
    );
  });

  test("2. senza immagine in catalogo la generazione parte una volta sola, con il prompt della direzione", async () => {
    const marker = new Date();

    const result = await createContentTool({
      catalogProposalId: noImageId,
      type: "POST",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(result.ok, true, result.message);
    const data = result.data!;
    assert.equal(data.visualOrigin, CATALOG_GENERATED_ORIGIN);
    assert.equal(data.visualOrigin, "magnific");
    assert.equal(data.visualReused, false);
    assert.equal(data.withMedia, true);
    assert.deepEqual(await countsSince(marker), { content: 1, asset: 1 });
    assert.equal(fetchCalls, 0, "senza originale in catalogo non si scarica nulla");

    // Una e una sola generazione, con il prompt che deriva dalla direzione.
    assert.equal(provider.calls.length, 1, "una sola generazione per il DRAFT");
    const dto = await loadProposal(noImageId);
    const { format } = pickEditorialFormat(dto, undefined);
    const direction = buildVisualDirection(dto, format);
    assert.equal(direction.needsGeneration, true, "senza originale la generazione è prevista");
    assert.equal(provider.calls[0].prompt, visualPromptFromDirection(direction));

    // Il prompt non inventa dati commerciali né destinazioni.
    const prompt = provider.calls[0].prompt;
    assert.doesNotMatch(prompt, /(€|euro|prezzo|890|1290)/i, `prompt: ${prompt}`);
    assert.doesNotMatch(prompt, new RegExp(WITH_IMAGE_DESTINATION, "i"), "nessun'altra destinazione");
    assert.match(prompt, new RegExp(NO_IMAGE_DESTINATION, "i"), "la destinazione è quella della proposta");

    // Il metadata del asset dichiara la provenienza generata.
    const stored = await storedWithAssets(String(data.id));
    assert.equal(stored.assets.length, 1);
    const meta = stored.assets[0].metadata as unknown as CatalogGeneratedVisualMetadata;
    assert.equal(meta.origin, CATALOG_GENERATED_ORIGIN);
    assert.equal(meta.provider, "magnific");
    assert.equal(meta.catalogProposalId, noImageId);
    assert.equal(meta.prompt, provider.calls[0].prompt, "il prompt resta tracciato con l'asset");
    assert.ok(
      await prisma.aIJob.count({ where: { createdAt: { gte: marker } } }) > 0,
      "una generazione consuma un job: deve restare traccia del costo"
    );
  });

  test("3. download fallito: nessun DRAFT e nessun fallback su immagine generata", async () => {
    stubFetch("http_error", 404);
    const marker = new Date();

    const result = await createContentTool({
      catalogProposalId: withImageId,
      type: "POST",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(result.ok, false, "un originale non scaricabile non è un DRAFT riuscito");
    const data = result.data!;
    assert.equal(data.catalogFailure, "download_failed");
    assert.equal(data.createdContentId, null);
    assert.equal(data.assetId, null);
    assert.equal(data.needsGeneration, false, "sostituire l'originale non è una strada");
    assert.equal(data.catalogProposalId, withImageId);
    assert.match(result.message, /Nessun contenuto creato/);
    assert.match(result.message, /non sostituire/i);

    // Nulla è nato, né a metà: questo è il punto dell'intero flusso.
    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.equal(provider.calls.length, 0, "mai generare al posto di un originale scaricabile");
    assert.deepEqual(await listUploads(), baselineFiles, "nessun file lasciato a terra");
  });

  test("4. la stessa proposta due volte riusa il visuale: un solo DRAFT, un solo asset", async () => {
    const marker = new Date();

    const first = await createContentTool({
      catalogProposalId: withImageId,
      type: "POST",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.data!.visualReused, false, "la prima volta crea");

    const second = await createContentTool({
      catalogProposalId: withImageId,
      type: "POST",
      platforms: ["FACEBOOK"],
    });
    assert.equal(second.ok, true, second.message);
    assert.equal(second.data!.visualReused, true, "la seconda volta riusa");
    assert.match(second.message, /riutilizzato/);

    assert.equal(second.data!.id, first.data!.id, "è lo stesso contenuto");
    assert.equal(second.data!.assetId, first.data!.assetId, "è lo stesso visuale");
    assert.equal(first.data!.visualOrigin, second.data!.visualOrigin);

    // Il riuso non è una seconda materializzazione: niente nuova rete, niente
    // nuovo asset, niente nuovo lavoro pagato.
    assert.deepEqual(await countsSince(marker), { content: 1, asset: 1 });
    assert.equal(fetchCalls, 1, "il file esiste già: non si riscarica");
    assert.equal(provider.calls.length, 0);
  });

  test("5a. se la transazione fallisce non resta un DRAFT senza visuale", async () => {
    // Proposta a perdere: il rollback viene provato cancellandola, quindi
    // non può essere una di quelle che i test successivi devono trovare.
    const doomed = await prisma.catalogProposal.create({
      data: {
        name: "Offerta Reale Orio",
        destination: "Orio",
        sourceId: sourceIds[0],
        sourceUrl: `https://${SOURCE_DOMAIN}/offerte/#orio`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "UNVERIFIED",
        contentHash: "hash-tool-flow-orio",
        sourceOrder: 3,
        images: {
          create: {
            url: `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/07/ORIO-2-NOTTI.webp`,
            filename: "ORIO-2-NOTTI.webp",
            acquiredAt: new Date("2026-07-01T00:00:00Z"),
          },
        },
      },
    });
    stubFetch("delete_proposal", 200, doomed.id);
    const marker = new Date();

    const result = await createContentTool({
      catalogProposalId: doomed.id,
      type: "POST",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(result.ok, false, "una transazione fallita non può dichiarare successo");
    assert.equal(result.data!.catalogFailure, "persist_failed");
    assert.equal(result.data!.createdContentId, null);
    assert.equal(result.data!.assetId, null);
    assert.equal(result.data!.catalogProposalId, doomed.id);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), baselineFiles, "il file scaricato va rimosso");
    assert.equal(provider.calls.length, 0);
  });

  test("5b. se la generazione fallisce non resta un DRAFT a metà", async () => {
    provider.behaviour = "fail";
    const marker = new Date();

    const result = await createContentTool({
      catalogProposalId: noImageId,
      type: "POST",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(result.ok, false, "una generazione fallita non è un DRAFT riuscito");
    assert.equal(result.data!.catalogFailure, "generation_failed");
    assert.equal(result.data!.createdContentId, null);
    assert.equal(result.data!.assetId, null);
    assert.equal(result.data!.needsGeneration, true);

    assert.deepEqual(await countsSince(marker), { content: 0, asset: 0 });
    assert.deepEqual(await listUploads(), baselineFiles, "nessun file orfano");
  });

  test("6. senza catalogo il ramo legacy resta com'era: nessuna rete, nessun visuale", async () => {
    const marker = new Date();

    const result = await createContentTool({
      topic: "Offerta autunno in Val d'Orcia",
      type: "POST",
      title: "Autunno in Val d'Orcia",
      caption: "Un fine settimana tra le colline della Toscana.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(result.ok, true, result.message);
    const stored = await storedWithAssets(String(result.data!.id));
    assert.equal(stored.status, "DRAFT");
    assert.equal(stored.catalogProposalId, null, "senza catalogo nessun collegamento");
    assert.equal(stored.assets.length, 0, "il ramo legacy non materializza nulla");
    assert.equal(fetchCalls, 0, "senza catalogo non si scarica nulla");
    assert.equal(provider.calls.length, 0, "senza catalogo non si genera nulla");
    assert.deepEqual(await countsSince(marker), { content: 1, asset: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * 7 + 8. le invarianti che devono valere per ogni richiesta
 * ------------------------------------------------------------------ */

test("7. due richieste sullo stesso turno non producono due DRAFT", async () => {
  const marker = new Date();

  const first = await createContentTool({
    catalogProposalId: noImageId,
    type: "POST",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(first.ok, true, first.message);
  const second = await createContentTool({
    catalogProposalId: noImageId,
    type: "POST",
    platforms: ["FACEBOOK"],
  });
  assert.equal(second.ok, true, second.message);

  assert.deepEqual(await countsSince(marker), { content: 1, asset: 1 });
  assert.equal(second.data!.id, first.data!.id);
  assert.equal(second.data!.visualReused, true);
  assert.equal(provider.calls.length, 1, "una sola generazione per entrambe le richieste");
});

test("8. ogni contenuto di catalogo ha esattamente un visuale, mai due e mai zero", async () => {
  // Il test materializza da sé: l'invariante vale su ciò che nasce ora, non su
  // ciò che è rimasto dai test precedenti.
  const official = await createContentTool({
    catalogProposalId: withImageId,
    type: "POST",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(official.ok, true, official.message);
  const generated = await createContentTool({
    catalogProposalId: noImageId,
    type: "POST",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(generated.ok, true, generated.message);

  const rows = await prisma.content.findMany({
    where: { catalogProposalId: { in: [withImageId, noImageId] } },
    include: { assets: true },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(rows.length, 2, "una richiesta per proposta");
  for (const row of rows) {
    assert.equal(row.status, "DRAFT");
    assert.equal(row.assets.length, 1, `il contenuto ${row.id} ha ${row.assets.length} visuali invece di 1`);
    const meta = row.assets[0].metadata as unknown as AnyCatalogVisualMetadata;
    assert.ok(
      meta.origin === CATALOG_VISUAL_ORIGIN || meta.origin === CATALOG_GENERATED_ORIGIN,
      "ogni visuale dichiara da dove viene"
    );
    assert.equal(typeof row.assets[0].url, "string", "il visuale è un file, non una promessa");
  }

  // E i due rami non si confondono: l'originale resta l'originale.
  const origins = rows.map((r) => (r.assets[0].metadata as unknown as AnyCatalogVisualMetadata).origin);
  assert.deepEqual(
    origins.sort(),
    [CATALOG_GENERATED_ORIGIN, CATALOG_VISUAL_ORIGIN].sort(),
    "una proposta con originale e una senza producono visuali dichiarati diversamente"
  );
  assert.equal(fetchCalls, 1, "solo l'originale è stato scaricato");
  assert.equal(provider.calls.length, 1, "solo la proposta senza originale ha generato");
});
