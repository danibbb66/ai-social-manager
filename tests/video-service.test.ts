import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { createContent, deleteContent, getContent } from "../src/lib/services/content";
import type { MontageClip, VideoProvider } from "../src/lib/video/provider";
import {
  collectVideoFrameSources,
  ensureVideoPoster,
  generateVideoForContent,
} from "../src/lib/services/video";
import { installFakeStockVideo, resetStockVideo } from "./helpers/stock-video";
import { videoSearch } from "../src/lib/ai/travel-knowledge";

// Provider stock video finto (coda vuota): nessuna chiamata a Magnific nei
// test. La query "Sardegna" di un test non deve toccare la rete.
const stockVideo = installFakeStockVideo();

const contentIds: string[] = [];
/** Asset IMAGE di libreria creati dal test: spariscono con la cleanup. */
const assetCleanup: string[] = [];
/** File finti scritti su disco per i fotogrammi: spariscono con la cleanup. */
const tempFilePaths: string[] = [];

async function writeFakeUpload(relativeUrl: string): Promise<string> {
  const filepath = path.join(process.cwd(), "public", relativeUrl);
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, Buffer.from("fake-image-bytes"));
  tempFilePaths.push(filepath);
  return relativeUrl;
}

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeContent(opts?: {
  slides?: { imageUrl?: string | null; text?: string }[];
  caption?: string;
}) {
  const c = await createContent({
    type: opts?.slides ? "CAROUSEL" : "POST",
    title: `[TEST] ${uniq("video")}`,
    caption: opts?.caption ?? "Caption di test",
    platforms: ["INSTAGRAM"],
    slides: opts?.slides,
  });
  contentIds.push(c.id);
  return c;
}

async function cleanup() {
  for (const id of contentIds.splice(0)) {
    try {
      await deleteContent(id);
    } catch {
      /* già eliminato */
    }
  }
}

after(async () => {
  await cleanup();
  for (const id of assetCleanup.splice(0)) {
    await prisma.contentAsset.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const filepath of tempFilePaths.splice(0)) {
    await fs.rm(filepath, { force: true }).catch(() => undefined);
  }
  resetStockVideo();
});

describe("collectVideoFrameSources", () => {
  test("le slide con immagine vengono prima degli asset IMAGE", async () => {
    const content = await makeContent({
      slides: [{ imageUrl: `/uploads/images/${uniq("slide")}.jpg` }],
    });
    await prisma.contentAsset.create({
      data: {
        kind: "IMAGE",
        contentId: content.id,
        url: `/uploads/images/${uniq("asset")}.jpg`,
        filename: "asset.jpg",
      },
    });
    const sources = await collectVideoFrameSources(content.id);
    assert.equal(sources.length, 2);
    assert.equal(sources[0].origin, "slide");
    assert.equal(sources[1].origin, "asset");
  });

  test("un contenuto senza immagini non ha fotogrammi", async () => {
    const content = await makeContent();
    const sources = await collectVideoFrameSources(content.id);
    assert.equal(sources.length, 0);
  });
});

describe("ensureVideoPoster", () => {
  test("un contenuto con già un asset IMAGE non riceve nessuna riga nuova", async () => {
    const content = await makeContent();
    await prisma.contentAsset.create({
      data: {
        kind: "IMAGE",
        contentId: content.id,
        url: `/uploads/images/${uniq("present")}.jpg`,
        filename: "present.jpg",
      },
    });
    const before = await prisma.contentAsset.count({ where: { contentId: content.id } });
    const result = await ensureVideoPoster(content.id);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.created, false);
    const after = await prisma.contentAsset.count({ where: { contentId: content.id } });
    assert.equal(after, before);
  });

  test("la locandina nasce dalla prima immagine delle slide", async () => {
    const url = `/uploads/images/${uniq("poster")}.jpg`;
    const content = await makeContent({ slides: [{ imageUrl: url }] });
    const result = await ensureVideoPoster(content.id);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.created, true);
    const asset = await prisma.contentAsset.findUnique({ where: { id: result.assetId } });
    assert.equal(asset?.kind, "IMAGE");
    assert.equal(asset?.url, url);
    const metadata = asset?.metadata as { role?: string } | null;
    assert.equal(metadata?.role, "POSTER");
  });

  test("senza nessuna immagine la locandina non viene inventata", async () => {
    const content = await makeContent();
    const result = await ensureVideoPoster(content.id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason.length > 0);
  });
});

