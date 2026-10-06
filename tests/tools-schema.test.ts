import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deleteContent, getContent, listContents } from "../src/lib/services/content";
import { createAsset, deleteAsset } from "../src/lib/services/media";
import { prisma } from "../src/lib/prisma";
import { createContentTool } from "../src/lib/ai/tools/content";
import { generateImageTool } from "../src/lib/ai/tools/generation";
import { createCarouselTool } from "../src/lib/ai/tools/carousel";
import { platformsField, hashtagsField } from "../src/lib/ai/tools/schemas";
import { AI_TOOLS, getTool, toolsSystemDescription } from "../src/lib/ai/tools/registry";
import { setImageProvider, setStockProvider } from "../src/lib/images/factory";
import { ImageProvider } from "../src/lib/images/provider";
import { installFakeStock } from "./helpers/stock";

/**
 * createContent porta a terra anche il visual del DRAFT: lo recupera dalla
 * libreria stock, quindi qui il provider stock è un doppione (nessuna rete,
 * nessun consumo di crediti) mentre il provider immagini NON genera: serve
 * solo a dimostrare che il percorso di generazione non viene toccato. La
 * verifica del percorso di stock (ricerca → layout → Media Library → Content)
 * sta in tests/content-creation-media.test.ts.
 */
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
const assetIds: string[] = [];

async function cleanup() {
  for (const id of assetIds.splice(0)) {
    try {
      await deleteAsset(id);
    } catch {
      // già eliminato
    }
  }
  for (const id of createdIds) {
    // Gli asset stock nati con il DRAFT: via prima del contenuto, altrimenti
    // `deleteContent` li lascia senza `contentId` e non si riconoscono più.
    await prisma.contentAsset
      .deleteMany({ where: { contentId: id } })
      .catch(() => {});
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
  setImageProvider(new NoopImageProvider());
  installFakeStock();
  await cleanup();
});

after(async () => {
  setImageProvider(null);
  setStockProvider(null);
  await cleanup();
});

test("createContent con platforms array valido crea DRAFT", async () => {
  const res = await createContentTool.execute({
    title: "[TEST] schema platforms array",
    caption: "Caption di test",
    hashtags: "#test #schema",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string; status: string };
  assert.equal(data.status, "DRAFT");
  createdIds.push(data.id);
});

test("createContent accetta e normalizza platforms come singola stringa", async () => {
  const res = await createContentTool.execute({
    title: "[TEST] schema platforms string",
    caption: "Caption di test",
    platforms: "INSTAGRAM",
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string; platforms: string[] };
  assert.deepEqual(data.platforms, ["INSTAGRAM"]);
  createdIds.push(data.id);
});

test("createContent accetta e normalizza platforms separata da virgola", async () => {
  const res = await createContentTool.execute({
    title: "[TEST] schema platforms list",
    caption: "Caption di test",
    platforms: "INSTAGRAM, FACEBOOK",
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string; platforms: string[] };
  assert.deepEqual([...data.platforms].sort(), ["FACEBOOK", "INSTAGRAM"]);
  createdIds.push(data.id);
});

test("schemas: platforms valido come stringa viene normalizzato in array", () => {
  const parsed = platformsField.safeParse("INSTAGRAM");
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data, ["INSTAGRAM"]);
});

test("schemas: platforms invalido viene rifiutato (piattaforma sconosciuta)", () => {
  const parsed = platformsField.safeParse("TWITTER");
  assert.equal(parsed.success, false);
  assert.equal(platformsField.safeParse(42).success, false);
  assert.equal(platformsField.safeParse(undefined).success, false);
});

test("schemas: hashtags valido come stringa e array normalizzato", () => {
  const str = hashtagsField.safeParse("#parigi #viaggio");
  assert.equal(str.success, true);
  if (str.success) assert.equal(str.data, "#parigi #viaggio");
  const arr = hashtagsField.safeParse(["#parigi", "#viaggio"]);
  assert.equal(arr.success, true);
  if (arr.success) assert.equal(arr.data, "#parigi #viaggio");
});

test("generateImage schema accetta prompt e contentId, rifiuta prompt vuoto", () => {
  const ok = generateImageTool.schema.safeParse({
    prompt: "Coppia romantica sulla Senna a Parigi al tramonto",
    contentId: "abc123",
    aspectRatio: "square_1_1",
  });
  assert.equal(ok.success, true);
  const empty = generateImageTool.schema.safeParse({ prompt: "" });
  assert.equal(empty.success, false);
});

test("createCarousel schema accetta platforms come singola stringa", () => {
  const parsed = createCarouselTool.schema.safeParse({
    title: "5 cose romantiche a Parigi",
    topic: "weekend romantico a Parigi",
    slides: [],
    generateSlides: false,
    platforms: "INSTAGRAM",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data.platforms, ["INSTAGRAM"]);
});

test("per un post completo l'output finale resta DRAFT e nessuna transizione viene eseguita", async () => {
  const res = await createContentTool.execute({
    title: "[TEST] post completo",
    caption: "Un weekend romantico a Parigi: passeggiate lungo la Senna, un aperitivo con vista sulla Tour Eiffel e un tramonto da ricordare.",
    hashtags: "#parigi #weekend #romantico",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string };
  createdIds.push(data.id);

  const asset = await createAsset({
    url: "/uploads/images/test-parigi.png",
    filename: "test-parigi.png",
    mimeType: "image/png",
    size: 1234,
    kind: "IMAGE",
    contentId: data.id,
  });
  assetIds.push(asset.id);

  const content = await getContent(data.id);
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.equal(content.caption?.includes("Parigi"), true);
  assert.equal(content.hashtags, "#parigi #weekend #romantico");
  assert.equal(content.assets.length, 2, "visual stock + asset creato dal test");
  assert.equal(content.approvals.length, 0);

  const approvals = await prisma.approval.count({ where: { contentId: data.id } });
  assert.equal(approvals, 0);
});

test("la description dei tool deve contenere esempi di formato", () => {
  const desc = toolsSystemDescription();
  assert.match(desc, /INSTAGRAM/);
  assert.match(desc, /array/);
  assert.ok(AI_TOOLS.some((t) => t.name === "generateImage"));
  assert.ok(getTool("createContent"));
});

test("createContent non crea approvazioni né contenuti aggiuntivi", async () => {
  // Il conteggio è scoped a questo titolo, non globale: i file di test girano
  // in parallelo e creano contenuti, quindi un totale globale oscillerebbe.
  const title = `[TEST] solo draft ${Date.now()}`;
  const beforeCount = await prisma.content.count({ where: { title } });
  const res = await createContentTool.execute({
    title,
    caption: "Caption di test",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string };
  createdIds.push(data.id);
  const afterCount = await prisma.content.count({ where: { title } });
  assert.equal(
    afterCount,
    beforeCount + 1,
    "createContent deve creare esattamente un contenuto"
  );
  const list = await listContents({ search: title });
  assert.equal(list.length, 1);
});