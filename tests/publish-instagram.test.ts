import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ContentType } from "@prisma/client";
import { config } from "../src/lib/env";
import { InstagramProvider } from "../src/lib/social/instagram";

const FAKE_TOKEN = "IGUATESTsecretvalue456";
const FAKE_ACCOUNT_ID = "28591757157117367";
const PUBLIC_BASE = "https://public.example.com";

/** L'Instagram API with Instagram Login vive su graph.instagram.com. */
const EXPECTED_HOST = "https://graph.instagram.com/v23.0";
/** graph.facebook.com rifiuta i token IGAA… con "Cannot parse access token". */
const WRONG_HOST = "graph.facebook.com";

const originalFetch = globalThis.fetch;
const originalBase = config.publicBaseUrl;
const originalToken = config.instagram.token;
const originalAccountId = config.instagram.accountId;

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

/**
 * Costruisce uno stub di fetch che risponde come fa Meta:
 *  - POST /media            → crea un container e restituisce un id
 *  - GET  /{id}?fields=...  → restituisce lo status_code del container
 *  - POST /media_publish    → pubblica e restituisce l'id del media
 *
 * `statusSequence` elenca gli stati restituiti dai GET, nell'ordine.
 * L'ultimo stato viene ripetuto quando la sequenza si esaurisce.
 */
function graphStub(options: {
  statusSequence?: string[];
  publishId?: string;
  getStatusOverride?: () => Response;
  createdIds?: string[];
}) {
  const {
    statusSequence = ["FINISHED"],
    publishId = "17900000000000999",
    getStatusOverride,
    createdIds = [],
  } = options;

  let getCalls = 0;
  let created = 0;
  const calls: string[] = [];

  const handler: FetchStub = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/media_publish")) {
      return jsonResponse({ id: publishId });
    }

    // GET /{id}?fields=status_code → stato del container
    if (url.includes("fields=status_code")) {
      if (getStatusOverride) return getStatusOverride();
      const status = statusSequence[Math.min(getCalls, statusSequence.length - 1)];
      getCalls += 1;
      return jsonResponse({ status_code: status });
    }

    // POST /media
    created += 1;
    const id = `container-${created}`;
    createdIds.push(id);
    return jsonResponse({ id });
  };

  return { handler, calls, createdIds };
}

before(() => {
  config.instagram.token = FAKE_TOKEN;
  config.instagram.accountId = FAKE_ACCOUNT_ID;
  config.publicBaseUrl = PUBLIC_BASE;
});

after(() => {
  globalThis.fetch = originalFetch;
  config.instagram.token = originalToken;
  config.instagram.accountId = originalAccountId;
  config.publicBaseUrl = originalBase;
});

const payload = (
  over: Partial<{
    caption: string | null;
    hashtags: string | null;
    mediaUrls: string[];
    videoUrl: string | null;
    contentType: ContentType;
  }> = {}
) => ({
  caption: "Test post Instagram",
  hashtags: "#test",
  mediaUrls: [] as string[],
  videoUrl: null as string | null,
  contentType: "POST" as ContentType,
  ...over,
});

