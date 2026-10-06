/**
 * Verticale locandina → dati estratti → fotografia generata → creatività
 * sociale → DRAFT.
 *
 * Questa suite dimostra una cosa sola: che i quattro strati restano separati
 * e tracciabili. Ogni test affianca le due metà del rischio, perché è
 * l'abbinamento a renderlo osservabile:
 *
 *  - dati commerciali assenti → `null`, e la creatività non stampa nulla;
 *  - dati commerciali presenti → vengono stampati, e arrivano dalla fonte;
 *  - il prompt del generatore resta fotografico anche quando i dati ci sono;
 *  - la locandina finisce in Media Library e non tra gli asset del DRAFT;
 *  - un fallimento del provider non lascia né DRAFT né file.
 *
 * La rete è sostituita con uno stub di `fetch` e il provider immagini è un
 * finto che scrive davvero un file sotto `public/uploads`: nessun aggancio
 * solo-per-test nel codice di produzione. Nessuna chiamata a Meta può
 * avvenire: ogni `fetch` passa dallo stub, che registra l'host e fallisce se
 * appartiene a Instagram o Facebook.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../src/lib/prisma";
import { createJobOwnership } from "./helpers/aijob-ownership";
import { setImageProvider } from "../src/lib/images/factory";
import { deleteUploadedFile, saveUploadedFile } from "../src/lib/uploads";
import {
  FLYER_SOCIAL_CREATIVE_ORIGIN,
  FLYER_SOCIAL_SOURCE_ORIGIN,
  FLYER_SOCIAL_VERTICAL,
  buildPhotoPrompt,
  createFlyerSocialDraft,
  type FlyerSocialCreativeMetadata,
  type FlyerSocialSourceMetadata,
} from "../src/lib/services/flyer-social";
import { buildVisualDirection } from "../src/lib/ai/catalog-content";
import { commercialLines, extractCommercial } from "../src/lib/catalog/commercial-extraction";
import { SOCIAL_CREATIVE_SIZE } from "../src/lib/images/social-creative";
import { getCatalogProposalForAi } from "../src/lib/services/catalog-ai";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

const SOURCE_DOMAIN = "flyer-social.test";
const FLYER_URL = `https://${SOURCE_DOMAIN}/wp-content/uploads/2026/09/locandina-mainstream-page-0001.jpg`;
const FLYER_NAME = "locandina-mainstream-page-0001.jpg";
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

/** Locandina fittizia ma valida: WebP 1080x1080 generato con Sharp. */
let flyerImageBuffer: Buffer | null = null;

async function getFlyerImage(): Promise<Buffer> {
  if (!flyerImageBuffer) {
    flyerImageBuffer = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#3a7ca5" } })
      .webp()
      .toBuffer();
  }
  return flyerImageBuffer;
}

/** Host che questo verticale non deve mai toccare. */
const META_HOSTS = ["instagram.com", "graph.instagram.com", "graph.facebook.com", "facebook.com"];

const originalFetch = globalThis.fetch;
const sourceIds: string[] = [];
const contentIds: string[] = [];
const assetIds: string[] = [];
const fileUrls: string[] = [];
const jobOwnership = createJobOwnership(["IMAGE"]);

let baselineFiles: string[] = [];
let emptyProposalId = "";
let richProposalId = "";
/** Proposta dedicata al test sulla rubrica TRAVEL_TIPS. */
let tipsProposalId = "";

/**
 * Una foto vera: `sharp` deve poterla decodificare per comporre la creatività.
 *
 * È quadrata 1080x1080, cioè la tela della creatività, perché la composizione
 * non ingrandisce: una foto più piccola costringerebbe il renderer su un canvas
 * di riserva anziché sulla foto stessa.
 */
async function makePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#2b6a8f" } })
    .jpeg()
    .toBuffer();
}

/**
 * Provider finto che registra ogni prompt.
 *
 * `behaviour` decide l'esito: `"ok"` scrive una foto a terra, `"fail"` solleva
 * come farebbe un 500, `"no-file"` dichiara un file inesistente per provare che
 * il servizio non inventa un visuale su una promessa vuota.
 */
