import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ContentType, Platform } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { config } from "../src/lib/env";
import {
  createContent,
  approveContent,
  deleteContent,
  getContent,
} from "../src/lib/services/content";
import { publishContent } from "../src/lib/services/publish";
import { FacebookProvider } from "../src/lib/social/facebook";

const FAKE_TOKEN = "EAATESTsecretvalue123";
const FAKE_PAGE_ID = "1000000001";
const createdIds: string[] = [];

const originalFetch = globalThis.fetch;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(handler: FetchStub) {
  (globalThis as { fetch: FetchStub }).fetch = handler;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  config.facebook.token = undefined;
  config.facebook.pageId = undefined;
  await cleanup();
});

const payload = {
  caption: "Test post testo Facebook",
  hashtags: "#test",
  mediaUrls: [] as string[],
  videoUrl: null as string | null,
  contentType: "POST" as ContentType,
};

describe("FacebookProvider (Graph API v26.0)", () => {
  test("1) pubblica un post testuale e restituisce externalId", async () => {
    let calledUrl = "";
    stubFetch(async (input) => {
      calledUrl = String(input);
      return jsonResponse({ id: "987654321_001122" });
    });

    const provider = new FacebookProvider();
    const res = await provider.publish(payload);

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "987654321_001122");
    assert.match(calledUrl, /graph\.facebook\.com\/v26\.0\/1000000001\/feed/);
    assert.match(calledUrl, /message=/);
    assert.match(decodeURIComponent(calledUrl.replace(/\+/g, " ")), /Test post testo Facebook/);
    assert.match(calledUrl, /access_token=/);
    assert.match(calledUrl, /^https:\/\/graph\.facebook\.com\/v26\.0\//);

  test("2) gestisce un errore API senza esporre il token", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: {
            message: "Invalid token EAATESTsecretvalue123 - check your access token",
            type: "OAuthException",
            code: 190,
          },
        },
        400
      )
    );

    const provider = new FacebookProvider();
    const res = await provider.publish(payload);

    assert.equal(res.ok, false);
    assert.match(res.message, /Facebook Graph API 400/);
    assert.match(res.message, /Invalid token/);
    assert.doesNotMatch(res.message, /EAATESTsecretvalue123/);
  });
});

