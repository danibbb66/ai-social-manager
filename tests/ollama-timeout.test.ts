import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../src/lib/ai/ollama";
import { config, OLLAMA_MIN_TIMEOUT_MS } from "../src/lib/env";

/**
 * Comportamento del watchdog Ollama con fetch sostituito.
 *
 * I tre guasti che si confondevano prima sono ora distinti e verificati:
 * 1. il primo token non arriva mai (modello che si carica, o servizio appeso);
 * 2. lo stream muore a metà generazione;
 * 3. la generazione è lunga ma VIVA: non deve essere tagliata.
 *
 * Gli stub rifiutano con una DOMException AbortError, come fa davvero il fetch
 * di undici: è il dettaglio che rendeva il vecchio isAbortError muto (una
 * DOMException non è instanceof Error) e trasformava i timeout in falsi
 * "connessione interrotta".
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeProvider() {
  return new OllamaProvider("http://127.0.0.1:11434", "qwen3:8b");
}

function chatOptions(idleMs: number, totalMs?: number) {
  return {
    idleTimeoutMs: idleMs,
    ...(totalMs !== undefined ? { totalTimeoutMs: totalMs } : {}),
    numCtx: 2048,
    numPredict: 64,
  };
}

const messages = [{ role: "user" as const, content: "Di ciao" }];

/** Il fetch non risponde mai, ma onora l'abort come farebbe undici. */
function stubHangingFetch() {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError"))
      );
    });
  }) as typeof fetch;
}

/** Primo chunk subito, poi lo stream muore senza chiudersi. */
function stubStallingStream(text: string) {
  const encoder = new TextEncoder();
  const first = encoder.encode(
    `${JSON.stringify({ model: "qwen3:8b", message: { role: "assistant", content: text }, done: false })}\n`
  );
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(first);
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("This operation was aborted", "AbortError"))
          );
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }) as typeof fetch;
}

/** Stream lento ma vivo: un chunk ogni `intervalMs`, poi chiusura pulita. */
function stubSlowAliveStream(chunks: number, intervalMs: number) {
  const encoder = new TextEncoder();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          // Come il fetch reale: abortare il segnale smonta il body dello
          // stream. Senza questo il loop di lettura continuerebbe a ricevere
          // chunk anche dopo l'abort del watchdog.
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("This operation was aborted", "AbortError"))
          );
          let sent = 0;
          const push = () => {
            // Dopo l'abort la catena di timer si ferma: senza questo il
            // processo resta vivo per la durata residua della catena e il test
            // runner va in timeout anche se l'assert è già passato.
            if (init?.signal?.aborted) return;
            if (sent >= chunks) {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ model: "qwen3:8b", done: true })}\n`)
              );
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ model: "qwen3:8b", message: { role: "assistant", content: "ciao " }, done: false })}\n`
              )
            );
            sent += 1;
            setTimeout(push, intervalMs);
          };
          push();
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
    );
  }) as typeof fetch;
}

describe("watchdog timeout Ollama", () => {
  test("il timeout di inattività non può scendere sotto 60s in configurazione", () => {
    assert.equal(OLLAMA_MIN_TIMEOUT_MS, 60_000);
    assert.ok(
      config.ollamaTimeoutMs >= OLLAMA_MIN_TIMEOUT_MS,
      `ollamaTimeoutMs=${config.ollamaTimeoutMs} sotto il minimo`
    );
    assert.ok(config.ollamaTotalTimeoutMs >= config.ollamaTimeoutMs);
  });

  test("primo token mai arrivato: timeout di inattività con messaggio dedicato", async () => {
    stubHangingFetch();
    const provider = makeProvider();
    await assert.rejects(
      provider.chat(messages, chatOptions(150)),
      (e: unknown) => {
        assert.equal((e as Error).name, "AiUnavailableError");
        assert.match((e as Error).message, /primo token/);
        assert.match((e as Error).message, /inattività/);
        return true;
      }
    );
  });

  test("stream morto a metà: il messaggio dice che la generazione è stata interrotta", async () => {
    stubStallingStream("ciao");
    const provider = makeProvider();
    await assert.rejects(
      provider.chat(messages, chatOptions(150)),
      (e: unknown) => {
        assert.equal((e as Error).name, "AiUnavailableError");
        assert.match((e as Error).message, /smesso di produrre/);
        return true;
      }
    );
  });

  test("una generazione lunga ma viva non viene tagliata dal timeout di inattività", async () => {
    stubSlowAliveStream(6, 50);
    const provider = makeProvider();
    const completion = await provider.chat(messages, chatOptions(150));
    assert.ok(completion.text.includes("ciao"), completion.text);
  });

  test("il tetto totale interrompe anche uno stream vivo e infinito", async () => {
    // Chunks ogni 50ms, inattività mai superata: è il tetto totale a fermare.
    stubSlowAliveStream(600, 50);
    const provider = makeProvider();
    await assert.rejects(
      provider.chat(messages, chatOptions(5_000, 300)),
      (e: unknown) => {
        assert.equal((e as Error).name, "AiUnavailableError");
        assert.match((e as Error).message, /tetto totale/);
        return true;
      }
    );
  });
});
