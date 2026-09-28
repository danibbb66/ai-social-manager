/**
 * Download sicuro dell'immagine ufficiale del catalogo.
 *
 * Qui la rete non esiste: `fetch` è sostituito, così le garanzie di sicurezza
 * si verificano come codice e non come fortuna. Un test che scaricherebbe
 * davvero dal sito dell'agenzia passerebbe o fallirebbe per motivi sbagliati
 * (rete lenta, sito giù, permessi), e un test che passasse non proverebbe
 * nulla sui rifiuti, che sono la parte che conta.
 *
 * I file scritti vengono rimossi: la suite non deve lasciare residui in
 * `public/uploads`.
 */

import { test, describe, beforeEach, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_REMOTE_IMAGE_BYTES,
  RemoteHostNotAllowedError,
  RemoteImageError,
  RemoteImageHttpError,
  RemoteImageNotAnImageError,
  RemoteImageNetworkError,
  RemoteImageSaveError,
  RemoteImageTimeoutError,
  RemoteImageTooLargeError,
  RemoteRedirectNotAllowedError,
  InvalidRemoteImageUrlError,
  assertAllowedCatalogUrl,
  downloadRemoteImage,
  isAllowedCatalogHost,
  officialImageFilename,
} from "../src/lib/images/remote";
import { deleteUploadedFile } from "../src/lib/uploads";
import { setImageProvider } from "../src/lib/images/factory";
import type { GenerateImageOptions, GeneratedImage, ImageProvider, ImageUpload } from "../src/lib/images/provider";

/** Dominio della fonte di catalogo, come arriva da `CatalogSource.domain`. */
const CATALOG_DOMAIN = "catalogo.test";
const ALLOWED = [CATALOG_DOMAIN];
const OFFICIAL_URL = `https://${CATALOG_DOMAIN}/wp-content/uploads/2026/06/REPUBBLICA-5-NOTTI.webp`;
const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

const originalFetch = globalThis.fetch;

/** Chiamate di rete osservate: servono a provare il "rifiutato prima del salvataggio". */
let calls: string[] = [];

/** URL salvati durante i test, per ripulire. */
const savedUrls: string[] = [];

let baselineFiles: string[] = [];

/** PNG, JPEG, WebP, GIF reali: `sniffMediaMime` guarda i magic bytes. */
const IMAGE_BYTES: Record<string, Buffer> = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0]),
  "image/webp": Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x1a, 0, 0, 0]),
    Buffer.from("WEBP", "ascii"),
    Buffer.from([0, 0, 0, 0]),
  ]),
  "image/gif": Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(6)]),
};

const SVG_BODY = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML_BODY = Buffer.from("<!DOCTYPE html><html><body>login</body></html>");

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchStub) {
  calls = [];
  (globalThis as { fetch: FetchStub }).fetch = async (input, init) => {
    calls.push(String(input));
    return handler(input, init);
  };
}

/** Risposta con immagine valida. */
function imageResponse(mime: string, body: Buffer = IMAGE_BYTES[mime]): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { "Content-Type": mime },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/** Elenco ricorsivo dei file sotto public/uploads, per notare ciò che resta. */
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

async function cleanup() {
  for (const url of savedUrls.splice(0)) {
    await deleteUploadedFile(url).catch(() => undefined);
  }
  const now = await listUploads();
  const leftovers = now.filter((f) => !baselineFiles.includes(f));
  for (const f of leftovers) {
    await fs.unlink(f).catch(() => undefined);
  }
  const dirs = path.join(UPLOADS_ROOT, "images");
  await fs.rmdir(dirs).catch(() => undefined);
}

/** Provider che non deve mai essere chiamato: nessuna generazione in questo modulo. */
class ForbiddenImageProvider implements ImageProvider {
  readonly name = "forbidden";
  readonly canGenerate = true;
  calls: { method: string; prompt: string; name: string }[] = [];

  async generateImage(prompt: string, options?: GenerateImageOptions): Promise<GeneratedImage> {
    this.calls.push({ method: "generateImage", prompt, name: options?.aspectRatio ?? this.name });
    throw new Error("il downloader non deve generare immagini");
  }

  async saveUploadedFile(file: ImageUpload): Promise<GeneratedImage> {
    this.calls.push({ method: "saveUploadedFile", prompt: "", name: file.originalName });
    throw new Error("il downloader non deve salvare tramite il provider");
  }
}

let provider: ForbiddenImageProvider;

before(async () => {
  baselineFiles = await listUploads();
  provider = new ForbiddenImageProvider();
  setImageProvider(provider);
});

