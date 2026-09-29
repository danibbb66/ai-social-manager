import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { createJobOwnership } from "./helpers/aijob-ownership";
import { createContentTool } from "../src/lib/ai/tools/content";
import { generateImageTool } from "../src/lib/ai/tools/generation";
import { getContent, deleteContent } from "../src/lib/services/content";
import { linkAsset } from "../src/lib/services/media";
import { setImageProvider } from "../src/lib/images/factory";
import { ImageProvider, GeneratedImage } from "../src/lib/images/provider";
import { buildVisualPrompt } from "../src/lib/ai/content-visual";

const REPO_ROOT = join(__dirname, "..");

/**
 * createContent NON genera più immagini.
 *
 * Regressione sul test reale del 26/09: una semplice richiesta "crea un post"
 * chiamava Magnific e produceva un'immagine AI. Ora createContent crea solo
 * testo e piattaforme, il DRAFT resta senza visual e si completa dalla Media
 * Library. Magnific resta disponibile, ma solo su richiesta esplicita
 * (`generateImage`): qui il provider è un doppione che parla con lo stesso
 * contratto di `ImageProvider`.
 */

/** Provider finto: registra le chiamate e restituisce un file già "scaricato". */
class FakeImageProvider implements ImageProvider {
  readonly name = "fake";
  calls: { prompt: string; contentId?: string; aspectRatio?: string }[] = [];
  failWith: Error | null = null;

  constructor(readonly canGenerate = true) {}

  async generateImage(
    prompt: string,
    options?: { contentId?: string; aspectRatio?: string }
  ): Promise<GeneratedImage> {
    this.calls.push({
      prompt,
      contentId: options?.contentId,
      aspectRatio: options?.aspectRatio,
    });
    if (this.failWith) throw this.failWith;
    return {
      url: "/uploads/images/test-visual.png",
      provider: this.name,
      pathname: "C:/tmp/test-visual.png",
      mimeType: "image/png",
      size: 1234,
    };
  }

  async saveUploadedFile(): Promise<GeneratedImage> {
    throw new Error("non usato");
  }
}

/** Destinazioni che non devono mai comparire se l'argomento è "Calabria". */
const OTHER_DESTINATIONS = [
  "amalfi",
  "costiera amalfitana",
  "puglia",
  "sardegna",
  "sicilia",
  "roma",
  "parigi",
  "tokyo",
  "giappone",
  "barcellona",
  "santorini",
];

const createdIds: string[] = [];
const createdAssetIds: string[] = [];

function textOf(c: { title: string | null; caption: string | null; hashtags: string | null }) {
  return `${c.title ?? ""} ${c.caption ?? ""} ${c.hashtags ?? ""}`.toLowerCase();
}

async function foreignDestinations(text: string): Promise<string[]> {
  return OTHER_DESTINATIONS.filter((d) =>
    new RegExp(`\\b${d}\\b`, "i").test(text)
  );
}

async function createTool(args: Record<string, unknown>) {
  const res = await createContentTool.execute(args);
  const data = (res.data ?? {}) as { id?: string };
  if (res.ok && typeof data.id === "string") createdIds.push(data.id);
  return { res, data: data as { id: string } & Record<string, unknown> };
}

beforeEach(() => {
  setImageProvider(new FakeImageProvider());
});

/**
 * Gli AIJob delle pipeline nascono senza `Content.contentId`: `recordJob` li
 * crea col solo `input`, e quando la pipeline genera la caption del contenuto
 * che sta per nascere quell'id non esiste ancora. La proprietà e il criterio
 * di pulizia sono nel helper condiviso: mai una finestra temporale.
 */
const jobOwnership = createJobOwnership(["CAPTION", "HASHTAGS", "IMAGE"]);

before(async () => {
  await jobOwnership.capture();
});

