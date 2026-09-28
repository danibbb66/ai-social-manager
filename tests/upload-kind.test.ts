import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { POST } from "../src/app/api/upload/route";
import { detectUploadKind, sniffMediaMime, UnsupportedMediaTypeError } from "../src/lib/uploads";
import { deleteAsset } from "../src/lib/services/media";
import { deleteUploadedFile } from "../src/lib/uploads";

/* ------------------------------------------------------------------ */
/* Fixture: buffer con magic bytes realistici                           */
/* ------------------------------------------------------------------ */

const jpeg = () =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
  ]);

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from("IHDR", "ascii"),
    Buffer.alloc(20),
  ]);

const gif = () => Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)]);

const webp = () =>
  Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x2a, 0x00, 0x00, 0x00]),
    Buffer.from("WEBPVP8 ", "ascii"),
    Buffer.alloc(20),
  ]);

const avif = () =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from("ftypavif", "ascii"),
    Buffer.alloc(24),
  ]);

const mp4 = () =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("isomiso2avc1mp41", "ascii"),
    Buffer.alloc(32),
  ]);

const mov = () =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x14]),
    Buffer.from("ftypqt  ", "ascii"),
    Buffer.alloc(24),
  ]);

const webm = () =>
  Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.from("webm", "ascii"),
    Buffer.alloc(16),
  ]);

const plainText = () =>
  Buffer.from("Questo file e' testo semplice e non un media valido.", "utf8");

/* ------------------------------------------------------------------ */
/* Unit: rilevazione dai magic bytes                                    */
/* ------------------------------------------------------------------ */

describe("sniffMediaMime riconosce il formato reale dai magic bytes", () => {
  test("JPEG -> image/jpeg", () => {
    assert.equal(sniffMediaMime(jpeg()), "image/jpeg");
  });

  test("PNG -> image/png", () => {
    assert.equal(sniffMediaMime(png()), "image/png");
  });

  test("GIF -> image/gif", () => {
    assert.equal(sniffMediaMime(gif()), "image/gif");
  });

  test("WebP -> image/webp", () => {
    assert.equal(sniffMediaMime(webp()), "image/webp");
  });

  test("MP4 -> video/mp4", () => {
    assert.equal(sniffMediaMime(mp4()), "video/mp4");
  });

  test("MOV -> video/quicktime", () => {
    assert.equal(sniffMediaMime(mov()), "video/quicktime");
  });

  test("WebM -> video/webm", () => {
    assert.equal(sniffMediaMime(webm()), "video/webm");
  });

  test("AVIF ha un box ftyp come MP4 ma resta un'immagine", () => {
    assert.equal(sniffMediaMime(avif()), "image/avif");
  });

  test("un file non riconosciuto restituisce null invece di inventare un tipo", () => {
    assert.equal(sniffMediaMime(plainText()), null);
  });

  test("un buffer troppo corto non viene letto fuori confine", () => {
    assert.equal(sniffMediaMime(Buffer.from([0xff, 0xd8])), null);
  });
});

describe("detectUploadKind assegna IMAGE/VIDEO e rifiuta i formati non supportati", () => {
  test("JPEG -> IMAGE", () => {
    assert.deepEqual(detectUploadKind(jpeg(), "image/jpeg"), {
      mimeType: "image/jpeg",
      kind: "IMAGE",
    });
  });

  test("PNG -> IMAGE", () => {
    assert.deepEqual(detectUploadKind(png(), "image/png"), {
      mimeType: "image/png",
      kind: "IMAGE",
    });
  });

  test("WebP -> IMAGE", () => {
    assert.deepEqual(detectUploadKind(webp(), "image/webp"), {
      mimeType: "image/webp",
      kind: "IMAGE",
    });
  });

  test("MP4 -> VIDEO", () => {
    assert.deepEqual(detectUploadKind(mp4(), "video/mp4"), {
      mimeType: "video/mp4",
      kind: "VIDEO",
    });
  });

  test("WebM -> VIDEO", () => {
    assert.deepEqual(detectUploadKind(webm(), "video/webm"), {
      mimeType: "video/webm",
      kind: "VIDEO",
    });
  });

  test("i magic bytes prevalgono sul MIME dichiarato dal client", () => {
    // Il client dice "immagine JPEG", i bytes sono un MP4.
    assert.equal(detectUploadKind(mp4(), "image/jpeg").kind, "VIDEO");
    // Il client dice "video MP4", i bytes sono un PNG.
    assert.equal(detectUploadKind(png(), "video/mp4").kind, "IMAGE");
  });

  test("il fallback sul MIME dichiarato vale solo per i formati senza firma", () => {
    // Formato non sniffingabile: si accetta la dichiarazione del client.
    assert.deepEqual(detectUploadKind(plainText(), "video/quicktime"), {
      mimeType: "video/quicktime",
      kind: "VIDEO",
    });
  });

  test("il MIME dichiarato viene normalizzato (parametri e maiuscole)", () => {
    assert.equal(detectUploadKind(plainText(), "IMAGE/PNG; charset=binary").kind, "IMAGE");
  });

  test("un file senza tipo riconoscibile viene rifiutato con un errore chiaro", () => {
    assert.throws(
      () => detectUploadKind(plainText(), "text/plain"),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedMediaTypeError);
        assert.match(e.message, /non supportato/i);
        assert.match(e.message, /immagine|video/i);
        return true;
      }
    );
  });

  test("un file senza MIME dichiarato e non sniffingabile viene rifiutato", () => {
    assert.throws(() => detectUploadKind(plainText()), UnsupportedMediaTypeError);
    assert.throws(() => detectUploadKind(plainText(), ""), UnsupportedMediaTypeError);
  });
});