after(async () => {
  globalThis.fetch = originalFetch;
  setImageProvider(null);
  await cleanup();
  const rest = await listUploads();
  assert.deepEqual(rest, baselineFiles, "la suite non deve lasciare file in public/uploads");
});

beforeEach(async () => {
  calls = [];
});

describe("allowlist del catalogo", () => {
  test("1. l'host della fonte di catalogo è consentito", () => {
    assert.equal(isAllowedCatalogHost(CATALOG_DOMAIN, ALLOWED), true);
    assert.equal(isAllowedCatalogHost(`www.${CATALOG_DOMAIN}`, ALLOWED), true);
    assert.equal(isAllowedCatalogHost(`CDN.${CATALOG_DOMAIN}`, ALLOWED), true);
    assert.equal(assertAllowedCatalogUrl(OFFICIAL_URL, ALLOWED).hostname, CATALOG_DOMAIN);
  });

  test("2. un host arbitrario è rifiutato, per intero o come sottodominio", () => {
    assert.equal(isAllowedCatalogHost("example.com", ALLOWED), false);
    assert.equal(isAllowedCatalogHost("evil.com", ALLOWED), false);
    // Non basta contenere il dominio: `notcatalogo.test` non è `catalogo.test`.
    assert.equal(isAllowedCatalogHost(`not${CATALOG_DOMAIN}`, ALLOWED), false);
    assert.equal(isAllowedCatalogHost(`${CATALOG_DOMAIN}.evil.com`, ALLOWED), false);
    assert.equal(isAllowedCatalogHost(CATALOG_DOMAIN, []), false);
  });

  test("3. l'errore di host riporta l'host che è stato respinto", () => {
    assert.throws(
      () => assertAllowedCatalogUrl("https://evil.com/x.png", ALLOWED),
      (e: unknown) => e instanceof RemoteHostNotAllowedError && e.code === "host_not_allowed" && e.host === "evil.com"
    );
  });
});

describe("download dell'immagine ufficiale", () => {
  test("4. dal dominio consentito il download riesce e il file è sotto public/uploads", async () => {
    stubFetch(async () => imageResponse("image/webp"));
    const saved = await downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED });

    assert.equal(calls.length, 1);
    assert.equal(calls[0], OFFICIAL_URL);
    assert.equal(saved.mimeType, "image/webp");
    assert.equal(saved.size, IMAGE_BYTES["image/webp"].length);
    assert.equal(saved.sourceUrl, OFFICIAL_URL);
    assert.equal(saved.url.startsWith("/uploads/"), true, `path non pubblico: ${saved.url}`);

    const absolute = path.join(process.cwd(), "public", saved.url.replace(/^\//, ""));
    assert.equal(absolute.startsWith(UPLOADS_ROOT + path.sep), true, `file fuori dagli upload: ${absolute}`);
    savedUrls.push(saved.url);

    const written = await fs.readFile(absolute);
    assert.deepEqual(written, IMAGE_BYTES["image/webp"], "i byte devono essere quelli scaricati");
  });

  test("5. ogni MIME immagine riconoscibile viene accettato", async () => {
    for (const mime of Object.keys(IMAGE_BYTES)) {
      stubFetch(async () => imageResponse(mime));
      const saved = await downloadRemoteImage({
        url: `https://${CATALOG_DOMAIN}/img/x.${savedExt(mime)}`,
        allowedDomains: ALLOWED,
      });
      assert.equal(saved.mimeType, mime, `MIME rifiutato: ${mime}`);
      assert.equal(saved.url.startsWith("/uploads/images/"), true);
      savedUrls.push(saved.url);
    }
  });

  test("6. un host non autorizzato viene rifiutato prima di qualsiasi richiesta", async () => {
    stubFetch(async () => imageResponse("image/png"));
    const before = await listUploads();

    await assert.rejects(
      downloadRemoteImage({ url: "https://evil.com/img/x.png", allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteHostNotAllowedError && e.code === "host_not_allowed"
    );

    assert.equal(calls.length, 0, "nessuna richiesta verso un host fuori allowlist");
    assert.deepEqual(await listUploads(), before, "nessun file scritto");
  });

  test("7. un indirizzo IP non è un dominio del catalogo e non viene contattato", async () => {
    stubFetch(async () => imageResponse("image/png"));

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8080/x.png",
      "http://[::1]/x.png",
      "http://10.0.0.5/x.png",
    ]) {
      await assert.rejects(
        downloadRemoteImage({ url, allowedDomains: ALLOWED }),
        (e: unknown) => e instanceof InvalidRemoteImageUrlError && e.code === "invalid_url",
        `accettato: ${url}`
      );
    }
    assert.equal(calls.length, 0, "nessuna richiesta verso un indirizzo IP");
  });

  test("8. un protocollo diverso da http(s) viene rifiutato", async () => {
    stubFetch(async () => imageResponse("image/png"));

    for (const url of ["file:///etc/passwd", "data:image/png;base64,iVBORw0KGgo=", "ftp://x/y.png"]) {
      await assert.rejects(
        downloadRemoteImage({ url, allowedDomains: ALLOWED }),
        (e: unknown) => e instanceof InvalidRemoteImageUrlError,
        `accettato: ${url}`
      );
    }
    assert.equal(calls.length, 0);
  });

  test("9. le credenziali nell'URL fanno fallire il download", async () => {
    stubFetch(async () => imageResponse("image/png"));
    await assert.rejects(
      downloadRemoteImage({
        url: `https://user:pass@${CATALOG_DOMAIN}/img/x.png`,
        allowedDomains: ALLOWED,
      }),
      (e: unknown) => e instanceof InvalidRemoteImageUrlError
    );
    assert.equal(calls.length, 0);
  });

  test("10. un URL malformato o vuoto è un errore esplicito", async () => {
    stubFetch(async () => imageResponse("image/png"));
    for (const url of ["", "   ", "non-è-un-url", "/img/x.png"]) {
      await assert.rejects(
        downloadRemoteImage({ url, allowedDomains: ALLOWED }),
        (e: unknown) => e instanceof InvalidRemoteImageUrlError && e.code === "invalid_url"
      );
    }
    assert.equal(calls.length, 0);
  });
});

