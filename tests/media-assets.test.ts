import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import { createContent, deleteContent, getContent } from "../src/lib/services/content";
import {
  createAsset,
  deleteAsset,
  getAsset,
  linkAsset,
  listAssets,
  unlinkAssetFromContent,
} from "../src/lib/services/media";
import {
  linkAssetAction,
  unlinkAssetAction,
} from "../src/lib/actions/media";
import { deleteUploadedFile, saveUploadedFile, uploadedFileExists } from "../src/lib/uploads";

const contentIds: string[] = [];
const assetIds: string[] = [];
/** File creati dai test: spariscono con la cleanup, anche se un assert fallisce. */
const tempFileUrls: string[] = [];

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeContent(platforms: ("INSTAGRAM" | "FACEBOOK" | "TIKTOK")[] = ["INSTAGRAM"]) {
  const c = await createContent({
    title: `[TEST] ${uniq("media")}`,
    caption: "Caption di test",
    platforms,
  });
  contentIds.push(c.id);
  return c;
}

async function makeAsset(contentId?: string) {
  const name = uniq("file");
  const a = await createAsset({
    url: `/uploads/images/${name}.jpg`,
    filename: `${name}.jpg`,
    kind: "IMAGE",
    mimeType: "image/jpeg",
    contentId: contentId ?? null,
  });
  assetIds.push(a.id);
  return a;
}

async function cleanup() {
  for (const id of contentIds.splice(0)) {
    try {
      await deleteContent(id);
    } catch {
      /* già eliminato */
    }
  }
  for (const id of assetIds.splice(0)) {
    try {
      await deleteAsset(id);
    } catch {
      /* già eliminato */
    }
  }
  for (const url of tempFileUrls.splice(0)) {
    try {
      await deleteUploadedFile(url);
    } catch {
      /* già eliminato */
    }
  }
}

/** PNG 1x1 valido: il file su disco è quello che il test verifica. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function saveTempFile(originalName: string) {
  const saved = await saveUploadedFile({
    buffer: PNG_1PX,
    originalName,
    mimeType: "image/png",
  });
  tempFileUrls.push(saved.url);
  return saved;
}

before(async () => {
  await cleanup();
});

after(async () => {
  await cleanup();
});

/**
 * Vince la promise dell'action solo se si assesta entro il limite: se la
 * promise resta appesa (spinner infinito) il test fallisce.
 */
async function settlesWithin<T>(p: Promise<T>, ms: number, label: string) {
  const result = await Promise.race([
    p.then(
      (v) => ({ kind: "settled" as const, value: v }),
      (e) => ({ kind: "rejected" as const, error: e })
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), ms).unref?.()
    ),
  ]);
  assert.notEqual(
    result.kind,
    "timeout",
    `${label}: la promise non si è assestata entro ${ms}ms (spinner infinito)`
  );
  return result;
}