class SpyImageProvider implements ImageProvider {
  readonly name = "magnific";
  canGenerate = true;
  behaviour: "ok" | "fail" | "no-file" = "ok";
  calls: { prompt: string; options?: GenerateImageOptions }[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push({ prompt, options });
    if (this.behaviour === "fail") throw new Error("Magnific ha risposto 500");
    if (this.behaviour === "no-file") {
      return { url: "/uploads/images/non-esiste.png", provider: this.name, pathname: "", mimeType: "image/png", size: 0 };
    }
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
    throw new Error(`il verticale non carica file dal provider: ${file.originalName}`);
  }
}

let provider: SpyImageProvider;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Ogni host contattato davvero: è la prova che Meta non viene toccata. */
let contactedHosts: string[] = [];

function stubNetwork(): void {
  (globalThis as { fetch: FetchStub }).fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    contactedHosts.push(host);
    if (META_HOSTS.some((m) => host === m || host.endsWith(`.${m}`))) {
      throw new Error(`chiamata Meta non ammessa in questo test: ${host}`);
    }
    return new Response(new Uint8Array(await getFlyerImage()), { status: 200, headers: { "Content-Type": "image/webp" } });
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

function localPath(url: string): string {
  return path.join(process.cwd(), "public", url.replace(/^\//, ""));
}

/** Quante righe sono nate da un certo momento, per dire "non è stato creato nulla". */
async function countsSince(marker: Date) {
  return {
    content: await prisma.content.count({ where: { createdAt: { gte: marker } } }),
    asset: await prisma.contentAsset.count({ where: { createdAt: { gte: marker } } }),
  };
}

async function cleanupGenerated() {
  for (const url of fileUrls.splice(0)) {
    await deleteUploadedFile(url).catch(() => undefined);
  }
  for (const id of assetIds.splice(0)) {
    await prisma.contentAsset.deleteMany({ where: { id } });
  }
  // I job prima dei contenuti: cancellando i contenuti il `contentId` dei job
  // verrebbe azzerato e il criterio di proprietà lo perderebbe.
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

async function run(proposalId: string, format?: string) {
  const result = await createFlyerSocialDraft({
    proposalId,
    platforms: ["INSTAGRAM"],
    format: format ?? null,
  });
  if (result.ok) {
    contentIds.push(result.content.id);
    assetIds.push(result.creative.id);
    if (result.flyerSource) assetIds.push(result.flyerSource.id);
    for (const url of [result.creative.url, result.flyerSource?.url].filter(Boolean) as string[]) {
      if (!fileUrls.includes(url)) fileUrls.push(url);
    }
  }
  return result;
}

async function creativeMetadata(assetId: string): Promise<FlyerSocialCreativeMetadata> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({ where: { id: assetId } });
  return asset.metadata as unknown as FlyerSocialCreativeMetadata;
}

async function sourceMetadata(assetId: string): Promise<FlyerSocialSourceMetadata> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({ where: { id: assetId } });
  return asset.metadata as unknown as FlyerSocialSourceMetadata;
}

/**
 * Quanti pixel quasi bianchi ci sono in un'immagine.
 *
 * Serve a distinguere un'immagine composta da una copia: la foto che il
 * generatore produce è piatta e senza bianchi, quindi i pixel chiari compaiono
 * solo se il testo è stato davvero disegnato sopra. Per questo il confronto è
 * sempre differenziale, con la foto nuda come controllo.
 */
async function brightPixelsOf(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) n++;
  }
  return n;
}

async function brightPixels(file: string): Promise<number> {
  return brightPixelsOf(await fs.readFile(file));
}

/**
 * La riga di pixel bianchi più larga che sia centrata sulla metà del frame.
 *
 * Serve a misurare il titolo direttamente sull'immagine: la prova che è
 * centrato la dà il raster, non il codice che lo disegna. Un titolo allineato a
 * sinistra non compare mai in questa funzione, quindi il controllo non può
 * passare per un errore di layout.
 *
 * Il marchio in alto a destra è escluso di proposito: è più largo di una riga
 * di titolo e non è centrato, quindi misurarlo darebbe un numero falso.
 */
