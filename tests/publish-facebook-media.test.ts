import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ContentType } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { config } from "../src/lib/env";
import {
  createContent,
  approveContent,
  deleteContent,
  getContent,
} from "../src/lib/services/content";
import { createAsset } from "../src/lib/services/media";
import { publishContent } from "../src/lib/services/publish";
import { FacebookProvider } from "../src/lib/social/facebook";
import type { PublishPayload } from "../src/lib/social/provider";

/**
 * Regressione: il provider Facebook degradava silenziosamente un post con
 * immagine a un post di solo testo quando non riusciva a costruire una URL
 * pubblica. Ora un media che richiede una URL pubblica e non la ottiene fa
 * fallire la pubblicazione in modo esplicito, senza chiamare la Graph API.
 */

const FAKE_TOKEN = "EAATESTsecretvalue123";
const FAKE_PAGE_ID = "1000000001";
const PUBLIC_BASE = "https://public.example.com";

const originalFetch = globalThis.fetch;
const originalPublicBaseUrl = config.publicBaseUrl;
const originalToken = config.facebook.token;
const originalPageId = config.facebook.pageId;

const createdIds: string[] = [];
const calls: string[] = [];

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub che registra ogni URL chiamato e risponde con un id fittizio. */
function stubFetch() {
  calls.length = 0;
  (globalThis as { fetch: FetchStub }).fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse({ id: "123456789_000111" });
  };
}

function payload(over: Partial<PublishPayload> = {}): PublishPayload {
  return {
    caption: "Post di prova",
    hashtags: "#test",
    mediaUrls: [],
    videoUrl: null,
    contentType: "POST" as ContentType,
    ...over,
  };
}

async function cleanup() {
  for (const id of createdIds.splice(0)) {
    try {
      await deleteContent(id);
    } catch {
      // già eliminato
    }
  }
}

before(async () => {
  await cleanup();
  config.facebook.token = FAKE_TOKEN;
  config.facebook.pageId = FAKE_PAGE_ID;
});

after(async () => {
  globalThis.fetch = originalFetch;
  config.facebook.token = originalToken;
  config.facebook.pageId = originalPageId;
  config.publicBaseUrl = originalPublicBaseUrl;
  await cleanup();
});

describe("FacebookProvider: i post testuali non cambiano", () => {
  test("1) post solo testo continua a usare /feed", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(payload());

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "123456789_000111");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /graph\.facebook\.com\/v26\.0\/1000000001\/feed/);
    assert.match(calls[0], /message=/);
  });

  test("2) post solo testo funziona anche con PUBLIC_APP_URL configurata", async () => {
    stubFetch();
    config.publicBaseUrl = PUBLIC_BASE;

    const res = await new FacebookProvider().publish(payload());

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/feed/);
  });
});

describe("FacebookProvider: i post con media usano /photos", () => {
  test("3) immagine con URL assoluto continua a funzionare", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["https://cdn.example.com/viaggi/greca.jpg"] })
    );

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/1000000001\/photos/);
    assert.match(decodeURIComponent(calls[0]), /url=https:\/\/cdn\.example\.com\/viaggi\/greca\.jpg/);
  });

  test("4) immagine con URL relativo viene risolta tramite PUBLIC_APP_URL", async () => {
    stubFetch();
    config.publicBaseUrl = PUBLIC_BASE;

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["/uploads/images/greca.jpg"] })
    );

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/1000000001\/photos/);
    assert.match(
      decodeURIComponent(calls[0]),
      /url=https:\/\/public\.example\.com\/uploads\/images\/greca\.jpg/
    );
  });
});