describe("Associazione asset ↔ contenuto", () => {
  test("1) createAsset senza contentId crea un asset non associato", async () => {
    const asset = await makeAsset();
    assert.equal(asset.contentId, null);

    const withContent = await getAsset(asset.id);
    assert.equal(withContent?.contentId, null);
    assert.equal(withContent?.content, null);
  });

  test("2) createAsset con contentId associa subito l'asset", async () => {
    const content = await makeContent();
    const asset = await makeAsset(content.id);
    assert.equal(asset.contentId, content.id);

    const loaded = await getContent(content.id);
    assert.equal(loaded?.assets.length, 1);
    assert.equal(loaded?.assets[0].id, asset.id);
  });

  test("3) linkAsset associa un asset esistente e restituisce il contenuto", async () => {
    const content = await makeContent();
    const asset = await makeAsset();

    const linked = await linkAsset(asset.id, content.id);
    assert.equal(linked.contentId, content.id);
    assert.equal(linked.content?.id, content.id);
    assert.equal(linked.content?.title, content.title);
  });

  test("4) listAssets({ contentId }) restituisce solo gli asset del contenuto", async () => {
    const mine = await makeContent();
    const other = await makeContent();
    const a1 = await makeAsset(mine.id);
    await makeAsset(mine.id);
    await makeAsset(other.id);

    const forMine = await listAssets({ contentId: mine.id });
    const ids = forMine.map((a) => a.id);
    assert.ok(ids.includes(a1.id));
    assert.equal(ids.length, 2);
  });

  test("5) listAssets({ linkedOnly }) esclude gli asset orfani", async () => {
    const content = await makeContent();
    const linked = await makeAsset(content.id);
    const orphan = await makeAsset();

    const all = await listAssets();
    const linkedOnly = await listAssets({ linkedOnly: true });
    const linkedIds = linkedOnly.map((a) => a.id);

    assert.ok(linkedIds.includes(linked.id));
    assert.ok(!linkedIds.includes(orphan.id));
    assert.ok(linkedOnly.length < all.length);
  });

  test("6) listAssets include la relazione content su ogni asset", async () => {
    const content = await makeContent();
    const linked = await makeAsset(content.id);
    const orphan = await makeAsset();

    const all = await listAssets();
    const byId = new Map(all.map((a) => [a.id, a]));

    assert.equal(byId.get(linked.id)?.content?.id, content.id);
    assert.equal(byId.get(linked.id)?.content?.status, "DRAFT");
    assert.equal(byId.get(orphan.id)?.content, null);
  });

  test("7) listAssets({ kind }) filtra per tipo", async () => {
    const image = await makeAsset();
    const videoName = uniq("clip");
    const video = await createAsset({
      url: `/uploads/videos/${videoName}.mp4`,
      filename: `${videoName}.mp4`,
      kind: "VIDEO",
    });
    assetIds.push(video.id);

    const videos = await listAssets({ kind: "VIDEO" });
    const videoIds = videos.map((a) => a.id);
    assert.ok(videoIds.includes(video.id));
    assert.ok(!videoIds.includes(image.id));
  });

  test("8) unlinkAssetFromContent stacca l'asset ma non elimina il file", async () => {
    const content = await makeContent();
    const asset = await makeAsset(content.id);

    const unlinked = await unlinkAssetFromContent(content.id, asset.id);
    assert.equal(unlinked.contentId, null);
    assert.equal(unlinked.content, null);

    const stillThere = await prisma.contentAsset.findUnique({
      where: { id: asset.id },
    });
    assert.ok(stillThere, "l'asset deve restare in Media Library");

    const reloadedContent = await getContent(content.id);
    assert.equal(reloadedContent?.assets.length, 0);
  });

  test("9) ricollegare lo stesso asset a un altro contenuto sposta l'associazione", async () => {
    const first = await makeContent();
    const second = await makeContent();
    const asset = await makeAsset(first.id);

    const moved = await linkAsset(asset.id, second.id);
    assert.equal(moved.contentId, second.id);

    const onFirst = await getContent(first.id);
    const onSecond = await getContent(second.id);
    assert.equal(onFirst?.assets.length, 0);
    assert.equal(onSecond?.assets.length, 1);
  });

  test("10) unlinkAssetFromContent su un asset senza contenuto è idempotente", async () => {
    const content = await makeContent();
    const asset = await makeAsset();
    const first = await unlinkAssetFromContent(content.id, asset.id);
    const second = await unlinkAssetFromContent(content.id, asset.id);
    assert.equal(first.contentId, null);
    assert.equal(second.contentId, null);
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: asset.id } }));
  });

  test("11) linkAsset verso un contenuto inesistente fallisce", async () => {
    const asset = await makeAsset();
    await assert.rejects(
      linkAsset(asset.id, "contenuto-che-non-esiste"),
      /non trovato/i
    );
    const unchanged = await getAsset(asset.id);
    assert.equal(unchanged?.contentId, null);
  });

  test("12) linkAsset su un asset inesistente fallisce", async () => {
    const content = await makeContent();
    await assert.rejects(linkAsset("asset-che-non-esiste", content.id), /non trovato/i);
  });

  test("13) createAsset verso un contenuto inesistente fallisce", async () => {
    await assert.rejects(
      createAsset({
        url: "/uploads/images/orfano.jpg",
        filename: "orfano.jpg",
        contentId: "contenuto-che-non-esiste",
      }),
      /non trovato/i
    );
  });

  test("14) createAsset rifiuta url o filename vuoti", async () => {
    await assert.rejects(createAsset({ url: "", filename: "x.jpg" }), /URL/);
    await assert.rejects(createAsset({ url: "/uploads/x.jpg", filename: "  " }), /Nome file/);
  });

  test("15) un contenuto con media li espone in getContent, uno senza li espone vuoto", async () => {
    const withMedia = await makeContent();
    await makeAsset(withMedia.id);
    const withoutMedia = await makeContent();

    const a = await getContent(withMedia.id);
    const b = await getContent(withoutMedia.id);
    assert.equal(a?.assets.length, 1);
    assert.equal(b?.assets.length, 0);
  });
});