/* ------------------------------------------------------------------ */
/* Integrazione: il route handler reale                                 */
/* ------------------------------------------------------------------ */

type UploadedAsset = { id: string; kind: string; url: string; mimeType: string | null };

const createdAssetIds: string[] = [];
const createdUrls: string[] = [];

interface UploadResult {
  status: number;
  ok: boolean;
  message?: string;
  assets?: UploadedAsset[];
}

async function upload(
  bytes: Buffer,
  name: string,
  type: string,
  contentId?: string
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file0", new File([Uint8Array.from(bytes)], name, { type }));
  if (contentId) form.append("contentId", contentId);

  const res = await POST(
    new NextRequest("http://localhost/api/upload", { method: "POST", body: form })
  );
  const json = (await res.json()) as Omit<UploadResult, "status">;
  for (const asset of json.assets ?? []) {
    createdAssetIds.push(asset.id);
    createdUrls.push(asset.url);
  }
  return { status: res.status, ...json };
}

async function cleanup() {
  for (const id of createdAssetIds.splice(0)) {
    try {
      await deleteAsset(id);
    } catch {
      /* già eliminato */
    }
  }
  for (const url of createdUrls.splice(0)) {
    await deleteUploadedFile(url).catch(() => {});
  }
}

before(cleanup);
after(cleanup);

describe("POST /api/upload registra il kind corretto", () => {
  test("un JPEG viene salvato come IMAGE in /uploads/images", async () => {
    const res = await upload(jpeg(), "giornata.jpg", "image/jpeg");

    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.assets?.length, 1);
    assert.equal(res.assets?.[0].kind, "IMAGE");
    assert.equal(res.assets?.[0].mimeType, "image/jpeg");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/images\//);
  });

  test("un PNG viene salvato come IMAGE", async () => {
    const res = await upload(png(), "paesaggio.png", "image/png");

    assert.equal(res.ok, true);
    assert.equal(res.assets?.[0].kind, "IMAGE");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/images\//);
  });

  test("un WebP viene salvato come IMAGE", async () => {
    const res = await upload(webp(), "animazione.webp", "image/webp");

    assert.equal(res.ok, true);
    assert.equal(res.assets?.[0].kind, "IMAGE");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/images\//);
  });

  test("un MP4 viene salvato come VIDEO in /uploads/videos", async () => {
    const res = await upload(mp4(), "reel.mp4", "video/mp4");

    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.assets?.[0].kind, "VIDEO");
    assert.equal(res.assets?.[0].mimeType, "video/mp4");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/videos\//);
  });

  test("un WebM viene salvato come VIDEO", async () => {
    const res = await upload(webm(), "clip.webm", "video/webm");

    assert.equal(res.ok, true);
    assert.equal(res.assets?.[0].kind, "VIDEO");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/videos\//);
  });

  test("regressione: il kind persistito nel database è VIDEO per un video", async () => {
    const res = await upload(mp4(), "regressione.mp4", "video/mp4");
    const assetId = res.assets?.[0].id;
    assert.ok(assetId, "l'asset deve essere stato creato");

    const row = await prisma.contentAsset.findUnique({ where: { id: assetId } });
    assert.ok(row, "il record ContentAsset deve esistere");
    assert.equal(row?.kind, "VIDEO");
    assert.equal(row?.mimeType, "video/mp4");
  });

  test("il client non può far registrare un video come IMAGE", async () => {
    // Nome .jpg e MIME image/jpeg, ma i bytes sono un MP4.
    const res = await upload(mp4(), "travestimento.jpg", "image/jpeg");

    assert.equal(res.ok, true);
    assert.equal(res.assets?.[0].kind, "VIDEO");
    assert.match(res.assets?.[0].url ?? "", /^\/uploads\/videos\//);
  });

  test("un MIME non supportato viene rifiutato senza creare asset", async () => {
    // La verifica è scoped al file inviato, non un count() globale: i file di
    // test girano in parallelo e creano asset, quindi il totale oscillerebbe.
    const res = await upload(plainText(), "documento.txt", "text/plain");

    assert.equal(res.status, 415);
    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /non supportato/i);
    assert.equal(res.assets, undefined);
    const leaked = await prisma.contentAsset.findFirst({
      where: { filename: "documento.txt" },
    });
    assert.equal(leaked, null, "nessun asset deve essere stato creato");
  });

  test("un file senza MIME riconoscibile viene rifiutato", async () => {
    const res = await upload(plainText(), "senza-tipo.bin", "application/octet-stream");

    assert.equal(res.status, 415);
    assert.equal(res.ok, false);
    assert.match(res.message ?? "", /non supportato/i);
  });
});