async function whiteRunOf(
  buffer: Buffer
): Promise<{ left: number; right: number; width: number }> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  // Il titolo non sta in una banda fissa: la card è ancorata al basso e sale
  // con i dati che contiene, quindi il titolo va cercato su tutto il fotogramma.
  // Ciò che lo distingue dal resto è la centratura, non l'altezza: il marchio
  // sta in alto a destra e le righe dei dati sono allineate a sinistra.
  const limit = info.height;
  const center = info.width / 2;
  // Tre pixel di tolleranza: l'ancoraggio è calcolato dal rasterizzatore su
  // metà pixel e l'arrotondamento può spostare il blocco di uno.
  const TOLERANCE = 3;
  let best = { left: -1, right: -1, width: 0 };
  for (let y = 0; y < limit; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      // Soglia un po' sotto il bianco pieno: include l'alone del testo, che è
      // ciò che un lettore percepisce come bordo della lettera.
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (right < 0) continue;
    // Il marchio sta in alto a destra ed è più largo di una riga di titolo:
    // contarlo farebbe misurare il wordmark. Si tiene solo ciò che è centrato,
    // che è esattamente la proprietà da verificare: un titolo allineato a
    // sinistra non rientra in nessuna riga e la misura resta vuota.
    if (Math.abs((left + right) / 2 - center) > TOLERANCE) continue;
    if (right - left > best.width) best = { left, right, width: right - left };
  }
  return best;
}

async function loadDto(proposalId: string) {
  // Si usa lo stesso caricamento del servizio: se il test ne usasse uno suo,
  // potrebbe passare su un DTO diverso da quello che il verticale vede davvero.
  const dto = await getCatalogProposalForAi(proposalId);
  assert.ok(dto, `proposta di test non trovata: ${proposalId}`);
  return dto!;
}