describe("Warning media Instagram", () => {
  test("16) un contenuto INSTAGRAM senza media non ha media, un INSTAGRAM con media sì", async () => {
    const needsMedia = await makeContent(["INSTAGRAM"]);
    const ready = await makeContent(["INSTAGRAM"]);
    await makeAsset(ready.id);

    const needs = await getContent(needsMedia.id);
    const ok = await getContent(ready.id);

    assert.equal(
      needs?.assets.length === 0,
      true,
      "il caso da mostrare con warning è assets.length === 0"
    );
    assert.ok((ok?.assets.length ?? 0) > 0);
  });

  test("17) un contenuto non-Instagram senza media non è bloccato dal warning", async () => {
    const fb = await makeContent(["FACEBOOK"]);
    const loaded = await getContent(fb.id);
    const targetsInstagram = fb.platforms.some((p) => p.platform === "INSTAGRAM");
    assert.equal(targetsInstagram, false);
    assert.equal(loaded?.assets.length, 0);
  });
});

/**
 * Regressione: la UI restava in caricamento infinito perché lo stato di
 * loading dipendeva dalla promise della server action. Qui si verifica che la
 * promise dell'action termini SEMPRE (risolve o rifiuta, mai appesa) e che
 * l'associazione venga persistata.
 */
describe("Le server action di associazione terminano sempre", () => {
  test("18) linkAssetAction assesta la promise e salva l'associazione", async () => {
    const content = await makeContent();
    const asset = await makeAsset();

    const out = await settlesWithin(
      linkAssetAction({ assetId: asset.id, contentId: content.id }),
      10_000,
      "linkAssetAction"
    );
    assert.notEqual(out.kind, "rejected", "linkAssetAction non deve rifiutare");

    // L'associazione deve essere persistata indipendentemente dall'esito.
    const reloaded = await getAsset(asset.id);
    assert.equal(reloaded?.contentId, content.id);
  });

  test("19) linkAssetAction con input non valido assesta la promise con ok=false", async () => {
    const out = await settlesWithin(
      linkAssetAction({ assetId: "", contentId: "" }),
      10_000,
      "linkAssetAction (input non valido)"
    );
    assert.equal(out.kind, "settled");
    if (out.kind === "settled") {
      assert.equal(out.value.ok, false);
      assert.ok((out.value as { message?: string }).message);
    }
  });

  test("20) linkAssetAction verso un contenuto inesistente assesta la promise", async () => {
    const asset = await makeAsset();
    const out = await settlesWithin(
      linkAssetAction({ assetId: asset.id, contentId: "contenuto-inesistente" }),
      10_000,
      "linkAssetAction (contenuto inesistente)"
    );
    assert.equal(out.kind, "settled");
    if (out.kind === "settled") {
      assert.equal(out.value.ok, false);
    }
    const unchanged = await getAsset(asset.id);
    assert.equal(unchanged?.contentId, null);
  });

  test("21) unlinkAssetAction assesta la promise e stacca l'asset", async () => {
    const content = await makeContent();
    const asset = await makeAsset(content.id);

    const out = await settlesWithin(
      unlinkAssetAction({ contentId: content.id, assetId: asset.id }),
      10_000,
      "unlinkAssetAction"
    );
    assert.notEqual(out.kind, "rejected", "unlinkAssetAction non deve rifiutare");

    const reloaded = await getAsset(asset.id);
    assert.equal(reloaded?.contentId, null);
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: asset.id } }));
  });

  test("22) unlinkAssetAction su asset inesistente assesta la promise con ok=false", async () => {
    const content = await makeContent();
    const out = await settlesWithin(
      unlinkAssetAction({ contentId: content.id, assetId: "asset-inesistente" }),
      10_000,
      "unlinkAssetAction (asset inesistente)"
    );
    assert.equal(out.kind, "settled");
    if (out.kind === "settled") {
      assert.equal(out.value.ok, false);
    }
  });

  test("23) il servizio linkAsset assesta la promise (CRUD veloce, nessun lock)", async () => {
    const content = await makeContent();
    const asset = await makeAsset();
    const started = Date.now();
    const out = await settlesWithin(
      linkAsset(asset.id, content.id),
      10_000,
      "linkAsset (servizio)"
    );
    assert.equal(out.kind, "settled");
    assert.ok(
      Date.now() - started < 10_000,
      "l'associazione non deve essere un'operazione lunga"
    );
    if (out.kind === "settled") {
      assert.equal(out.value.contentId, content.id);
    }
  });
});