describe("redirect", () => {
  test("11. un redirect verso un host fuori allowlist è rifiutato", async () => {
    stubFetch(async () => redirectResponse("https://evil.com/payload.png"));
    const before = await listUploads();

    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteRedirectNotAllowedError && e.code === "redirect_not_allowed"
    );

    assert.deepEqual(calls, [OFFICIAL_URL], "il secondo hop non deve essere richiesto");
    assert.deepEqual(await listUploads(), before, "nessun file scritto");
  });

  test("12. un redirect dentro l'allowlist viene seguito", async () => {
    const final = `https://${CATALOG_DOMAIN}/wp-content/uploads/2026/06/finale.png`;
    stubFetch(async (input) => (String(input) === OFFICIAL_URL ? redirectResponse(final) : imageResponse("image/png")));

    const saved = await downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED });
    assert.equal(saved.sourceUrl, final, "l'URL sorgente deve essere quello finale");
    assert.equal(saved.mimeType, "image/png");
    savedUrls.push(saved.url);
  });

  test("13. un redirect relativo sullo stesso host è lecito", async () => {
    stubFetch(async (input) =>
      String(input) === OFFICIAL_URL
        ? redirectResponse("/wp-content/uploads/altra.png")
        : imageResponse("image/jpeg")
    );
    const saved = await downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED });
    assert.equal(saved.sourceUrl, `https://${CATALOG_DOMAIN}/wp-content/uploads/altra.png`);
    savedUrls.push(saved.url);
  });

  test("14. troppi redirect e redirect senza Location sono errori distinti", async () => {
    stubFetch(async () => redirectResponse("https://catalogo.test/loop.png"));
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteRedirectNotAllowedError && /Troppi redirect/.test(e.message)
    );

    stubFetch(async () => new Response(null, { status: 302 }));
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageHttpError && e.code === "http_error"
    );
  });

  test("15. un redirect verso un indirizzo IP viene rifiutato come redirect non autorizzato", async () => {
    stubFetch(async () => redirectResponse("http://169.254.169.254/latest/meta-data/"));
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteRedirectNotAllowedError
    );
    assert.deepEqual(calls, [OFFICIAL_URL], "il metadata endpoint non deve essere contattato");
  });
});