describe("generateVideoForContent", () => {
  test("genera con un provider iniettabile, collega l'asset VIDEO e la locandina", async () => {
    // Il servizio verifica che i fotogrammi locali esistano davvero: il file
    // di prova va scritto sul disco, non basta un URL inventato.
    const slideUrl = await writeFakeUpload(`/uploads/images/${uniq("frame")}.jpg`);
    const content = await makeContent({ slides: [{ imageUrl: slideUrl }] });
    // Anche il video prodotto deve esistere davvero: il servizio verifica il
    // file di output prima di scrivere l'asset, quindi lo stub lo crea.
    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("reel")}.mp4`);
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow(slides) {
        // Il montaggio copre 15-20s: con un solo fotogramma sono 5 scene da
        // 3s (riciclo della copertina, Ken Burns alternato lato provider).
        assert.equal(slides.length, 5);
        assert.equal(slides[0].imagePath, slideUrl);
        assert.ok(slides.every((s) => s.durationSec === 3));
        return {
          url: videoUrl,
          provider: "fake",
          pathname: videoUrl,
          durationSec: 15,
        };
      },
    };

    const result = await generateVideoForContent({ contentId: content.id, provider });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const fresh = await getContent(content.id);
    assert.equal(fresh?.type, "VIDEO");
    const videoAsset = fresh?.assets.find((a) => a.id === result.assetId);
    assert.equal(videoAsset?.kind, "VIDEO");
    assert.equal(result.posterAssetId != null, true);
  });

  test("il provider dichiara successo ma il file non esiste: niente asset, niente tipo VIDEO", async () => {
    // La classe di bug da evitare: asset VIDEO che punta a un file assente,
    // bozza che sembra "completata con video". Il servizio verifica il file
    // PRIMA di scrivere qualsiasi riga nel database.
    const slideUrl = await writeFakeUpload(`/uploads/images/${uniq("missing-after")}.jpg`);
    const content = await makeContent({ slides: [{ imageUrl: slideUrl }] });
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        return {
          url: `/uploads/videos/${uniq("fantasma")}.mp4`,
          provider: "fake",
          pathname: "fantasma",
          durationSec: 3,
        };
      },
    };

    const result = await generateVideoForContent({ contentId: content.id, provider });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /non ha prodotto un file utilizzabile/);

    const fresh = await getContent(content.id);
    assert.equal(fresh?.type, "CAROUSEL", "il tipo non deve cambiare su fallimento");
    assert.equal(
      (await prisma.contentAsset.count({ where: { contentId: content.id, kind: "VIDEO" } })),
      0,
      "nessun asset VIDEO deve esistere dopo un fallimento"
    );
  });

  test("il provider che lancia: nessun asset VIDEO e tipo invariato", async () => {
    const slideUrl = await writeFakeUpload(`/uploads/images/${uniq("boom")}.jpg`);
    const content = await makeContent({ slides: [{ imageUrl: slideUrl }] });
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        throw new Error("ffmpeg terminato con codice 1: input corrotto");
      },
    };

    const result = await generateVideoForContent({ contentId: content.id, provider });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /ffmpeg terminato/);

    const fresh = await getContent(content.id);
    assert.equal(fresh?.type, "CAROUSEL");
    assert.equal(
      (await prisma.contentAsset.count({ where: { contentId: content.id, kind: "VIDEO" } })),
      0
    );
  });

  test("la Media Library arricchisce lo slideshow: un solo frame → più scene", async () => {
    // Un reel con un solo fotogramma è una foto ferma: le immagini pertinenti
    // in libreria (ricerca per token sulla query) diventano scene aggiuntive.
    const slideUrl = await writeFakeUpload(`/uploads/images/${uniq("frame")}.jpg`);
    const content = await makeContent({ slides: [{ imageUrl: slideUrl }] });

    const extraIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const fileUrl = await writeFakeUpload(`/uploads/images/sardegna-${uniq("lib")}.jpg`);
      const asset = await prisma.contentAsset.create({
        data: {
          kind: "IMAGE",
          url: fileUrl,
          filename: `sardegna-${uniq("lib")}.jpg`,
          metadata: { query: "Sardegna" },
        },
      });
      extraIds.push(asset.id);
    }
    assetCleanup.push(...extraIds);

    // Anche l'output deve esistere: il servizio verifica il file prima di
    // scrivere l'asset, quindi lo stub lo crea.
    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("reel")}.mp4`);
    const seen: number[] = [];
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow(slides) {
        seen.push(slides.length);
        // 1 copertina + 2 pulite → il piano arriva a 5 scene (15s) riciclando
        // le pulite, senza mai riproporre la copertina dopo la prima scena.
        assert.equal(slides.length, 5);
        assert.equal(slides[0].imagePath, slideUrl);
        assert.doesNotMatch(slides.slice(1).map((s) => s.imagePath).join("|"), new RegExp(slideUrl.replace(/[.\\]/g, "\\$&")));
        assert.ok(slides.every((s) => s.durationSec === 3));
        return {
          url: videoUrl,
          provider: "fake",
          pathname: videoUrl,
          durationSec: slides.length * 3,
        };
      },
    };

    const result = await generateVideoForContent({
      contentId: content.id,
      query: "Sardegna",
      provider,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [5]);
  });

  test("clip video reali: montaggio con tagli e overlay solo in copertina", async () => {
    const slideUrl = await writeFakeUpload(`/uploads/images/${uniq("cover")}.jpg`);
    const content = await makeContent({ slides: [{ imageUrl: slideUrl }] });
    // Una clip video reale (file esistente) collegata al contenuto: il piano
    // deve usare il montaggio, non lo slideshow a immagini.
    const clipUrl = await writeFakeUpload(`/uploads/videos/${uniq("clip")}.mp4`);
    await prisma.contentAsset.create({
      data: { kind: "VIDEO", contentId: content.id, url: clipUrl, filename: "clip.mp4" },
    });

    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("montage")}.mp4`);
    // Holder esplicito: il narrowing di TS su una variabile assegnata solo in
    // callback la ridurrebbe a `never` dopo il guard.
    const capturedHolder: { clips: MontageClip[] | null } = { clips: null };
    let slideshowCalled = false;
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        slideshowCalled = true;
        throw new Error("lo slideshow non deve essere usato con clip video reali");
      },
      async generateMontage(clips) {
        capturedHolder.clips = clips;
        return { url: videoUrl, provider: "fake", pathname: videoUrl, durationSec: 15 };
      },
    };

    const result = await generateVideoForContent({ contentId: content.id, provider });
    assert.equal(result.ok, true);
    const captured = capturedHolder.clips as MontageClip[] | null;
    assert.ok(captured, "generateMontage deve essere invocato");
    if (!captured) return;

    // Copertina: una CLIP VIDEO (non una foto zoomata), con l'overlay
    // (titolo/logo) SOLO qui. Quando esistono clip reali, il reel non parte
    // mai da un fermo immagine.
    assert.equal(captured[0].type, "video");
    assert.ok(captured[0].overlay, "la copertina porta l'overlay");
    assert.ok(captured.slice(1).every((c) => !c.overlay), "nessun overlay dopo la copertina");
    // Tutte le scene sono clip video vere, tagliate dal montaggio.
    assert.ok(captured.every((c) => c.type === "video"), "niente foto nel montaggio con clip video");
    // Finestra di durata 15-20s rispettata dal piano.
    const total = captured.reduce((a, c) => a + c.sceneSeconds, 0);
    assert.ok(total >= 15 && total <= 20, `durata pianificata ${total}s fuori dalla finestra`);
    assert.equal(slideshowCalled, false);
  });

  test("ricerca stock video: il provider è interpellato prima e la libreria vuota non blocca", async () => {
    // Contenuto SENZA immagini né slide: la copertina verrà dalla prima clip
    // stock, e la Media Library vuota non deve fermare nulla.
    const content = await makeContent();
    // 5 clip distinte: il montaggio ora chiede 5 clip per alternare altrettanti
    // luoghi senza ripetere la stessa ripresa (cover + 4 distinte = 5 scene).
    // Titoli DISTINTI (come i provider reali, che restituiscono alt testuali
    // descrittivi e non la stessa parola ripetuta): la dedup per soggetti non
    // deve scartare clip diverse con lo stesso nome di destinazione.
    stockVideo.queue = [
      { provider: "fake-stock-video", sourceUrl: "https://cdn.freepik.com/v1.mp4", alternateUrls: [], pageUrl: null, resourceId: 1, title: "white sand beach aerial view" },
      { provider: "fake-stock-video", sourceUrl: "https://cdn.freepik.com/v2.mp4", alternateUrls: [], pageUrl: null, resourceId: 2, title: "coral reef snorkeling underwater" },
      { provider: "fake-stock-video", sourceUrl: "https://cdn.freepik.com/v3.mp4", alternateUrls: [], pageUrl: null, resourceId: 3, title: "colorful street market old town" },
      { provider: "fake-stock-video", sourceUrl: "https://cdn.freepik.com/v4.mp4", alternateUrls: [], pageUrl: null, resourceId: 4, title: "dhow boat sailing at sunset" },
      { provider: "fake-stock-video", sourceUrl: "https://cdn.freepik.com/v5.mp4", alternateUrls: [], pageUrl: null, resourceId: 5, title: "lighthouse on the rocky coast" },
    ];

    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("montage")}.mp4`);
    const capturedHolder: { clips: MontageClip[] | null } = { clips: null };
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        throw new Error("non deve usare lo slideshow con clip stock");
      },
      async generateMontage(clips) {
        capturedHolder.clips = clips;
        return { url: videoUrl, provider: "fake", pathname: videoUrl, durationSec: 15 };
      },
    };

    // "Atlantide" è una destinazione NON curata: `landmarkQueries` restituisce
    // `[]` e la ricerca usa il solo nome, così il test verifica la query esatta
    // senza l'interferenza dei luoghi iconici (che avrebbe una destinazione
    // curata come Bali/Thailandia).
    const result = await generateVideoForContent({ contentId: content.id, query: "Atlantide", provider });
    assert.equal(result.ok, true);
    // Il provider stock è stato interpellato con la query ESATTA dell'utente.
    assert.ok(stockVideo.hits.includes("Atlantide"), `query ricevute: ${stockVideo.hits.join(",")}`);

    const captured = capturedHolder.clips as MontageClip[] | null;
    assert.ok(captured && captured.length >= 5, "montaggio completo");
    if (!captured) return;
    // Senza immagine di copertina: la prima clip è un VIDEO con l'overlay, le
    // successive pulite.
    assert.equal(captured[0].type, "video");
    assert.ok(captured[0].overlay, "titolo e logo solo sulla copertina");
    assert.ok(captured.slice(1).every((c) => !c.overlay), "nessun overlay dopo la copertina");
    const total = captured.reduce((a, c) => a + c.sceneSeconds, 0);
    assert.ok(total >= 15 && total <= 20, `durata ${total}s fuori dalla finestra`);
  });

  test("clip quasi-identiche (stesso soggetto) vengono scartate: niente tre canoa uguali", async () => {
    const content = await makeContent();
    stockVideo.queue = [
      { provider: "fake-stock-video", sourceUrl: `https://cdn.freepik.com/${uniq("canoe")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 11, title: "person canoeing in the ocean" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.freepik.com/${uniq("canoe")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 12, title: "tourist paddling a canoe at sunset" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.freepik.com/${uniq("canoe")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 13, title: "a canoe in the clear sea" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.freepik.com/${uniq("reef")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 14, title: "coral reef snorkeling underwater" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.freepik.com/${uniq("town")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 15, title: "colorful street market old town" },
    ];

    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("montage")}.mp4`);
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        throw new Error("non deve usare lo slideshow con clip stock");
      },
      async generateMontage() {
        return { url: videoUrl, provider: "fake", pathname: videoUrl, durationSec: 15 };
      },
    };

    // "Narnia" è non curata: la query usa il solo nome e la dedup lavora solo
    // sui soggetti dei titoli, senza interferenza dei luoghi iconici.
    const result = await generateVideoForContent({ contentId: content.id, query: "Narnia", provider });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Solo 3 soggetti distinti accettati: canoa (una volta), barriera corallina
    // e mercato. Le altre due canoa sono state scartate come quasi-duplicati.
    const asset = await prisma.contentAsset.findUnique({ where: { id: result.assetId } });
    const meta = (asset?.metadata ?? {}) as { stockSourceUrls?: string[] };
    const urls = meta.stockSourceUrls ?? [];
    assert.equal(urls.length, 3, `attese 3 clip distinte, ricevute: ${urls.join(",")}`);
    assert.equal(
      urls.filter((u) => u.includes("canoe")).length,
      1,
      "una sola clip canoa: le altre due erano quasi-duplicati"
    );
  });

  test("clip della stessa destinazione (stesso Paese) non sono quasi-duplicati", async () => {
    const content = await makeContent();
    // Tutte condividono "netherlands" (nome del Paese) e "amsterdam" (nome
    // città): prima del fix il Paese contava come "soggetto distintivo" e la
    // seconda clip in poi veniva scartata, lasciando il reel con 1-2 scene sole.
    stockVideo.queue = [
      { provider: "fake-stock-video", sourceUrl: `https://cdn.pixabay.com/${uniq("canals")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 31, title: "netherlands amsterdam canals" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.pixabay.com/${uniq("rijksmuseum")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 32, title: "netherlands rijksmuseum amsterdam" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.pixabay.com/${uniq("jordaan")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 33, title: "netherlands jordaan amsterdam" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.pixabay.com/${uniq("windmills")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 34, title: "netherlands zaanse schans windmills" },
      { provider: "fake-stock-video", sourceUrl: `https://cdn.pixabay.com/${uniq("bicycles")}.mp4`, alternateUrls: [], pageUrl: null, resourceId: 35, title: "netherlands amsterdam bicycles" },
    ];

    const videoUrl = await writeFakeUpload(`/uploads/videos/${uniq("montage")}.mp4`);
    const provider: VideoProvider = {
      name: "fake",
      canGenerate: true,
      async generateSlideshow() {
        throw new Error("non deve usare lo slideshow con clip stock");
      },
      async generateMontage() {
        return { url: videoUrl, provider: "fake", pathname: videoUrl, durationSec: 15 };
      },
    };

    const result = await generateVideoForContent({ contentId: content.id, query: "amsterdam", provider });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const asset = await prisma.contentAsset.findUnique({ where: { id: result.assetId } });
    const meta = (asset?.metadata ?? {}) as { stockSourceUrls?: string[] };
    const urls = meta.stockSourceUrls ?? [];
    assert.equal(urls.length, 5, `attese 5 clip distinte, ricevute: ${urls.join(",")}`);
  });

  test("senza fotogrammi la generazione non parte e il motivo è dichiarato", async () => {
    const content = await makeContent();
    const result = await generateVideoForContent({
      contentId: content.id,
      provider: {
        name: "fake",
        canGenerate: true,
        async generateSlideshow() {
          throw new Error("non deve essere chiamato");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason.includes("Nessuna clip video né immagine"));
  });
});

describe("videoSearch: query stock in inglese", () => {
  test("una destinazione curata risolve il nome inglese", () => {
    assert.equal(videoSearch("atene")?.name, "athens");
    assert.equal(videoSearch("amsterdam")?.name, "amsterdam");
    assert.ok(videoSearch("atene")?.landmarks.includes("athens acropolis"));
  });

  test("una destinazione non curata restituisce null", () => {
    assert.equal(videoSearch("atlantide"), null);
    assert.equal(videoSearch("narnia"), null);
  });

  test("l'alias italiano risolve alla voce curata", () => {
    assert.equal(videoSearch("new york")?.name, "new york");
  });
});