/**
 * Separazione netta tra le due operazioni:
 *  - unlink  = rimuove SOLO la relazione (non distruttivo)
 *  - delete  = elimina l'asset e il file fisico (distruttivo)
 */
describe("unlink non distruttivo vs delete distruttivo", () => {
  test("TEST 1) unlink: il Content perde l'Asset, l'Asset resta in Media Library", async () => {
    const content = await makeContent();
    const asset = await makeAsset();
    await linkAsset(asset.id, content.id);

    // Precondizione: associata.
    assert.equal((await getContent(content.id))?.assets.length, 1);

    const unlinked = await unlinkAssetFromContent(content.id, asset.id);

    // 1) il Content non ha più l'Asset
    assert.equal(unlinked.contentId, null);
    assert.equal((await getContent(content.id))?.assets.length, 0);

    // 2) l'Asset esiste ancora nel database
    const row = await prisma.contentAsset.findUnique({ where: { id: asset.id } });
    assert.ok(row, "unlink NON deve cancellare il record Asset");
    assert.equal(row?.contentId, null);
    assert.equal(row?.url, asset.url, "il file conserva l'URL in /public/uploads");
    assert.equal(row?.filename, asset.filename);

    // 3) l'Asset continua ad apparire in Media Library, come "Non associato"
    const library = await listAssets();
    const inLibrary = library.find((a) => a.id === asset.id);
    assert.ok(inLibrary, "l'asset deve restare visibile in Media Library");
    assert.equal(inLibrary?.contentId, null);
    assert.equal(inLibrary?.content, null, "deve apparire come Non associato");
  });

  test("TEST 2) dopo unlink lo stesso Asset si ricollega a un altro Content", async () => {
    const first = await makeContent();
    const second = await makeContent();
    const asset = await makeAsset(first.id);

    await unlinkAssetFromContent(first.id, asset.id);
    assert.equal((await getContent(first.id))?.assets.length, 0);
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: asset.id } }));

    const relinked = await linkAsset(asset.id, second.id);
    assert.equal(relinked.contentId, second.id);
    assert.equal((await getContent(second.id))?.assets.length, 1);
    assert.equal((await getContent(first.id))?.assets.length, 0);
  });

  test("TEST 3) deleteAsset elimina realmente l'Asset (operazione distruttiva)", async () => {
    const content = await makeContent();
    const asset = await makeAsset(content.id);
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: asset.id } }));

    await deleteAsset(asset.id);

    assert.equal(
      await prisma.contentAsset.findUnique({ where: { id: asset.id } }),
      null,
      "deleteAsset DEVE rimuovere il record Asset"
    );
    const library = await listAssets();
    assert.ok(
      !library.some((a) => a.id === asset.id),
      "l'asset non deve più comparire in Media Library"
    );
  });

  test("TEST 4) l'operazione unlink assesta la promise e non lascia loading", async () => {
    const content = await makeContent();
    const asset = await makeAsset(content.id);

    // Via servizio
    const viaService = await settlesWithin(
      unlinkAssetFromContent(content.id, asset.id),
      10_000,
      "unlinkAssetFromContent (servizio)"
    );
    assert.equal(viaService.kind, "settled");
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: asset.id } }));

    // Via server action (quello che chiama la UI)
    await linkAsset(asset.id, content.id);
    const viaAction = await settlesWithin(
      unlinkAssetAction({ contentId: content.id, assetId: asset.id }),
      10_000,
      "unlinkAssetAction"
    );
    assert.notEqual(viaAction.kind, "rejected", "la action non deve rifiutare");
    assert.ok(
      await prisma.contentAsset.findUnique({ where: { id: asset.id } }),
      "dopo l'unlink l'asset deve esistere ancora"
    );
    assert.equal((await getAsset(asset.id))?.contentId, null);
  });

  test("TEST 5) unlink con un contentId sbagliato non tocca l'associazione", async () => {
    const real = await makeContent();
    const other = await makeContent();
    const asset = await makeAsset(real.id);

    await assert.rejects(
      unlinkAssetFromContent(other.id, asset.id),
      /non è associato al contenuto corrente/i
    );

    // L'associazione col contenuto reale è intatta.
    assert.equal((await getAsset(asset.id))?.contentId, real.id);
    assert.equal((await getContent(real.id))?.assets.length, 1);
  });
});