describe("contenuto scaricato", () => {
  test("16. un Content-Type text/html viene rifiutato", async () => {
    stubFetch(async () => new Response(HTML_BODY, { status: 200, headers: { "Content-Type": "text/html" } }));
    const before = await listUploads();

    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageNotAnImageError && e.code === "not_an_image"
    );
    assert.deepEqual(await listUploads(), before);
  });

  test("17. un SVG non viene scambiato per un'immagine, nemmeno con header image/*", async () => {
    stubFetch(async () => new Response(SVG_BODY, { status: 200, headers: { "Content-Type": "image/svg+xml" } }));
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageNotAnImageError
    );
  });

  test("18. HTML mascherato da image/png dai soli magic bytes non passa", async () => {
    stubFetch(async () => new Response(HTML_BODY, { status: 200, headers: { "Content-Type": "image/png" } }));
    const before = await listUploads();
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageNotAnImageError
    );
    assert.deepEqual(await listUploads(), before, "un HTML non deve finire in public/uploads");
  });

  test("19. il MIME reale decide, non quello dichiarato", async () => {
    // Header che dice JPEG, byte che dicono PNG: si tiene il dato reale.
    stubFetch(
      async () =>
        new Response(new Uint8Array(IMAGE_BYTES["image/png"]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        })
    );
    const saved = await downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED });
    assert.equal(saved.mimeType, "image/png");
    savedUrls.push(saved.url);
  });

  test("20. application/octet-stream non basta a far entrare un file non immagine", async () => {
    stubFetch(async () =>
      new Response(Buffer.from("non e' un'immagine"), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      })
    );
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageNotAnImageError
    );
  });

  test("21. una risposta HTTP non 200 è un errore esplicito", async () => {
    for (const status of [204, 400, 403, 404, 500]) {
      stubFetch(async () => new Response(null, { status }));
      await assert.rejects(
        downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
        (e: unknown) => e instanceof RemoteImageHttpError && e.code === "http_error" && e.status === status,
        `status non segnalato: ${status}`
      );
    }
  });

  test("22. una risposta vuota è un errore, non un file da zero byte", async () => {
    stubFetch(async () => new Response(new Uint8Array(0), { status: 200, headers: { "Content-Type": "image/png" } }));
    const before = await listUploads();
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED }),
      (e: unknown) => e instanceof RemoteImageHttpError
    );
    assert.deepEqual(await listUploads(), before);
  });
});

describe("limiti", () => {
  test("23. un Content-Length sopra il limite viene rifiutato prima di leggere", async () => {
    const body = Buffer.concat([IMAGE_BYTES["image/png"], Buffer.alloc(4096)]);
    stubFetch(async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(body.length) },
      })
    );

    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED, maxBytes: 1024 }),
      (e: unknown) => e instanceof RemoteImageTooLargeError && e.maxBytes === 1024
    );
  });

  test("24. un body enorme con Content-Length bugiardo viene interrotto durante la lettura", async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const big = Buffer.concat([IMAGE_BYTES["image/png"], chunk, chunk, chunk, chunk]);
    stubFetch(async () =>
      // Content-Length dichiara 10 byte: è la trappola, e il limite deve
      // comunque valere, perché viene applicato mentre si legge.
      new Response(new Uint8Array(big), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "10" },
      })
    );

    const before = await listUploads();
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED, maxBytes: 32 * 1024 }),
      (e: unknown) => e instanceof RemoteImageTooLargeError
    );
    assert.deepEqual(await listUploads(), before, "un download abortito non lascia file");
  });

  test("25. il limite di default è 10 MB", () => {
    assert.equal(MAX_REMOTE_IMAGE_BYTES, 10 * 1024 * 1024);
  });

  test("26. un timeout non lascia file e non viene scambiato per un errore di rete", async () => {
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const before = await listUploads();

    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED, timeoutMs: 60 }),
      (e: unknown) => e instanceof RemoteImageTimeoutError && e.code === "timeout"
    );
    assert.deepEqual(await listUploads(), before);
  });

  test("27. un errore di rete è distinto dal timeout", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED, timeoutMs: 5000 }),
      (e: unknown) => e instanceof RemoteImageNetworkError && e.code === "network_error"
    );
  });
});