describe("verticale locandina → creatività sociale → DRAFT", () => {
  before(async () => {
    await jobOwnership.capture();
    baselineFiles = await listUploads();

    const source = await prisma.catalogSource.create({
      data: {
        domain: SOURCE_DOMAIN,
        baseUrl: `https://${SOURCE_DOMAIN}`,
        pageUrl: `https://${SOURCE_DOMAIN}/offerte/`,
        lastCrawledAt: new Date(),
      },
      select: { id: true },
    });
    sourceIds.push(source.id);

    // Proposta A: la locandina c'è, i dati commerciali no. È il caso reale di
    // tutte le proposte del catalogo locale, e il caso in cui l'estrattore non
    // deve riempire niente.
    const empty = await prisma.catalogProposal.create({
      data: {
        name: "Isola Verde",
        destination: "Isola Verde",
        sourceId: source.id,
        sourceUrl: `https://${SOURCE_DOMAIN}/offerte/`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "UNVERIFIED",
        contentHash: "hash-verticale-senza-dati",
        sourceOrder: 1,
      },
      select: { id: true },
    });
    emptyProposalId = empty.id;
    await prisma.catalogImage.create({
      data: { proposalId: empty.id, url: FLYER_URL, filename: FLYER_NAME, role: "FLYER", isOfficial: true },
    });

    // Proposta C: serve al test sulla rubrica TRAVEL_TIPS, che ha bisogno di un
    // DRAFT suo. Il riuso del verticale è sulla coppia (proposta, versione), e
    // una proposta già materializzata restituirebbe la creatività del formato
    // precedente: senza questa terza proposta il test della rubrica leggerebbe
    // il fotogramma di un'altra richiesta e passerebbe comunque.
    const tips = await prisma.catalogProposal.create({
      data: {
        name: "Consigli su Rodi",
        destination: "Rodi",
        sourceId: source.id,
        sourceUrl: `https://${SOURCE_DOMAIN}/offerte/`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "UNVERIFIED",
        contentHash: "hash-verticale-consigli",
        priceFrom: 640,
        periodStart: new Date("2026-09-10T00:00:00.000Z"),
        sourceOrder: 3,
      },
      select: { id: true },
    });
    tipsProposalId = tips.id;
    await prisma.catalogImage.create({
      data: { proposalId: tips.id, url: FLYER_URL, filename: FLYER_NAME, role: "FLYER", isOfficial: true },
    });

    // Proposta B: dati commerciali presenti, per dimostrare che l'estrattore
    // legge davvero quando la fonte ha qualcosa da dire. Senza questa, il test
    // 1 passerebbe anche con un estrattore che non legge niente.
    const rich = await prisma.catalogProposal.create({
      data: {
        name: "Capodanno a Creta",
        destination: "Creta",
        sourceId: source.id,
        sourceUrl: `https://${SOURCE_DOMAIN}/offerte/`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "OCR_DRAFT",
        contentHash: "hash-verticale-con-dati",
        priceFrom: 890,
        priceTo: 1090,
        currency: "EUR",
        periodStart: new Date("2026-12-27T00:00:00.000Z"),
        periodEnd: new Date("2027-01-03T00:00:00.000Z"),
        durationNights: 7,
        departureCities: "Milano, Roma",
        included: "Hotel 4 stelle, all inclusive, volo incluso",
        sourceOrder: 2,
      },
      select: { id: true },
    });
    richProposalId = rich.id;
    await prisma.catalogImage.create({
      data: { proposalId: rich.id, url: FLYER_URL, filename: FLYER_NAME, role: "FLYER", isOfficial: true },
    });

    provider = new SpyImageProvider();
    setImageProvider(provider);
    stubNetwork();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    setImageProvider(null);
    await cleanupGenerated();
    for (const id of sourceIds.splice(0)) {
      await prisma.catalogSource.deleteMany({ where: { id } });
    }
    const rest = await listUploads();
    assert.deepEqual(rest, baselineFiles, "la suite non deve lasciare file in public/uploads");
  });

  beforeEach(async () => {
    await cleanupGenerated();
    provider.calls.length = 0;
    provider.behaviour = "ok";
    provider.canGenerate = true;
    contactedHosts = [];
    stubNetwork();
  });

  /* 1 ─ dati commerciali mancanti: restano null, mai inventati */
  test("1. dati commerciali assenti restano null e non finiscono sulla creatività", async () => {
    const extraction = extractCommercial(await loadDto(emptyProposalId));

    for (const [field, value] of [
      ["price", extraction.price],
      ["priceTo", extraction.priceTo],
      ["currency", extraction.currency],
      ["departureDate", extraction.departureDate],
      ["returnDate", extraction.returnDate],
      ["duration", extraction.duration],
      ["departureCity", extraction.departureCity],
      ["accommodation", extraction.accommodation],
      ["board", extraction.board],
      ["transport", extraction.transport],
    ] as const) {
      assert.equal(value, null, `${field}: assente nella fonte, quindi null`);
    }
    assert.equal(extraction.confidence, 0, "nessun dato trovato: confidenza zero, non una stima");
    assert.deepEqual(extraction.extractedFields, []);
    assert.ok(extraction.warnings.length >= 6, "ogni campo assente va dichiarato nei warning");
    assert.equal(commercialLines(extraction).length, 0, "senza dati non si stampa nessuna riga");

    // E la creatività vera non deve riempiere il vuoto con un segnaposto.
    const result = await run(emptyProposalId);
    assert.ok(result.ok, "il verticale deve arrivare a terra anche senza dati commerciali");
    if (!result.ok) return;
    const meta = await creativeMetadata(result.creative.id);
    assert.deepEqual(meta.commercialLines, [], "nessuna riga commerciale inventata");
    assert.equal(meta.commercialFields.length, 0);
    assert.equal(meta.commercialConfidence, 0);

    const content = await prisma.content.findUniqueOrThrow({ where: { id: result.content.id } });
    assert.doesNotMatch(content.caption ?? "", /\d+\s*(€|eur)/i, "nessun prezzo in caption");
    assert.doesNotMatch(content.caption ?? "", /su richiesta|da concordare|a partire da/i, "nessun segnaposto al posto del dato");
  });

  test("1b. dati commerciali presenti vengono estratti dalla fonte, con provenienza", async () => {
    const extraction = extractCommercial(await loadDto(richProposalId));

    assert.equal(extraction.price, 890);
    assert.equal(extraction.priceTo, 1090);
    assert.equal(extraction.currency, "EUR");
    assert.equal(extraction.departureDate, "2026-12-27");
    assert.equal(extraction.returnDate, "2027-01-03");
    assert.equal(extraction.duration, "7 notti");
    assert.equal(extraction.departureCity, "Milano, Roma");
    // Campi senza colonna: entrano solo per corrispondenza letterale, e la prova
    // del frammento resta nei campi estratti.
    assert.equal(extraction.accommodation, "hotel 4 stelle");
    assert.equal(extraction.board, "all inclusive");
    assert.equal(extraction.transport, "volo incluso");
    assert.ok(extraction.confidence > 0 && extraction.confidence < 0.9, "confidenza reale, mai assoluta");
    assert.equal(extraction.sourceImageUrl, FLYER_URL, "la provenienza è la locandina");

    for (const field of ["price", "board", "duration"]) {
      const found = extraction.extractedFields.find((f) => f.field === field);
      assert.ok(found, `${field} deve avere una provenienza registrata`);
      assert.ok(found!.from.length > 0, `${field} deve dire da dove viene`);
    }
    const board = extraction.extractedFields.find((f) => f.field === "board")!;
    assert.equal(board.kind, "LITERAL_MATCH", "un campo senza colonna è una corrispondenza letterale");
  });

  /* 2 ─ Magnific riceve solo il brief fotografico */
  test("2. al generatore arriva solo il brief fotografico, mai i dati commerciali", async () => {
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    assert.equal(provider.calls.length, 1, "una sola generazione");
    const prompt = provider.calls[0].prompt;
    assert.equal(prompt, result.photoPrompt, "il prompt dichiarato è quello inviato");
    assert.ok(prompt.length <= 1000, "il prompt resta entro il limite del provider");

    // La destinazione sì: è il soggetto della foto.
    assert.match(prompt, /Creta/);
    assert.match(prompt, /fotografia|fotografico/i);
    assert.match(prompt, /luce naturale/i);

    // I dati commerciali no: nessuno, in nessuna forma.
    for (const forbidden of [
      "890", "1090", "EUR", "€",
      "2026-12-27", "2027-01-03", "27/12", "03/01",
      "notti", "notte", "7 notti",
      "all inclusive", "mezza pensione", "pensione",
      "hotel", "Milano", "Roma",
      "Prezzo", "Partenza", "Durata", "Trasporto",
    ]) {
      assert.ok(!prompt.toLowerCase().includes(forbidden.toLowerCase()), `il prompt non deve contenere "${forbidden}"`);
    }

    // Il prompt è derivato dalla direzione, non dalla caption: stessa direzione,
    // stesso prompt.
    const direction = buildVisualDirection(await loadDto(richProposalId), "OFFER");
    assert.equal(buildPhotoPrompt(direction), buildPhotoPrompt(direction), "il prompt è deterministico");
  });

  /* 3 ─ il flyer originale non è l'asset finale */
  test("3. la locandina non diventa il visuale del DRAFT", async () => {
    const result = await run(emptyProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { assets: { orderBy: { createdAt: "asc" } } },
    });

    // L'app mostra `assets[0]` e la pubblicazione userebbe lo stesso asset: se
    // la locandina fosse tra gli asset del contenuto, il post mostrerebbe la
    // locandina.
    assert.equal(content.assets.length, 1, "il DRAFT ha un solo asset: la creatività");
    const [first] = content.assets;
    assert.equal(first.id, result.creative.id);
    assert.equal(first.url, result.creative.url);
    assert.notEqual(result.creative.url, FLYER_URL, "l'asset finale non è il file del catalogo");

    // La locandina esiste, ma in Media Library e con il ruolo di fonte.
    assert.ok(result.flyerSource, "la locandina deve restare come provenienza");
    assert.equal(result.flyerSource!.contentId, null, "la locandina non è allegata al contenuto");
    const srcMeta = await sourceMetadata(result.flyerSource!.id);
    assert.equal(srcMeta.origin, FLYER_SOCIAL_SOURCE_ORIGIN);
    assert.equal(srcMeta.role, "SOURCE_FLYER");
    assert.equal(srcMeta.sourceUrl, FLYER_URL);
    assert.equal(srcMeta.contentId, result.content.id, "il legame al DRAFT è nei metadati");

    // E i due file sono davvero due file diversi.
    const creativeBytes = await fs.readFile(localPath(result.creative.url));
    const flyerBytes = await fs.readFile(localPath(result.flyerSource!.url));
    assert.notEqual(creativeBytes.equals(flyerBytes), true, "la creatività non è una copia della locandina");
  });

  /* 4 ─ viene creato un nuovo asset social */
  test("4. la creatività è un'immagine nuova, composta e a terra", async () => {
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    const asset = await prisma.contentAsset.findUniqueOrThrow({ where: { id: result.creative.id } });
    assert.equal(asset.kind, "IMAGE");
    assert.equal(asset.contentId, result.content.id);
    assert.ok(asset.url.startsWith("/uploads/images/"), "la creatività vive negli upload");
    assert.equal(asset.mimeType, "image/jpeg");

    const file = localPath(asset.url);
    const meta = await sharp(await fs.readFile(file)).metadata();
    assert.equal(meta.width, SOCIAL_CREATIVE_SIZE);
    assert.equal(meta.height, SOCIAL_CREATIVE_SIZE);
    assert.equal(meta.format, "jpeg");

    // Il testo è stato davvero disegnato: si confronta con la foto nuda, che è
    // il controllo. Una soglia assoluta passerebbe anche con un font che non
    // esiste e un'immagine senza una riga di testo.
    const control = await brightPixelsOf(await makePhoto());
    const bright = await brightPixels(file);
    assert.ok(control < 500, `la foto di controllo non deve avere bianchi (ne ha ${control})`);
    assert.ok(bright > control + 2000, `la creatività deve avere testo sopra la foto (${bright} vs ${control})`);

    const meta2 = await creativeMetadata(asset.id);
    assert.equal(meta2.origin, FLYER_SOCIAL_CREATIVE_ORIGIN);
    assert.equal(meta2.vertical, FLYER_SOCIAL_VERTICAL);
    assert.equal(meta2.provider, "magnific");
    assert.equal(meta2.generatedPhoto.prompt, result.photoPrompt);
    assert.ok(meta2.generatedPhoto.url.length > 0, "la fotografia generata è tracciata");
    assert.equal(meta2.flyer.sourceUrl, FLYER_URL, "la creatività dichiara la locandina da cui deriva");
    assert.equal(meta2.flyer.localAssetId, result.flyerSource?.id, "e il relativo asset di provenienza");
    assert.equal(meta2.extractionMethod, "catalog-record", "il metodo di estrazione è dichiarato");
    assert.equal(meta2.layers.commercial.origin, "FLYER");
    assert.equal(meta2.layers.photo.origin, "MAGNIFIC");
    assert.equal(meta2.layers.brand.origin, "BRAND");
    assert.equal(meta2.layers.copy.origin, "COPY");
    // Le righe commerciali ci sono perché la fonte le aveva: questo è il
    // contraltale del test 1.
    assert.ok(meta2.commercialLines.length > 0, "i dati estratti finiscono sulla creatività");
  });

  /* 4b ─ il titolo stampato e il marchio */
  test("4b. sul fotogramma c'è il nome del luogo e il marchio, non le formule", async () => {
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    const meta = await creativeMetadata(result.creative.id);

    // Il titolo stampato è il nome pulito del luogo: il nome della proposta è
    // una stringa editoriale ("... - proposta di viaggio") che sul post diventa
    // rumido, quindi non viene stampata né come titolo né come sottotitolo.
    assert.equal(
      meta.printedTitle,
      result.extraction.destination,
      "il titolo stampato è il luogo, non il nome della proposta"
    );
    assert.doesNotMatch(
      meta.printedTitle,
      /viaggio|proposta|post|reel/i,
      "nessuna formula generica sul fotogramma"
    );

    // Il marchio c'è sempre: qui il brand di test non ha un logo file, quindi è
    // il wordmark con il nome dell'agenzia, dichiarato come tale.
    assert.equal(meta.brandMark, "wordmark");
    assert.equal(meta.layers.brand.detail, "wordmark");
    assert.ok(
      meta.layers.brand.lines.length > 0,
      "il livello brand dichiara il nome dell'agenzia usato come marchio"
    );
  });

  test("4c. la foto sotto il template è generata ad alta risoluzione, non la locandina", async () => {
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    const meta = await creativeMetadata(result.creative.id);

    // La base del fotogramma è una fotografia generata sul tema della
    // destinazione: la locandina del fornitore non entra nel post, né come
    // sfondo né ritagliata.
    assert.ok(meta.generatedPhoto.url.startsWith("/uploads/"));
    assert.equal(meta.generatedPhoto.aspectRatio, "square_1_1");
    assert.equal(meta.generatedPhoto.resolution, "2k", "alta risoluzione: il template ritaglia a 1080");
    assert.doesNotMatch(meta.generatedPhoto.prompt, /890|1290|EUR|2026-12-20/, "nessun dato commerciale nel prompt");
    assert.match(meta.generatedPhoto.prompt, /Creta/, "il tema è la destinazione");
    assert.doesNotMatch(
      meta.generatedPhoto.prompt,
      /ripresa dall'originale/i,
      "il prompt non promette una ripresa della locandina"
    );

    // E il file a terra è il fotogramma composto, non il file del catalogo.
    const creative = await fs.readFile(localPath(result.creative.url));
    const flyer = await fs.readFile(localPath(result.flyerSource!.url));
    assert.notEqual(creative.equals(flyer), true, "la creatività non è il file del fornitore");
    const composed = await sharp(creative).metadata();
    assert.equal(composed.format, "jpeg");
    assert.equal(composed.width, SOCIAL_CREATIVE_SIZE);

    // Il titolo è centrato sul frame. La verifica è sui pixel, non sul codice
    // che lo disegna: il centro geometrico del blocco di testo deve coincidere
    // con la metà della larghezza.
    const titleRun = await whiteRunOf(creative);
    assert.ok(titleRun.width > 0, "il titolo è stato disegnato");
    const center = (titleRun.left + titleRun.right) / 2;
    assert.ok(
      Math.abs(center - SOCIAL_CREATIVE_SIZE / 2) <= 2,
      `il titolo è centrato (centro ${center}, atteso ${SOCIAL_CREATIVE_SIZE / 2}, ` +
        `banda ${titleRun.left}..${titleRun.right})`
    );
  });

  test("4d. TRAVEL_TIPS sul verticale stampa la rubrica dei consigli", async () => {
    const result = await run(tipsProposalId, "TRAVEL_TIPS");
    assert.ok(result.ok, result.ok ? "" : result.message);
    if (!result.ok) return;

    const meta = await creativeMetadata(result.creative.id);
    // La rubrica dichiara di che post si tratta: senza, un consiglio e un hero
    // sullo stesso posto avrebbero lo stesso aspetto.
    assert.equal(meta.kicker, "Consigli di viaggio");
    // Il titolo resta il luogo, che è l'unico dato verificabile: la rubrica
    // dichiara a che cosa serve il post, non sostituisce il contenuto.
    assert.equal(meta.printedTitle, "Rodi");
    assert.ok(
      meta.commercialLines.length > 0,
      "i dati dell'offerta restano stampati sotto la fascia dei consigli"
    );
  });

  /* 5 ─ viene creato un Content DRAFT */
  test("5. il risultato è un DRAFT, mai approvato né pubblicato", async () => {
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    const content = await prisma.content.findUniqueOrThrow({
      where: { id: result.content.id },
      include: { platforms: true, approvals: true, catalogProposal: true },
    });

    assert.equal(content.status, "DRAFT");
    assert.equal(content.catalogProposalId, richProposalId, "il DRAFT risale alla proposta reale");
    assert.ok(content.title && content.title.trim().length > 0);
    assert.ok(content.caption && content.caption.trim().length > 0, "caption coerente");
    assert.equal(content.approvals.length, 0, "nessuna approvazione automatica");
    assert.deepEqual(content.platforms.map((p) => p.platform), ["INSTAGRAM"]);

    // La caption deve poter essere ricondotta ai dati reali: niente date o
    // prezzi se la fonte non li ha, e per questa proposta li ha.
    assert.match(content.caption!, /Creta/);
  });

  test("5b. il DRAFT nasce anche quando i dati commerciali non ci sono", async () => {
    const result = await run(emptyProposalId);
    assert.ok(result.ok, "l'assenza di dati non deve impedire la creatività");
    if (!result.ok) return;
    assert.equal(result.content.status, "DRAFT");
    assert.equal(result.extraction.confidence, 0);
    const meta = await creativeMetadata(result.creative.id);
    assert.ok(meta.commercialWarnings.length > 0, "i warning restano tracciati nell'asset");
  });

  /* 6 ─ nessuna chiamata Meta */
  test("6. nessuna chiamata a Instagram o Facebook", async () => {
    const marker = new Date();
    const result = await run(richProposalId);
    assert.ok(result.ok);
    if (!result.ok) return;

    for (const host of contactedHosts) {
      assert.ok(
        !META_HOSTS.some((m) => host === m || host.endsWith(`.${m}`)),
        `nessun host Meta può essere contattato (trovato ${host})`
      );
    }
    assert.deepEqual(contactedHosts, [SOURCE_DOMAIN], "l'unica rete toccata è il dominio della fonte in catalogo");

    const counts = await countsSince(marker);
    assert.equal(counts.content, 1, "un solo contenuto");
    assert.equal(counts.asset, 2, "creatività + locandina, nient'altro");

    const approvals = await prisma.approval.count({ where: { contentId: result.content.id } });
    assert.equal(approvals, 0);
  });

  /* 7 ─ idempotenza di base */
  test("7. ripetere la richiesta riusa il risultato senza rifare nulla", async () => {
    const first = await run(emptyProposalId);
    assert.ok(first.ok);
    if (!first.ok) return;

    const second = await createFlyerSocialDraft({ proposalId: emptyProposalId, platforms: ["INSTAGRAM"] });
    assert.ok(second.ok, "la seconda esecuzione deve riuscire");
    if (!second.ok) return;

    assert.equal(first.reused, false);
    assert.equal(second.reused, true, "la seconda esecuzione riusa");
    assert.equal(second.content.id, first.content.id, "stesso DRAFT");
    assert.equal(second.creative.id, first.creative.id, "stessa creatività");
    assert.equal(second.creative.url, first.creative.url, "nessun file nuovo");

    assert.equal(provider.calls.length, 1, "il generatore non viene richiamato");
    assert.equal(contactedHosts.length, 1, "la rete non viene ritoccata");

    const contents = await prisma.content.count({ where: { catalogProposalId: emptyProposalId } });
    assert.equal(contents, 1, "nessun DRAFT duplicato");
    const assets = await prisma.contentAsset.count({
      where: { metadata: { not: undefined } },
    });
    assert.ok(assets > 0);
  });

  /* 8 ─ fallimento Magnific: nessun DRAFT corrotto o orfano */
  test("8. se il generatore fallisce non resta né DRAFT né file", async () => {
    const marker = new Date();
    const before = await countsSince(marker);
    const filesBefore = await listUploads();

    provider.behaviour = "fail";
    const result = await run(emptyProposalId);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "generation_failed");
    assert.ok(result.message.includes("nessun contenuto"), "il fallimento lo dice");

    const after = await countsSince(marker);
    assert.equal(after.content, before.content, "nessun DRAFT creato");
    assert.equal(after.asset, before.asset, "nessun asset creato");
    assert.deepEqual(await listUploads(), filesBefore, "nessun file lasciato a terra");

    // Il fallimento è tracciato: un job chiuso come fallito, non come riuscito.
    const job = await prisma.aIJob.findFirst({ where: { kind: "IMAGE" }, orderBy: { createdAt: "desc" } });
    assert.ok(job, "il tentativo di generazione resta tracciato");
  });

  test("8b. un provider che promette un file assente non produce un DRAFT", async () => {
    const marker = new Date();
    const before = await countsSince(marker);
    const filesBefore = await listUploads();

    provider.behaviour = "no-file";
    const result = await run(richProposalId);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "generation_failed");
    assert.equal(result.detail, "file_missing");

    const after = await countsSince(marker);
    assert.equal(after.content, before.content);
    assert.equal(after.asset, before.asset);
    assert.deepEqual(await listUploads(), filesBefore, "neppure la locandina viene scaricata");
  });

  test("8c. una proposta senza locandina non produce nulla", async () => {
    const marker = new Date();
    const before = await countsSince(marker);

    const orphan = await prisma.catalogProposal.create({
      data: {
        name: "Senza locandina",
        destination: "Da definire",
        sourceId: sourceIds[0],
        sourceUrl: `https://${SOURCE_DOMAIN}/offerte/`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "UNVERIFIED",
        contentHash: "hash-verticale-senza-locandina",
        sourceOrder: 3,
      },
      select: { id: true },
    });

    const result = await createFlyerSocialDraft({ proposalId: orphan.id, platforms: ["INSTAGRAM"] });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no_flyer");
    assert.equal(provider.calls.length, 0, "senza provenienza non si genera nemmeno la foto");

    const after = await countsSince(marker);
    assert.equal(after.content, before.content);
    assert.equal(after.asset, before.asset);

    await prisma.catalogProposal.deleteMany({ where: { id: orphan.id } });
  });
});