describe("FacebookProvider: senza URL pubblica la pubblicazione fallisce", () => {
  test("5) immagine con URL relativo e PUBLIC_APP_URL mancante -> errore esplicito", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["/uploads/images/greca.jpg"] })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.match(res.message, /HTTPS pubblica/i);
  });

  test("6) nessun fallback text-only: la Graph API non viene chiamata", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    await new FacebookProvider().publish(payload({ mediaUrls: ["/uploads/images/greca.jpg"] }));

    assert.deepEqual(calls, [], "non deve essere effettuata alcuna chiamata, né /feed né /photos");
  });

  test("7) PUBLIC_APP_URL non valida (http) vale come mancante", async () => {
    stubFetch();
    config.publicBaseUrl = "http://public.example.com";

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["/uploads/images/greca.jpg"] })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.deepEqual(calls, []);
  });

  test("8) URL non costruibile (percorso relativo senza slash iniziale) -> errore", async () => {
    stubFetch();
    config.publicBaseUrl = PUBLIC_BASE;

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["uploads/images/greca.jpg"] })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.deepEqual(calls, []);
  });

  test("9) video con URL relativo e PUBLIC_APP_URL mancante -> errore esplicito", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({
        contentType: "VIDEO" as ContentType,
        videoUrl: "/uploads/videos/reel.mp4",
        mediaUrls: [],
      })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.deepEqual(calls, []);
  });

  test("10) video con URL assoluto continua a funzionare", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({
        contentType: "VIDEO" as ContentType,
        videoUrl: "https://cdn.example.com/videos/reel.mp4",
        mediaUrls: [],
      })
    );

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/1000000001\/videos/);
    assert.match(decodeURIComponent(calls[0]), /file_url=https:\/\/cdn\.example\.com\/videos\/reel\.mp4/);
  });

  test("11) video completamente assente mantiene il messaggio dedicato", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({ contentType: "VIDEO" as ContentType, videoUrl: null, mediaUrls: [] })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /Nessun video da pubblicare/);
    assert.deepEqual(calls, []);
  });
});

describe("nessun segreto nell'errore", () => {
  test("12) il messaggio di URL mancante non contiene token ne credenziali", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const res = await new FacebookProvider().publish(
      payload({ mediaUrls: ["/uploads/images/greca.jpg"] })
    );

    assert.equal(res.ok, false);
    assert.equal(res.message.includes(FAKE_TOKEN), false, "il token non deve comparire");
    assert.doesNotMatch(res.message, /EAATEST|access_token|FACEBOOK_PAGE/);
  });
});

describe("publishContent: il fallimento è registrato, niente pubblicazione fantasma", () => {
  test("13) contenuto approvato con immagine e senza URL pubblico -> FAILED, nessuna chiamata", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const c = await createContent({
      title: "[TEST] fb media senza url pubblico",
      caption: "Dovrebbe fallire, non pubblicare solo il testo",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await createAsset({
      url: "/uploads/images/test-fb-no-url.jpg",
      filename: "test-fb-no-url.jpg",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentId: c.id,
    });
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.deepEqual(calls, [], "la Graph API non deve essere contattata");

    const content = await getContent(c.id);
    assert.equal(content?.status, "FAILED", "il contenuto non deve risultare pubblicato");

    const platform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });
    assert.equal(platform?.externalId, null, "non deve esserci un id di pubblicazione");
    assert.equal(platform?.publishedAt, null);
    assert.ok(platform?.error);
    assert.match(platform.error, /PUBLIC_APP_URL/);
    assert.equal(platform.error?.includes(FAKE_TOKEN), false);
  });

  test("14) contenuto approvato con immagine e URL pubblico -> pubblicato come foto", async () => {
    stubFetch();
    config.publicBaseUrl = PUBLIC_BASE;

    const c = await createContent({
      title: "[TEST] fb media con url pubblico",
      caption: "Foto pubblicata con la foto",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await createAsset({
      url: "/uploads/images/test-fb-with-url.jpg",
      filename: "test-fb-with-url.jpg",
      kind: "IMAGE",
      mimeType: "image/jpeg",
      contentId: c.id,
    });
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/1000000001\/photos/);
    assert.doesNotMatch(calls[0], /\/feed/);
    assert.match(
      decodeURIComponent(calls[0]),
      /url=https:\/\/public\.example\.com\/uploads\/images\/test-fb-with-url\.jpg/
    );

    const content = await getContent(c.id);
    assert.equal(content?.status, "PUBLISHED");

    const platform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });
    assert.equal(platform?.externalId, "123456789_000111");
    assert.ok(platform?.publishedAt);
    assert.equal(platform?.error, null);
  });

  test("15) contenuto testuale approvato -> resta una pubblicazione testuale", async () => {
    stubFetch();
    config.publicBaseUrl = "";

    const c = await createContent({
      title: "[TEST] fb solo testo",
      caption: "Post puramente testuale",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/1000000001\/feed/);

    const content = await getContent(c.id);
    assert.equal(content?.status, "PUBLISHED");
  });
});