describe("InstagramProvider (media URL pubblici)", () => {
  test("1) risolve un percorso locale /uploads in una URL HTTPS pubblica", async () => {
    const { handler, calls: called } = graphStub({ publishId: "17900000000000001" });
    stubFetch(handler);

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({ mediaUrls: ["/uploads/images/photo.jpg"] })
    );

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "17900000000000001");
    // create container → poll stato → media_publish
    assert.equal(called.length, 3);
    assert.match(called[0], new RegExp(`${FAKE_ACCOUNT_ID}/media`));
    assert.ok(
      called[0].includes(encodeURIComponent(`${PUBLIC_BASE}/uploads/images/photo.jpg`)),
      `atteso URL pubblico assoluto, ricevuto: ${called[0]}`
    );
    assert.match(called[2], new RegExp(`${FAKE_ACCOUNT_ID}/media_publish`));
  });

  test("1b) usa graph.instagram.com e mai graph.facebook.com", async () => {
    const { handler, calls: called } = graphStub({ publishId: "17900000000000001" });
    stubFetch(handler);

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({ mediaUrls: ["https://cdn.example.com/photo.jpg"] })
    );

    assert.equal(res.ok, true);
    for (const url of called) {
      assert.ok(
        url.startsWith(EXPECTED_HOST),
        `atteso host ${EXPECTED_HOST}, ricevuto: ${url}`
      );
      assert.ok(
        !url.includes(WRONG_HOST),
        `non deve essere usato ${WRONG_HOST}: rifiuta i token IGAA…`
      );
    }
    // Le chiamate devono essere create + poll + media_publish, come da flusso Meta.
    assert.match(called[0], /\/media\?/);
    assert.match(called[1], /fields=status_code/);
    assert.match(called[2], /\/media_publish\?/);
  });

  test("2) conserva invariati gli URL già assoluti", async () => {
    const { handler, calls: called } = graphStub({ publishId: "17900000000000002" });
    stubFetch(handler);

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({ mediaUrls: ["https://cdn.example.com/photo.jpg"] })
    );

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "17900000000000002");
    assert.ok(called[0].includes(encodeURIComponent("https://cdn.example.com/photo.jpg")));
    assert.ok(!called[0].includes(PUBLIC_BASE));
  });

  test("3) fallisce con messaggio azionabile se manca la base pubblica", async () => {
    config.publicBaseUrl = "";
    const provider = new InstagramProvider();
    const res = await provider.publish(payload({ mediaUrls: ["/uploads/images/photo.jpg"] }));
    config.publicBaseUrl = PUBLIC_BASE;

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
    assert.match(res.message, /HTTPS/);
  });

  test("4) rifiuta una base non HTTPS (Meta non può raggiungerla)", async () => {
    config.publicBaseUrl = "http://public.example.com";
    const provider = new InstagramProvider();
    const res = await provider.publish(payload({ mediaUrls: ["/uploads/images/photo.jpg"] }));
    config.publicBaseUrl = PUBLIC_BASE;

    assert.equal(res.ok, false);
    assert.match(res.message, /PUBLIC_APP_URL/);
  });

  test("5) risolve anche il video con media container", async () => {
    const { handler, calls: called } = graphStub({ publishId: "17900000000000003" });
    stubFetch(handler);

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({ contentType: "VIDEO", videoUrl: "/uploads/videos/clip.mp4" })
    );

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "17900000000000003");
    assert.ok(called[0].includes(encodeURIComponent(`${PUBLIC_BASE}/uploads/videos/clip.mp4`)));
    assert.match(called[0], /media_type=VIDEO/);
    assert.match(called[2], /media_publish/);
  });

  test("6) risolve ogni media del carousel", async () => {
    const { handler, calls: called } = graphStub({ publishId: "17900000000000006" });
    stubFetch(handler);

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({
        contentType: "CAROUSEL",
        mediaUrls: ["/uploads/images/a.jpg", "/uploads/images/b.jpg"],
      })
    );

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "17900000000000006");
    // Ogni URL del carousel è risolto in una URL pubblica assoluta.
    const carouselPosts = called.filter((c) => c.includes("is_carousel_item=true"));
    assert.equal(carouselPosts.length, 2, "devono essere creati 2 container figli");
    assert.ok(carouselPosts[0].includes(encodeURIComponent(`${PUBLIC_BASE}/uploads/images/a.jpg`)));
    assert.ok(carouselPosts[1].includes(encodeURIComponent(`${PUBLIC_BASE}/uploads/images/b.jpg`)));

    // Ogni child è attenduto prima della creazione del container padre.
    const firstChildPoll = called.findIndex((c) => c.includes("fields=status_code"));
    const parentPost = called.findIndex(
      (c) => c.includes("media_type=CAROUSEL") && c.includes("children=")
    );
    assert.ok(firstChildPoll >= 0, "i figli devono essere interrogati sullo stato");
    assert.ok(parentPost > firstChildPoll, "il padre va creato dopo l'attesa dei figli");
  });

  test("7) non espone mai il token nei messaggi di errore", async () => {
    stubFetch(async () => jsonResponse({ error: { message: `Invalid token ${FAKE_TOKEN}` } }, 400));

    const provider = new InstagramProvider();
    const res = await provider.publish(
      payload({ mediaUrls: ["https://cdn.example.com/photo.jpg"] })
    );

    assert.equal(res.ok, false);
    assert.ok(!res.message.includes(FAKE_TOKEN), `token esposto: ${res.message}`);
    assert.match(res.message, /REDACTED/);
  });
});

/**
 * Attesa del container.
 *
 * Meta processa il media in modo asincrono: dopo POST /media lo status_code
 * resta IN_PROGRESS per diversi secondi e /media_publish va chiamato solo
 * quando diventa FINISHED, altrimenti Meta risponde
 * "Media ID is not available".
 */