after(async () => {
  setImageProvider(null);
  // Prima dei contenuti: `deleteContent` azzera `contentId` (SetNull) e da quel
  // momento non si saprebbe più di quale contenuto erano.
  await jobOwnership.deleteOwned(createdIds);
  for (const id of createdAssetIds.splice(0)) {
    await prisma.contentAsset.delete({ where: { id } }).catch(() => {});
  }
  for (const id of createdIds.splice(0)) {
    await deleteContent(id).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("createContent crea il DRAFT senza generare immagini", () => {
  test("1. con topic Calabria crea un DRAFT con i campi richiesti", async () => {
    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria: spiagge, borghi e cucina tipica.",
      hashtags: "#calabria #viaggi #suditalia",
      platforms: ["INSTAGRAM", "FACEBOOK"],
    });

    assert.equal(res.ok, true, res.message);
    const content = await getContent(data.id);
    assert.ok(content, "il contenuto deve esistere");
    assert.equal(content!.status, "DRAFT", "createContent crea sempre in DRAFT");
    assert.equal(content!.type, "POST");
    assert.deepEqual(
      content!.platforms.map((p) => p.platform).sort(),
      ["FACEBOOK", "INSTAGRAM"]
    );
    assert.ok((content!.caption ?? "").length > 0, "la caption c'è");
    assert.equal(data.withMedia, false, "withMedia è sempre false");
    assert.equal(data.assetId, null, "nessun asset associato");
  });

  test("2. nessuna chiamata al provider immagini, nemmeno con withMedia:true", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      hashtags: "#calabria",
      platforms: ["INSTAGRAM"],
      withMedia: true,
    });

    assert.equal(images.calls.length, 0, "Magnific non deve essere chiamato");
    const content = await getContent(data.id);
    assert.equal(content!.assets.length, 0, "il DRAFT resta senza visual");
    assert.equal(
      await prisma.contentAsset.count({ where: { contentId: data.id } }),
      0,
      "nessun asset in Media Library"
    );
  });

  test("3. il messaggio dichiara che non è stata generata alcuna immagine", async () => {
    const { res } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });

    assert.match(res.message, /Nessuna immagine AI generata/);
    assert.match(res.message, /Media Library/);
    assert.doesNotMatch(res.message, /magnific/i);
  });

  test("4. il contenuto mantiene la destinazione richiesta", async () => {
    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria: spiagge, borghi e cucina tipica.",
      hashtags: "#calabria #viaggi",
      platforms: ["INSTAGRAM"],
    });

    const content = await getContent(data.id);
    const text = textOf(content!);
    assert.match(text, /calabria/, "la destinazione richiesta deve essere presente");
    assert.deepEqual(
      await foreignDestinations(text),
      [],
      "non deve comparire una destinazione estranea"
    );
  });

  test("5. il DRAFT senza visual si completa dopo dalla Media Library", async () => {
    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      hashtags: "#calabria",
      platforms: ["INSTAGRAM"],
    });

    // Media Library: un asset reale, creato a parte e non inventato.
    const images = new FakeImageProvider();
    setImageProvider(images);
    const gen = await generateImageTool.execute({
      prompt: "Calabria, costa al tramonto",
      contentId: data.id,
    });
    const genData = gen.data as { assetId?: string } | undefined;
    if (typeof genData?.assetId === "string") createdAssetIds.push(genData.assetId);

    const linked = await getContent(data.id);
    assert.equal(linked!.assets.length, 1, "il media può essere collegato dopo");
    assert.equal(linked!.assets[0].contentId, data.id);

    // Stacco: collegare un asset esistente non passa dal generatore.
    const before = images.calls.length;
    const assetId = linked!.assets[0].id;
    await linkAsset(assetId, null);
    await linkAsset(assetId, data.id);
    assert.equal(images.calls.length, before, "linkAsset non genera immagini");
    const back = await getContent(data.id);
    assert.equal(back!.assets.length, 1);
  });

  test("6. un provider immagini rotto o assente non cambia nulla", async () => {
    // 6a. provider che fallisce: prima creava un warning, ora non viene chiamato
    const failing = new FakeImageProvider();
    failing.failWith = new Error("Magnific non raggiungibile");
    setImageProvider(failing);

    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(failing.calls.length, 0, "il provider non viene coinvolto");
    const content = await getContent(data.id);
    assert.ok(content && content.status === "DRAFT", "il DRAFT resta valido");
    assert.equal(content.assets.length, 0);
    assert.doesNotMatch(res.message, /Magnific non raggiungibile/);

    // 6b. provider non configurato: stesso risultato, nessun errore
    setImageProvider(new FakeImageProvider(false));
    const { res: res2, data: data2 } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, senza provider",
      caption: "Un post sulla Calabria.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(res2.ok, true, res2.message);
    const content2 = await getContent(data2.id);
    assert.equal(content2!.status, "DRAFT");
    assert.equal(content2!.assets.length, 0);
    assert.equal(data2.withMedia, false);
  });
});

