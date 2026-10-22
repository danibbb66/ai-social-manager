import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { createContentAction } from "../src/lib/actions/content";
import { getTool } from "../src/lib/ai/tools/registry";
import { installFakeStock } from "./helpers/stock";
import { installFakeStockVideo, resetStockVideo } from "./helpers/stock-video";
import { setImageProvider, setStockProvider } from "../src/lib/images/factory";
import type { ImageProvider } from "../src/lib/images/provider";
import { isVideoGenerationAvailable } from "../src/lib/video/ffmpeg";

const contentIds: string[] = [];
const stock = installFakeStock();
// Provider stock VIDEO finto (coda vuota): il flusso video non tocca Magnific.
installFakeStockVideo();

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

after(async () => {
  for (const id of contentIds.splice(0)) {
    await prisma.content.deleteMany({ where: { id } }).catch(() => undefined);
  }
  setStockProvider(null);
  setImageProvider(null);
  resetStockVideo();
});

describe("createContentAction: risposta sempre strutturata, mai 500", () => {
  test("un payload malformato torna come { success: false, error } senza lanciare", async () => {
    const res = await createContentAction({ platforms: "INSTAGRAM" });
    assert.equal(res.ok, false);
    assert.equal(res.success, false);
    assert.equal(res.id, null);
    assert.ok(typeof res.error === "string" && res.error.length > 0);
    assert.ok(typeof res.message === "string" && res.message.length > 0);
  });

  test("un input non-oggetto (null, stringa) non crasha la action", async () => {
    for (const bad of [null, "x", 42, []]) {
      const res = await createContentAction(bad);
      assert.equal(res.success, false, `input ${JSON.stringify(bad)}`);
      assert.ok(typeof res.error === "string");
    }
  });

  test("un ID proposta inesistente è un errore dichiarato, non un 500", async () => {
    const res = await createContentAction({ proposalId: `inexistent-${uniq("id")}` });
    assert.equal(res.success, false);
    assert.equal(res.ok, false);
    assert.match(String(res.error), /proposta/i);
    assert.equal(res.id, null);
  });

  test("una creazione senza proposta riesce e risponde con success: true", async () => {
    const res = await createContentAction({
      title: `[TEST] ${uniq("action")}`,
      caption: "Caption di test",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(res.ok, true);
    assert.equal(res.success, true);
    assert.equal(res.error, null);
    assert.ok(typeof res.id === "string");
    if (typeof res.id === "string") contentIds.push(res.id);
  });
});

describe("createContent tool type VIDEO: pipeline completa end-to-end", () => {
  test('"crea video": bozza → fotogrammi stock → ffmpeg → asset VIDEO collegato', async () => {
    if (!(await isVideoGenerationAvailable())) return; // skip se ffmpeg manca
    const tool = getTool("createContent");
    assert.ok(tool);
    const result = await tool.execute({
      topic: "Sardegna",
      type: "VIDEO",
      title: "Sardegna, wild beauty",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(result.ok, true, result.ok ? "" : String(result.message));
    const data = result.data as {
      id: string;
      videoGenerated: boolean;
      videoUrl: string;
      videoAssetId: string;
      posterAssetId: string | null;
    };
    contentIds.push(data.id);

    // c) l'asset VIDEO generato è collegato alla bozza e il file esiste.
    assert.equal(data.videoGenerated, true);
    const videoOnDisk = path.join(process.cwd(), "public", data.videoUrl.replace(/^\//, ""));
    assert.ok((await fs.stat(videoOnDisk)).size > 0);

    const content = await prisma.content.findUnique({
      where: { id: data.id },
      include: { assets: true },
    });
    assert.equal(content?.type, "VIDEO");
    assert.equal(content?.status, "DRAFT");
    const videoAsset = content?.assets.find((a) => a.id === data.videoAssetId);
    assert.equal(videoAsset?.kind, "VIDEO");
    assert.equal(videoAsset?.contentId, data.id);
  });

  test("senza fotogrammi disponibili: errore REALE, nessuna bozza orfana", async () => {
    // La libreria stock è vuota (il fake risponde null) e nessun provider
    // immagini è configurato: il tool deve restituire l'errore vero, non un
    // ripiego su "caricalo a mano", e non deve lasciare bozze VIDEO vuote.
    // Il topic è volutamente senza senso: il fallback sulla Media Library
    // cerca per parole chiave su TUTTI gli asset esistenti (database condiviso
    // dalle altre suite) e un topic reale potrebbe matchare un leftover.
    stock.returnImage = false;
    // Niente nemmeno la generazione di fallback: il .env reale ha
    // IMAGE_PROVIDER=magnific, quindi senza questo override il fallback
    // genererebbe una foto reale (20-30s di API) e il tool riuscirebbe. Il
    // caso in test qui è "nessuna fonte di fotogrammi, in nessun gradino".
    const noGeneration: ImageProvider = {
      name: "fake-no-generation",
      canGenerate: false,
      async generateImage() {
        throw new Error("generazione non disponibile nel test");
      },
      async saveUploadedFile() {
        throw new Error("upload non disponibile nel test");
      },
    };
    setImageProvider(noGeneration);
    const markerTitle = `[TEST] ${uniq("novideo")}`;
    const tool = getTool("createContent");
    assert.ok(tool);
    const result = await tool.execute({
      topic: "Zzzqqq Xyzzy",
      type: "VIDEO",
      title: markerTitle,
      platforms: ["INSTAGRAM"],
    });

    stock.returnImage = true;
    setImageProvider(null); // si torna al provider da configurazione
    assert.equal(result.ok, false, "il fallimento è un esito dichiarato");
    assert.match(result.message, /Nessun video creato/);
    const data = result.data as { createdContentId: unknown; videoGenerated: boolean };
    assert.equal(data.createdContentId, null);
    assert.equal(data.videoGenerated, false);

    const leftovers = await prisma.content.count({ where: { title: markerTitle } });
    assert.equal(leftovers, 0, "nessun DRAFT VIDEO vuoto lasciato indietro");
  });
});