/**
 * Ciclo di vita del FILE fisico.
 *
 * La riga `ContentAsset` sparisce con il cascade quando il contenuto viene
 * eliminato: senza un cleanup esplicito il file resta orfano in
 * `/public/uploads` e non è più raggiungibile da nessuna parte. I test
 * verificano il file su disco, non solo il database.
 */
describe("deleteContent e file fisici in /public/uploads", () => {
  test("1) elimina anche il file dell'asset, non solo la riga", async () => {
    const content = await makeContent();
    const saved = await saveTempFile(`leak-${uniq("own")}.png`);
    assert.equal(await uploadedFileExists(saved.url), true, "precondizione: file su disco");

    const asset = await createAsset({
      url: saved.url,
      filename: saved.pathname.split(/[\\/]/).pop()!,
      mimeType: saved.mimeType,
      kind: "IMAGE",
      contentId: content.id,
    });
    assetIds.push(asset.id);

    await deleteContent(content.id);

    assert.equal(
      await prisma.contentAsset.findUnique({ where: { id: asset.id } }),
      null,
      "la riga asset sparisce col cascade"
    );
    assert.equal(
      await uploadedFileExists(saved.url),
      false,
      "il file non deve restare orfano in /public/uploads"
    );
  });

  test("2) NON cancella un file condiviso con un altro contenuto", async () => {
    // È il caso della duplicazione: le righe asset sono copiate, il file no.
    const first = await makeContent();
    const second = await makeContent();
    const saved = await saveTempFile(`leak-${uniq("shared")}.png`);
    const filename = saved.pathname.split(/[\\/]/).pop()!;

    const a1 = await createAsset({
      url: saved.url,
      filename,
      mimeType: saved.mimeType,
      kind: "IMAGE",
      contentId: first.id,
    });
    const a2 = await createAsset({
      url: saved.url,
      filename,
      mimeType: saved.mimeType,
      kind: "IMAGE",
      contentId: second.id,
    });
    assetIds.push(a1.id, a2.id);

    await deleteContent(first.id);

    assert.equal(
      await uploadedFileExists(saved.url),
      true,
      "il file serve ancora al secondo contenuto"
    );
    const survivor = await prisma.contentAsset.findUnique({ where: { id: a2.id } });
    assert.equal(survivor?.contentId, second.id);
  });

  test("3) NON cancella un file ancora in Media Library come non associato", async () => {
    const content = await makeContent();
    const saved = await saveTempFile(`leak-${uniq("unlinked")}.png`);
    const asset = await createAsset({
      url: saved.url,
      filename: saved.pathname.split(/[\\/]/).pop()!,
      mimeType: saved.mimeType,
      kind: "IMAGE",
      contentId: content.id,
    });
    assetIds.push(asset.id);

    // L'unlink è non distruttivo: l'asset torna "Non associato" e il file
    // deve continuare a esistere anche quando il contenuto sparisce.
    await unlinkAssetFromContent(content.id, asset.id);
    await deleteContent(content.id);

    assert.equal(
      await uploadedFileExists(saved.url),
      true,
      "un asset non associato resta proprietario del proprio file"
    );
    assert.equal((await getAsset(asset.id))?.contentId, null);
  });

  test("4) non fallisce se il file è già sparito dal disco", async () => {
    const content = await makeContent();
    const saved = await saveTempFile(`leak-${uniq("gone")}.png`);
    const asset = await createAsset({
      url: saved.url,
      filename: saved.pathname.split(/[\\/]/).pop()!,
      mimeType: saved.mimeType,
      kind: "IMAGE",
      contentId: content.id,
    });
    assetIds.push(asset.id);

    await deleteUploadedFile(saved.url);
    assert.equal(await uploadedFileExists(saved.url), false, "precondizione: file assente");

    // La cancellazione del contenuto deve restare riuscita: un file mancante
    // è uno stato legittimo, non un errore da propagare all'utente.
    await deleteContent(content.id);
    assert.equal(await getContent(content.id), null);
  });

  test("5) ignora url non locali", async () => {
    const content = await makeContent();
    const asset = await createAsset({
      url: "https://example.com/img/remote-official.jpg",
      filename: "remote-official.jpg",
      mimeType: "image/jpeg",
      kind: "IMAGE",
      contentId: content.id,
    });
    assetIds.push(asset.id);

    // Nessun errore e nessun tentativo di scrivere fuori da /uploads.
    await deleteContent(content.id);
    assert.equal(await getContent(content.id), null);
  });
});