describe("nome del file", () => {
  test("28. il nome proposto è deterministico e diverso per URL diversi", () => {
    const a = officialImageFilename(OFFICIAL_URL, "image/webp", "REPUBBLICA-5-NOTTI.webp");
    const b = officialImageFilename(OFFICIAL_URL, "image/webp", "REPUBBLICA-5-NOTTI.webp");
    const c = officialImageFilename(`${OFFICIAL_URL}?v=2`, "image/webp", "REPUBBLICA-5-NOTTI.webp");
    assert.equal(a, b, "stesso URL e stesso MIME = stesso nome");
    assert.notEqual(a, c, "URL diverso = nome diverso");
    assert.match(a, /^repubblica-5-notti-[a-f0-9]{10}\.webp$/);
  });

  test("28b. l'hash sopravvive al troncamento di uniqueFilename", () => {
    // Il nome base viene tagliato a 40 caratteri: se l'hash stesse in coda a
    // una parte lunga, verrebbe perso e due URL diversi finirebbero omonimi.
    const long = officialImageFilename(OFFICIAL_URL, "image/png", `PISCINA-SPA-RESIDENCE-VILLA-CON-VISTA-SUPPLEMENTO-${"x".repeat(120)}.webp`);
    const base = long.replace(/\.png$/, "");
    assert.ok(base.length <= 40, `base troppo lunga per uniqueFilename: ${base.length}`);
    assert.match(base, /-[a-f0-9]{10}$/, "l'hash deve stare intero e in coda");
  });

  test("29. il nome non consente traversal, anche con originalName ostile", () => {
    const hostile = [
      "../../../../etc/passwd",
      "..\\..\\windows\\system32\\config",
      "/etc/shadow",
      "a/../../b",
      "x".repeat(300),
    ];
    for (const name of hostile) {
      const out = officialImageFilename(OFFICIAL_URL, "image/png", name);
      assert.ok(!out.includes("/"), `slash nel nome: ${out}`);
      assert.ok(!out.includes("\\"), `backslash nel nome: ${out}`);
      assert.ok(!out.includes(".."), `punti consecutivi nel nome: ${out}`);
      assert.match(out, /^[a-z0-9-]{1,32}\.[a-z0-9]{1,5}$/, `forma non sicura: ${out}`);
    }
  });

  test("30. l'estensione viene dai magic bytes, non dal nome del catalogo", () => {
    const out = officialImageFilename(OFFICIAL_URL, "image/jpeg", "OFFERTA.png");
    assert.match(out, /\.jpg$/, "un JPEG non deve salvare come png");
  });

  test("31. un download reale resta dentro public/uploads anche con nome ostile", async () => {
    stubFetch(async () => imageResponse("image/png"));
    const saved = await downloadRemoteImage({
      url: OFFICIAL_URL,
      allowedDomains: ALLOWED,
      originalName: "../../../etc/passwd",
    });
    savedUrls.push(saved.url);

    const absolute = path.join(process.cwd(), "public", saved.url.replace(/^\//, ""));
    assert.equal(absolute.startsWith(UPLOADS_ROOT + path.sep), true);
    // Il nome ostile non viene ripulito e riusato: viene scartato, e al suo
    // posto resta l'hash dell'URL. Niente di quello che conteneva finisce nel path.
    assert.match(saved.filenameHint, /^[a-z0-9-]{1,32}\.png$/);
    assert.ok(!saved.filenameHint.includes("passwd"), `residuo del nome ostile: ${saved.filenameHint}`);
    assert.ok(!saved.filenameHint.includes("etc"), `residuo del nome ostile: ${saved.filenameHint}`);
    // Il nome su disco aggiunge il suffisso di unicità dell'helper condiviso,
    // quindi non è identico a quello proposto: deve però derivarne.
    assert.ok(
      saved.filename.startsWith(saved.filenameHint.replace(/\.png$/, "")),
      `nome salvato non derivato da quello proposto: ${saved.filename}`
    );
  });
});

describe("isolamento", () => {
  test("32. nessuna chiamata al provider immagini e nessuna scrittura al database", async () => {
    stubFetch(async () => imageResponse("image/webp"));
    const saved = await downloadRemoteImage({ url: OFFICIAL_URL, allowedDomains: ALLOWED });
    savedUrls.push(saved.url);

    assert.deepEqual(provider.calls, [], "il downloader non deve usare il provider immagini");

    // Non basta evitare le chiamate: il modulo non deve nemmeno poterci arrivare.
    const source = await fs.readFile(path.join(process.cwd(), "src", "lib", "images", "remote.ts"), "utf8");
    const imports = source.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
    for (const forbidden of ["prisma", "magnific", "images/factory", "images/provider", "services/content"]) {
      assert.ok(
        !imports.some((l) => l.includes(forbidden)),
        `remote.ts non deve importare "${forbidden}"`
      );
    }
    assert.ok(!/getImageProvider|setImageProvider|prisma\./.test(source), "nessuna chiamata a provider o database");
  });

  test("33. ogni errore espone un codice e resta distinguibile", () => {
    const errors = [
      new InvalidRemoteImageUrlError("x"),
      new RemoteHostNotAllowedError("evil.com"),
      new RemoteRedirectNotAllowedError("x"),
      new RemoteImageTimeoutError("x"),
      new RemoteImageNetworkError("x"),
      new RemoteImageHttpError("x"),
      new RemoteImageNotAnImageError("x"),
      new RemoteImageTooLargeError(1),
      new RemoteImageSaveError("x"),
    ];
    const codes = errors.map((e) => e.code);
    assert.equal(new Set(codes).size, codes.length, `codici duplicati: ${codes.join(", ")}`);
    for (const e of errors) {
      assert.ok(e instanceof RemoteImageError, "tutti gli errori condividono la base");
      assert.ok(e.name.length > 0);
    }
  });
});

function savedExt(mime: string): string {
  return mime.split("/")[1];
}
