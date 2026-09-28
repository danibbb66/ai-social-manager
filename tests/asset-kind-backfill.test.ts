import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  findMisclassifiedVideoAssets,
  fixMisclassifiedVideoAssets,
} from "../prisma/fix-asset-kind";

/**
 * Verifica della correzione dati degli asset video caricati prima della
 * classificazione automatica (quando kind era sempre IMAGE).
 *
 * I fixture riproducono lo stato legacy: kind = IMAGE con mimeType video.
 * Nessun file fisico viene toccato: si creano solo righe di database.
 */

const fixtureIds = new Set<string>();

function uniq(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeAsset(input: {
  filename: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  mimeType: string | null;
  folder?: string;
}) {
  const name = uniq(input.filename);
  const asset = await prisma.contentAsset.create({
    data: {
      kind: input.kind,
      mimeType: input.mimeType,
      filename: name,
      url: `/uploads/${input.folder ?? "files"}/${name}`,
      size: 2048,
      contentId: null,
    },
  });
  fixtureIds.add(asset.id);
  return asset;
}

async function cleanupFixtures() {
  for (const id of fixtureIds) {
    await prisma.contentAsset.deleteMany({ where: { id } }).catch(() => {});
  }
  fixtureIds.clear();
}

/** Rimuove subito un fixture per non lasciare stato sporco ai test successivi. */
async function dropFixture(id: string) {
  await prisma.contentAsset.deleteMany({ where: { id } });
  fixtureIds.delete(id);
}

before(async () => {
  await cleanupFixtures();
});

after(async () => {
  // La garanzia "nessun asset non-video modificato" e' verificata test per
  // test sui fixture di questo file (casi 4, 5, 6 e 7), non con un confronto
  // dell'intera tabella: node:test esegue i file in parallelo e gli altri test
  // creano ed eliminano asset sullo stesso database, quindi un confronto
  // globale sarebbe inaffidabile.
  await cleanupFixtures();
});

describe("Correzione kind IMAGE -> VIDEO per i video mal classificati", () => {
  test("1) un video con kind IMAGE viene corretto in VIDEO", async () => {
    const legacy = await makeAsset({
      filename: "legacy.mp4",
      kind: "IMAGE",
      mimeType: "video/mp4",
      folder: "videos",
    });
    assert.equal(legacy.kind, "IMAGE", "precondizione: asset legacy");

    const result = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(result.candidates, 1);
    assert.equal(result.fixed, 1);
    assert.equal(result.dryRun, false);

    const fixed = await prisma.contentAsset.findUnique({ where: { id: legacy.id } });
    assert.equal(fixed?.kind, "VIDEO");
  });

  test("2) vengono corretti tutti i formati video, non solo mp4", async () => {
    for (const mime of ["video/webm", "video/quicktime", "video/x-matroska", "VIDEO/M4V"]) {
      await makeAsset({ filename: `legacy-${uniq("x")}`, kind: "IMAGE", mimeType: mime, folder: "videos" });
    }

    const result = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(result.candidates, 4);
    assert.equal(result.fixed, 4);

    const remaining = await findMisclassifiedVideoAssets(prisma);
    assert.equal(remaining.length, 0);
  });

  test("3) il dry-run individua i candidati senza scrivere", async () => {
    const legacy = await makeAsset({
      filename: "dryrun.mp4",
      kind: "IMAGE",
      mimeType: "video/mp4",
      folder: "videos",
    });

    const result = await fixMisclassifiedVideoAssets(prisma, { dryRun: true });
    assert.equal(result.candidates, 1);
    assert.equal(result.fixed, 0, "il dry-run non deve correggere nulla");
    assert.equal(result.rows[0].id, legacy.id);

    const untouched = await prisma.contentAsset.findUnique({ where: { id: legacy.id } });
    assert.equal(untouched?.kind, "IMAGE", "il dry-run non deve scrivere sul database");

    // Il fixture resta incoerente di proposito: va rimosso qui, altrimenti
    // falserebbe il conteggio dei candidati nei test successivi.
    await dropFixture(legacy.id);
  });

  test("4) immagini, audio e documenti non vengono toccati", async () => {
    const image = await makeAsset({ filename: "foto.jpg", kind: "IMAGE", mimeType: "image/jpeg", folder: "images" });
    const audio = await makeAsset({ filename: "voce.mp3", kind: "AUDIO", mimeType: "audio/mpeg", folder: "files" });
    const doc = await makeAsset({ filename: "brief.pdf", kind: "FILE", mimeType: "application/pdf", folder: "files" });
    const legacy = await makeAsset({ filename: "target.mp4", kind: "IMAGE", mimeType: "video/mp4", folder: "videos" });

    const result = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(result.candidates, 1, "solo il video legacy è un candidato");
    assert.equal(result.fixed, 1);
    assert.equal(result.rows[0].id, legacy.id);

    for (const [asset, kind] of [
      [image, "IMAGE"],
      [audio, "AUDIO"],
      [doc, "FILE"],
    ] as const) {
      const reloaded = await prisma.contentAsset.findUnique({ where: { id: asset.id } });
      assert.equal(reloaded?.kind, kind, `${asset.filename} non deve cambiare kind`);
    }
  });

  test("5) il criterio richiede il prefisso 'video/' e non confonde altri MIME", async () => {
    const notVideo = await makeAsset({
      filename: "strano.bin",
      kind: "IMAGE",
      mimeType: "application/x-video-editor",
      folder: "files",
    });
    const nullMime = await makeAsset({ filename: "senza-mime.bin", kind: "IMAGE", mimeType: null, folder: "files" });

    const result = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(result.candidates, 0, "nessuno dei due è un video");

    for (const id of [notVideo.id, nullMime.id]) {
      const reloaded = await prisma.contentAsset.findUnique({ where: { id } });
      assert.equal(reloaded?.kind, "IMAGE");
    }
  });

  test("6) un asset già VIDEO non viene ricontato né modificato", async () => {
    const correct = await makeAsset({
      filename: "gia-corretto.mp4",
      kind: "VIDEO",
      mimeType: "video/mp4",
      folder: "videos",
    });

    const result = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(result.candidates, 0);
    assert.equal(result.fixed, 0);

    const reloaded = await prisma.contentAsset.findUnique({ where: { id: correct.id } });
    assert.equal(reloaded?.kind, "VIDEO");
  });

  test("7) la correzione tocca solo la colonna kind", async () => {
    const legacy = await makeAsset({
      filename: "intatto.mp4",
      kind: "IMAGE",
      mimeType: "video/mp4",
      folder: "videos",
    });
    const before = await prisma.contentAsset.findUniqueOrThrow({ where: { id: legacy.id } });

    await fixMisclassifiedVideoAssets(prisma);
    const after = await prisma.contentAsset.findUniqueOrThrow({ where: { id: legacy.id } });

    assert.equal(after.kind, "VIDEO");
    assert.equal(after.url, before.url, "l'URL non deve cambiare");
    assert.equal(after.filename, before.filename, "il nome file non deve cambiare");
    assert.equal(after.mimeType, before.mimeType, "il MIME non deve cambiare");
    assert.equal(after.size, before.size, "la dimensione non deve cambiare");
    assert.equal(after.contentId, before.contentId, "l'associazione non deve cambiare");
    assert.equal(after.createdAt.getTime(), before.createdAt.getTime(), "createdAt non deve cambiare");
  });

  test("8) la correzione è idempotente: la seconda esecuzione non trova nulla", async () => {
    await makeAsset({ filename: "idempotente.mp4", kind: "IMAGE", mimeType: "video/mp4", folder: "videos" });

    const first = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(first.fixed, 1);

    const second = await fixMisclassifiedVideoAssets(prisma);
    assert.equal(second.candidates, 0);
    assert.equal(second.fixed, 0);
  });
});