describe("InstagramProvider (attesa del container)", () => {
  const IMAGE_PAYLOAD = payload({
    mediaUrls: ["https://cdn.example.com/photo.jpg"],
  });

  test("8) container già FINISHED: un solo poll e poi media_publish", async () => {
    const { handler, calls } = graphStub({ statusSequence: ["FINISHED"] });
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, true);
    const polls = calls.filter((c) => c.includes("fields=status_code"));
    assert.equal(polls.length, 1, "non deve ripollare un container già pronto");
    assert.ok(calls.some((c) => c.includes("media_publish")));
  });

  test("9) IN_PROGRESS → FINISHED: ripolla finché non è pronto", async () => {
    const { handler, calls } = graphStub({
      statusSequence: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"],
    });
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0, 0, 0, 0] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, true);
    const polls = calls.filter((c) => c.includes("fields=status_code"));
    assert.equal(polls.length, 3, "deve ripollare finché lo stato è IN_PROGRESS");

    // L'ordine conta: media_publish solo dopo l'ultimo poll.
    const lastPoll = calls.lastIndexOf(polls[2]);
    const publish = calls.findIndex((c) => c.includes("media_publish"));
    assert.ok(lastPoll < publish, "media_publish deve venire dopo l'attesa");
  });

  test("10) EXPIRED: errore esplicito e nessuna chiamata a media_publish", async () => {
    const { handler, calls } = graphStub({ statusSequence: ["EXPIRED"] });
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, false);
    assert.match(res.message, /EXPIRED/);
    assert.match(res.message, /riprova/i);
    assert.ok(
      !calls.some((c) => c.includes("media_publish")),
      "non deve pubblicare un container scaduto"
    );
  });

  test("11) ERROR al polling: trattato come container non utilizzabile", async () => {
    const { handler, calls } = graphStub({ statusSequence: ["ERROR"] });
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, false);
    assert.match(res.message, /ERROR/);
    assert.ok(!calls.some((c) => c.includes("media_publish")));
  });

  test("12) timeout: riporta lo stato finale e non pubblica", async () => {
    const { handler, calls } = graphStub({ statusSequence: ["IN_PROGRESS"] });
    stubFetch(handler);

    // Timeout 20ms con intervalli brevi: il container non arriva mai a FINISHED.
    // Restano sleep reali, ma l'attesa effettiva è di pochi millisecondi.
    const provider = new InstagramProvider({ containerTimeoutMs: 20, pollDelaysMs: [0, 5] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, false);
    assert.match(res.message, /non è pronto/i);
    assert.match(res.message, /IN_PROGRESS/, "deve riportare l'ultimo stato osservato");
    assert.ok(
      calls.filter((c) => c.includes("fields=status_code")).length > 1,
      "il polling deve interrogare il container prima di scadere"
    );
    assert.ok(
      !calls.some((c) => c.includes("media_publish")),
      "non deve pubblicare dopo il timeout"
    );
  });

  test("13) errore HTTP durante il polling: propagato come errore Graph", async () => {
    const { handler, calls } = graphStub({
      getStatusOverride: () =>
        jsonResponse({ error: { code: 190, message: "Session expired" } }, 401),
    });
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0] });

    const res = await provider.publish(IMAGE_PAYLOAD);

    assert.equal(res.ok, false);
    assert.match(res.message, /401|during l'attesa/i);
    assert.ok(!calls.some((c) => c.includes("media_publish")));
  });

  test("14) carousel: attende ogni child, poi il padre, poi pubblica", async () => {
    const createdIds: string[] = [];
    // Contatore di poll per container: il primo giro restituisce IN_PROGRESS.
    const pollsPerId = new Map<string, number>();
    const order: string[] = [];
    let n = 0;

    const handler: FetchStub = async (input) => {
      const url = String(input);
      order.push(url);

      if (url.includes("media_publish")) return jsonResponse({ id: "carousel-published" });
      if (url.includes("fields=status_code")) {
        const id = decodeURIComponent(url.split("?")[0].split("/").pop()!);
        const seen = pollsPerId.get(id) ?? 0;
        pollsPerId.set(id, seen + 1);
        return jsonResponse({ status_code: seen >= 1 ? "FINISHED" : "IN_PROGRESS" });
      }
      n += 1;
      const id = `c${n}`;
      pollsPerId.set(id, 0);
      createdIds.push(id);
      return jsonResponse({ id });
    };
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0, 0, 0, 0] });

    const res = await provider.publish(
      payload({
        contentType: "CAROUSEL",
        mediaUrls: ["/uploads/images/a.jpg", "/uploads/images/b.jpg"],
      })
    );

    assert.equal(res.ok, true);
    assert.equal(res.externalId, "carousel-published");
    // 2 child + 1 container padre = 3 id creati
    assert.equal(createdIds.length, 3, "devono essere creati 2 figli e 1 padre");

    const polls = order.filter((c) => c.includes("fields=status_code"));
    assert.ok(polls.length >= 3, "ogni container deve essere interrogato");
    // Il publish deve essere l'ultima operazione.
    assert.ok(order[order.length - 1].includes("media_publish"));
  });

  test("15) carousel: un child EXPIRED impedisce la pubblicazione", async () => {
    const handler: FetchStub = async (input) => {
      const url = String(input);
      if (url.includes("media_publish")) return jsonResponse({ id: "mai-usato" });
      if (url.includes("fields=status_code")) return jsonResponse({ status_code: "EXPIRED" });
      return jsonResponse({ id: "child-x" });
    };
    stubFetch(handler);

    const provider = new InstagramProvider({ containerTimeoutMs: 5_000, pollDelaysMs: [0] });

    const res = await provider.publish(
      payload({
        contentType: "CAROUSEL",
        mediaUrls: ["/uploads/images/a.jpg"],
      })
    );

    assert.equal(res.ok, false);
    assert.match(res.message, /EXPIRED/);
  });
});