describe("il flusso esplicito di Magnific resta disponibile", () => {
  test("7. generateImage con contentId genera e collega l'asset", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });

    const gen = await generateImageTool.execute({
      prompt: "Borghi della Calabria sul mare, luce dorata",
      contentId: data.id,
    });
    assert.equal(gen.ok, true, gen.message);
    assert.equal(images.calls.length, 1, "qui il provider viene chiamato");
    assert.equal(images.calls[0].contentId, data.id);

    const assetId = (gen.data as { assetId: string }).assetId;
    createdAssetIds.push(assetId);
    const asset = await prisma.contentAsset.findUnique({ where: { id: assetId } });
    assert.ok(asset, "l'asset deve esistere in Media Library");
    assert.equal(asset!.contentId, data.id);
    assert.equal(asset!.kind, "IMAGE");
    assert.match((asset!.metadata as { prompt?: string }).prompt ?? "", /calabria/i);
  });

  test("8. generateImage senza contentId resta utilizzabile", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const gen = await generateImageTool.execute({ prompt: "Tramonto sulla costa" });
    assert.equal(gen.ok, true, gen.message);
    const assetId = (gen.data as { assetId: string }).assetId;
    createdAssetIds.push(assetId);
    const asset = await prisma.contentAsset.findUnique({ where: { id: assetId } });
    assert.ok(asset, "l'asset resta in Media Library");
    assert.equal(asset!.contentId, null, "nessun contenuto collegato");
  });
});

describe("Il prompt del visual è ancorato al topic", () => {
  test("ripete il topic e vieta altre destinazioni", () => {
    const prompt = buildVisualPrompt({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Spiagge e borghi.",
      hashtags: "#calabria",
    });
    assert.match(prompt, /proposta Calabria/);
    assert.match(prompt, /ESCLUSIVAMENTE/i);
    assert.match(prompt, /non introdurre altre destinazioni/i);
  });

  test("senza topic usa il titolo e resta comunque limitato", () => {
    const prompt = buildVisualPrompt({ title: "Vacanza in Toscana" });
    assert.match(prompt, /Toscana/);
    assert.ok(prompt.length <= 1000, "il prompt rispetta il limite del provider");
  });

  test("il system prompt dell'agente vieta le destinazioni estranee e le immagini automatiche", () => {
    // Regressione sul bug: "proposta Calabria" produceva una caption sull'Amalfi.
    const agent = readFileSync(join(REPO_ROOT, "src", "lib", "ai", "agent.ts"), "utf8");
    assert.match(agent, /topic: argomento esatto chiesto/);
    assert.match(agent, /parlano solo di quello, senza altre destinazioni/);
    assert.match(agent, /senza destinazioni o prodotti non richiesti/);
    // Il divieto di generazione automatica vale per il ramo senza catalogo.
    // Il Catalog Flow materializza invece il visuale, e il prompt lo dichiara:
    // se sparisse questa seconda riga, il prompt direbbe due cose opposte.
    assert.match(
      agent,
      /Senza catalogo createContent NON genera immagini: il DRAFT resta senza visual e si completa dalla Media Library/
    );
    assert.match(agent, /Con "fromCatalog": true il visuale è già pronto/);
  });

  test("createContent non chiama più ensureContentVisual", () => {
    // La garanzia è sul codice: nessun percorso automatico verso il generatore.
    const tool = readFileSync(join(REPO_ROOT, "src", "lib", "ai", "tools", "content.ts"), "utf8");
    assert.doesNotMatch(tool, /ensureContentVisual/);
    assert.doesNotMatch(tool, /getImageProvider/);
  });
});