describe("publishContent (guardie di sicurezza)", () => {
  test("3) rifiuta un contenuto non APPROVED/SCHEDULED", async () => {
    const c = await createContent({
      title: "[TEST] publish not approved",
      caption: "Caption di test",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);

    await assert.rejects(
      publishContent(c.id, "FACEBOOK", { confirm: true }),
      /approvato|approvazione/i
    );
  });

  test("4) rifiuta l'assenza di approvazione esplicita", async () => {
    const c = await createContent({
      title: "[TEST] publish no explicit approval",
      caption: "Caption di test",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);

    // Stato forzato a APPROVED senza record Approval (bypass lato DB può esistere)
    await prisma.content.update({
      where: { id: c.id },
      data: { status: "APPROVED" },
    });

    await assert.rejects(
      publishContent(c.id, "FACEBOOK", { confirm: true }),
      /approvazione esplicita/i
    );
  });

  test("5) con APPROVED + confirm=true esegue il provider e pubblica", async () => {
    stubFetch(async (input) => {
      assert.match(String(input), /\/feed/);
      return jsonResponse({ id: "555666777_001122" });
    });

    const c = await createContent({
      title: "[TEST] publish ok",
      caption: "Pubblico questo post di test su Facebook",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, true);

    const content = await getContent(c.id);
    assert.equal(content?.status, "PUBLISHED");

    const contentPlatform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });
    assert.equal(contentPlatform?.externalId, "555666777_001122");
    assert.ok(contentPlatform?.publishedAt);
    assert.equal(contentPlatform?.error, null);

    const job = await prisma.aIJob.findFirst({
      where: { contentId: c.id, kind: "PUBLISH" },
    });
    assert.equal(job?.status, "SUCCESS");
  });

  test("6) successo → PUBLISHED con externalId/publishedAt valorizzati", async () => {
    stubFetch(async () => jsonResponse({ id: "111222333_001122" }));

    const c = await createContent({
      title: "[TEST] publish external id",
      caption: "Post con externalId valorizzato",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });
    assert.equal(res.ok, true);

    const content = await getContent(c.id);
    assert.equal(content?.status, "PUBLISHED");

    const contentPlatform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });
    assert.equal(contentPlatform?.externalId, "111222333_001122");
    assert.ok(contentPlatform?.publishedAt instanceof Date);
    assert.equal(contentPlatform?.error, null);
  });

  test("7) errore → FAILED con esito salvato in modo sicuro", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: { message: "Publishing failed: token EAATESTsecretvalue123 expired", code: 200 },
        },
        400
      )
    );

    const c = await createContent({
      title: "[TEST] publish failed",
      caption: "Post che deve fallire",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, false);
    assert.match(res.message, /Pubblicazione fallita/);
    assert.doesNotMatch(res.message, /EAATESTsecretvalue123/);

    const content = await getContent(c.id);
    assert.equal(content?.status, "FAILED");

    const contentPlatform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });
    assert.equal(contentPlatform?.externalId, null);
    assert.ok(contentPlatform?.error);
    assert.doesNotMatch(contentPlatform.error, /EAATESTsecretvalue123/);

    const job = await prisma.aIJob.findFirst({
      where: { contentId: c.id, kind: "PUBLISH" },
    });
    assert.equal(job?.status, "FAILED");
    assert.doesNotMatch(job?.error ?? "", /EAATESTsecretvalue123/);
  });

  test("8) token mai presente nei messaggi di errore, log e audit", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: {
            message: "EAATESTsecretvalue123 is no longer valid",
            code: 190,
          },
        },
        400
      )
    );

    const c = await createContent({
      title: "[TEST] publish token leak",
      caption: "Controllo che il token non compaia mai",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });
    assert.equal(res.ok, false);

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "CONTENT_PUBLISH_FAILED",
        entityId: c.id,
      },
      orderBy: { createdAt: "desc" },
    });

    const job = await prisma.aIJob.findFirst({
      where: { contentId: c.id, kind: "PUBLISH" },
    });

    const contentPlatform = await prisma.contentPlatform.findUnique({
      where: { contentId_platform: { contentId: c.id, platform: "FACEBOOK" } },
    });

    const haystack = [
      res.message,
      job?.error ?? "",
      contentPlatform?.error ?? "",
      JSON.stringify(audit?.detail ?? {}),
    ].join("\n");

    assert.equal(haystack.includes(FAKE_TOKEN), false, "token esposto da qualche parte");
    assert.match(res.message, /\[REDACTED\]/);
  });
});

describe("superfici corrette della piattaforma", () => {
  test("le piattaforme del payload rispettano la selezione", async () => {
    stubFetch(async () => jsonResponse({ id: "999000111_001122" }));

    const c = await createContent({
      title: "[TEST] only facebook targeted",
      caption: "Solo Facebook",
      platforms: ["FACEBOOK"],
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });
    assert.equal(res.ok, true);

    const job = await prisma.aIJob.findFirst({
      where: { contentId: c.id, kind: "PUBLISH" },
    });
    const input = job?.input as { platforms: Platform[] };
    assert.deepEqual(input.platforms, ["FACEBOOK"]);
  });

  test("10) reg: FACEBOOK esplicito funziona anche senza piattaforme pre-selezionate", async () => {
    stubFetch(async (input) => {
      assert.match(String(input), /\/feed/);
      return jsonResponse({ id: "777888999_445566" });
    });

    const c = await createContent({
      title: "[TEST] explicit facebook without preselected platforms",
      caption: "Pubblico esplicitamente su Facebook senza piattaforme preselezionate",
      platforms: [], // nessuna riga ContentPlatform creata
    });
    createdIds.push(c.id);
    await approveContent(c.id);

    const res = await publishContent(c.id, "FACEBOOK", { confirm: true });

    assert.equal(res.ok, true);

    const job = await prisma.aIJob.findFirst({
      where: { contentId: c.id, kind: "PUBLISH" },
    });
    const input = job?.input as { platforms: Platform[] };
    assert.deepEqual(input.platforms, ["FACEBOOK"]);
  });
});
});
