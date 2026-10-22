import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatRole, Platform } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createJobOwnership } from "./helpers/aijob-ownership";
import {
  runAgent,
  compactToolResult,
  parseRequestedContentCount,
  TOOL_RESULT_MAX,
  TOOL_ROUND_BUDGET,
  type AgentStreamEvent,
} from "../src/lib/ai/agent";
import { fallbackCopyFromTopic } from "../src/lib/ai/content-copy";
import { setAiProvider } from "../src/lib/ai/factory";
import type {
  AiChatMessage,
  AiCompletion,
  AiPingResult,
  AiProvider,
} from "../src/lib/ai/provider";
import { getMessageHistory, getOrCreateConversation } from "../src/lib/services/chat";
import { getContent, deleteContent, createContent } from "../src/lib/services/content";
import { setImageProvider, setStockProvider } from "../src/lib/images/factory";
import type { GeneratedImage, ImageProvider } from "../src/lib/images/provider";
import { installFakeStock } from "./helpers/stock";
import { installFakeStockVideo, resetStockVideo } from "./helpers/stock-video";

/**
 * Envelope dell'agente e percorso Chat → createContent.
 *
 * Il modello locale non produce sempre `{"message", "tool_calls"}`: nei test
 * reali del 26/09 ha emesso `{"action", "params"}` e `{}`. Qui il provider AI
 * è uno script finto (nessuna chiamata a Ollama), il provider stock è un
 * doppione che risponde a ogni ricerca per destinazione e il provider immagini
 * è un doppione che non genera mai: nessuna chiamata a Magnific, nessun
 * consumo di crediti.
 */

/** Provider AI finto: una risposta prefissata per ogni round, in ordine. */
class ScriptedAiProvider implements AiProvider {
  readonly name = "scripted";
  readonly model = "scripted";
  readonly calls: AiChatMessage[][] = [];

  constructor(private readonly replies: string[]) {
    if (replies.length === 0) throw new Error("serve almeno una risposta");
  }

  async ping(): Promise<AiPingResult> {
    return {
      ok: true,
      provider: this.name,
      model: this.model,
      availableModels: [],
      message: "scripted",
    };
  }

  async chat(messages: AiChatMessage[]): Promise<AiCompletion> {
    this.calls.push(messages);
    const i = Math.min(this.calls.length - 1, this.replies.length - 1);
    return { text: this.replies[i] };
  }
}

/** Provider immagini finto: registra i prompt e restituisce un file finto. */
class FakeImageProvider implements ImageProvider {
  readonly name = "fake";
  readonly canGenerate = true;
  readonly calls: { prompt: string; contentId?: string }[] = [];

  async generateImage(
    prompt: string,
    options?: { contentId?: string }
  ): Promise<GeneratedImage> {
    this.calls.push({ prompt, contentId: options?.contentId });
    return {
      url: "/uploads/images/test-envelope.png",
      provider: this.name,
      pathname: "C:/tmp/test-envelope.png",
      mimeType: "image/png",
      size: 1234,
    };
  }

  async saveUploadedFile(): Promise<GeneratedImage> {
    throw new Error("non usato");
  }
}

/** Destinazioni che non devono comparire se l'argomento è Calabria o Elba. */
const FOREIGN = [
  "amalfi",
  "costiera",
  "puglia",
  "sardegna",
  "sicilia",
  "roma",
  "parigi",
  "tokyo",
  "giappone",
  "barcellona",
  "santorini",
  "positano",
];

type ToolEvent = Extract<AgentStreamEvent, { type: "tool" }>;
type FinalEvent = Extract<AgentStreamEvent, { type: "final" }>;

const conversationIds: string[] = [];
const contentIds: string[] = [];
/** I tool di testo lasciano traccia in AIJob: la proprietà è per id, non per data. */
const jobOwnership = createJobOwnership(["CAPTION", "HASHTAGS"]);

/** Tool di sola lettura: serve a verificare che venga invocato. */
const READ_TOOL = "getPendingApprovals";

/** Esegue l'agente con risposte prefissate e restituisce esito ed eventi. */
async function runScripted(userMessage: string, replies: string[]) {
  const conversation = await getOrCreateConversation(null, "[TEST] envelope");
  conversationIds.push(conversation.id);

  const ai = new ScriptedAiProvider(replies);
  const images = new FakeImageProvider();
  setAiProvider(ai);
  setImageProvider(images);
  // Il visual del DRAFT arriva dalla libreria stock: doppione, nessuna rete.
  installFakeStock();
  // Anche la ricerca di video stock è un doppione (coda vuota): nessuna rete.
  installFakeStockVideo();

  const events: AgentStreamEvent[] = [];
  const result = await runAgent({
    conversationId: conversation.id,
    userMessage,
    emit: (e) => events.push(e),
  });

  const toolEvents = events.filter((e): e is ToolEvent => e.type === "tool");
  const finalEvents = events.filter((e): e is FinalEvent => e.type === "final");

  /**
   * `data` di un createContent eseguito in questa conversazione.
   *
   * `index` è 0-based e conta dalla creazione più recente: serve quando un
   * turno esegue più `createContent` e i loro dati vanno confrontati.
   */
  const toolData = async (toolName: string, index = 0): Promise<Record<string, unknown>> => {
    const rows = await prisma.chatMessage.findMany({
      where: { conversationId: conversation.id, role: "TOOL", toolName },
      orderBy: { createdAt: "desc" },
    });
    const row = rows[index];
    assert.ok(row, `il tool ${toolName} deve aver lasciato almeno ${index + 1} messaggi`);
    const parsed = JSON.parse(row.content) as { data?: Record<string, unknown> };
    return parsed.data ?? {};
  };

  return { ai, images, result, events, toolEvents, finalEvents, toolData };
}

function foreignIn(text: string): string[] {
  return FOREIGN.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(text));
}

before(async () => {
  await jobOwnership.capture();
});

after(async () => {
  setAiProvider(null);
  setImageProvider(null);
  setStockProvider(null);
  resetStockVideo();
  // Prima dei contenuti: `deleteContent` azzera `contentId` e il legame
  // con i job andrebbe perso. Gli asset stock nati con il DRAFT vanno via
  // insieme a loro.
  for (const id of contentIds) {
    await prisma.contentAsset
      .deleteMany({ where: { contentId: id } })
      .catch(() => {});
  }
  await jobOwnership.deleteOwned(contentIds);
  for (const id of contentIds.splice(0)) {
    await deleteContent(id).catch(() => {});
  }
  for (const id of conversationIds.splice(0)) {
    await prisma.chatConversation.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

test("envelope moderno: tool_calls viene eseguito", async () => {
  const { result, toolEvents } = await runScripted("dimmi cosa c'è da approvare", [
    JSON.stringify({
      message: "Controllo le approvazioni.",
      tool_calls: [{ name: READ_TOOL, arguments: {} }],
    }),
    JSON.stringify({ message: "Ecco cosa c'è da approvare." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, READ_TOOL);
  assert.equal(toolEvents[0].ok, true);
  assert.equal(result.executed?.[0]?.name, READ_TOOL);
});

test("envelope legacy: action + parameters viene eseguito", async () => {
  const { toolEvents } = await runScripted("dimmi cosa c'è da approvare", [
    JSON.stringify({ action: READ_TOOL, parameters: {} }),
    JSON.stringify({ message: "Fatto." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, READ_TOOL);
  assert.equal(toolEvents[0].ok, true);
});

test("envelope legacy: action + params viene eseguito", async () => {
  const { toolEvents } = await runScripted("dimmi cosa c'è da approvare", [
    JSON.stringify({ action: READ_TOOL, params: {} }),
    JSON.stringify({ message: "Fatto." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, READ_TOOL);
  assert.equal(toolEvents[0].ok, true);
});

test("envelope legacy: tool + params viene eseguito", async () => {
  const { toolEvents } = await runScripted("dimmi cosa c'è da approvare", [
    JSON.stringify({ tool: READ_TOOL, params: {} }),
    JSON.stringify({ message: "Fatto." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, READ_TOOL);
  assert.equal(toolEvents[0].ok, true);
});

test("argomenti come stringa JSON sono accettati", async () => {
  const { toolEvents } = await runScripted("crea un post per Instagram", [
    JSON.stringify({
      action: READ_TOOL,
      parameters: JSON.stringify({ unused: true }),
    }),
    JSON.stringify({ message: "Fatto." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, READ_TOOL);
  assert.equal(toolEvents[0].ok, true);
});

test("JSON vuoto: non viene mostrato e viene riprovato una sola volta", async () => {
  const { ai, result, toolEvents, finalEvents } = await runScripted("crea un post", [
    "{}",
    JSON.stringify({ message: "Non ho creato nulla." }),
  ]);

  assert.equal(ai.calls.length, 2, "un solo retry, non un loop");
  assert.match(
    String(ai.calls[1].at(-1)?.content),
    /tool_calls/,
    "il retry chiede esplicitamente l'envelope valido"
  );
  assert.equal(toolEvents.length, 0);
  assert.equal(finalEvents.length, 1);
  assert.notEqual(finalEvents[0].text.trim(), "{}");
  assert.equal(finalEvents[0].text, "Non ho creato nulla.");
  assert.equal(result.executed?.length, 0);
});

test("JSON vuoto anche dopo il retry: messaggio leggibile, mai il JSON grezzo", async () => {
  const { ai, finalEvents } = await runScripted("crea un post", ["{}", "{\n\n}"]);

  assert.equal(ai.calls.length, 2, "il retry non si ripete");
  assert.equal(finalEvents.length, 1);
  assert.notEqual(finalEvents[0].text.trim(), "{}");
  assert.match(finalEvents[0].text, /non ho eseguito nessuna operazione/i);
  assert.doesNotMatch(finalEvents[0].text, /[{}]/, "nessun JSON grezzo a schermo");
});

test("JSON con message e nessun tool: risposta finale usata così com'è", async () => {
  const { ai, result, toolEvents, finalEvents } = await runScripted("ciao", [
    JSON.stringify({ message: "Ciao, sono l'assistente AI." }),
  ]);

  assert.equal(ai.calls.length, 1, "nessun retry quando la risposta è valida");
  assert.equal(toolEvents.length, 0);
  assert.equal(finalEvents[0].text, "Ciao, sono l'assistente AI.");
  assert.equal(result.ok, true);
});

test("tool inesistente: errore chiaro e nessuna esecuzione", async () => {
  const { toolEvents } = await runScripted("usa un tool che non esiste", [
    JSON.stringify({ action: "toolCheNonEsiste", params: {} }),
    JSON.stringify({ message: "Non posso farlo." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "toolCheNonEsiste");
  assert.equal(toolEvents[0].ok, false);
  assert.match(String(toolEvents[0].error), /sconosciuto/i);
});

test("parametri non validi: il tool non viene eseguito e l'errore è leggibile", async () => {
  const { toolEvents } = await runScripted("crea un post per TWITTER", [
    JSON.stringify({
      action: "createContent",
      params: { title: "[TEST] invalido", platforms: ["TWITTER"] },
    }),
    JSON.stringify({ message: "Piattaforma non valida." }),
  ]);

assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "createContent");
  assert.equal(toolEvents[0].ok, false);
  // L'errore che finisce in chat non è un referto di validazione: nomina il
  // tool, i campi e i messaggi dello schema, che sono cose interne. Dice che cosa
  // è successo e che cosa fare, e basta.
  const error = String(toolEvents[0].error);
  assert.match(error, /richiesta era incompleta/i, `errore: ${error}`);
  assert.doesNotMatch(error, /createContent|TWITTER|invalid_type|expected/i, error);
});

test("gli errori di esecuzione non mostrano nomi di tool né dettagli di schema", async () => {
  // Ogni errore che arriva all'utente passa dalla stessa regola: un utente
  // chiede un contenuto, non una diagnosi del protocollo.
  const { toolEvents } = await runScripted("crea un post per TWITTER", [
    JSON.stringify({
      tool_calls: [
        { name: "createContent", arguments: { title: "[TEST] invalido", platforms: ["TWITTER"] } },
      ],
    }),
  ]);
  const error = String(toolEvents[0].error ?? "");
  assert.notEqual(error, "", "il tool fallisce e dichiara il motivo");
  assert.doesNotMatch(error, /Parametri non validi per|invalid_type|platforms/i, error);
  assert.doesNotMatch(error, /createContent/, "il nome del tool non è un messaggio per l'utente");
});

test("senza oggetto argomenti l'envelope legacy non inventa una call", async () => {
  const { toolEvents, finalEvents } = await runScripted("saluta", [
    JSON.stringify({ action: "createContent" }),
    JSON.stringify({ message: "Ciao!" }),
  ]);

  assert.equal(toolEvents.length, 0, "nessun tool senza parametri espliciti");
  assert.equal(finalEvents[0].text, "Ciao!");
});

test("CASO REALE: 'Crea un post Instagram/Facebook per una proposta Calabria' arriva a createContent", async () => {
  // Envelope legacy riprodotto dal modello nel test reale del 26/09.
  const { ai, images, result, toolEvents, finalEvents, toolData } = await runScripted(
    "Crea un post Instagram/Facebook per una proposta Calabria",
    [
      JSON.stringify({ action: "createContent", params: {
          topic: "proposta Calabria",
          type: "POST",
          title: "Calabria, il Sud che fa sognare",
          caption:
            "Una proposta di viaggio in Calabria, tra il mare e i borghi più belli del Sud.",
          hashtags: "#calabria #viaggi #proposta",
          platforms: ["INSTAGRAM", "FACEBOOK"],
        },
      }),
      JSON.stringify({ message: "Dovrei creare un altro post." }),
    ]
  );

  // 1. il tool è stato davvero invocato, una volta sola
  assert.equal(toolEvents.length, 1);
  const event = toolEvents[0];
  assert.equal(event.name, "createContent");
  assert.equal(event.ok, true, String(event.error ?? ""));
  assert.equal(result.executed?.[0]?.name, "createContent");

  // 2. i parametri sono arrivati coerenti con la richiesta
  const args = event.args as Record<string, unknown>;
  assert.equal(args.topic, "proposta Calabria");
  assert.equal(args.type, "POST");
  assert.deepEqual([...(args.platforms as string[])].sort(), [
    "FACEBOOK",
    "INSTAGRAM",
  ]);

  // 3. il DRAFT è completo di testo, piattaforme e visual recuperato dallo stock
  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.topic, "proposta Calabria");
  assert.equal(data.withMedia, true, "il DRAFT nasce col suo visual");
  assert.equal(typeof data.assetId, "string", "l'asset dello stock è dichiarato");
  assert.equal(data.stockQuery, "Calabria", "la ricerca parte dalla destinazione");
  assert.equal(images.calls.length, 0, "nessun immagine generata da qui");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.deepEqual(
    content.platforms.map((p) => p.platform).sort(),
    ["FACEBOOK", "INSTAGRAM"]
  );
  assert.equal(content.assets.length, 1, "il DRAFT non resta senza visual");
  assert.ok((content.caption ?? "").length > 0, "la copy c'è comunque");

  // 4. il turno si chiude dopo la creazione: il modello non viene richiamato
  //    per continuare a ragionare e creare altri contenuti.
  assert.equal(ai.calls.length, 1, "un solo round di modello per la creazione");
  assert.equal(finalEvents.length, 1);
  // La risposta finale all'utente non porta l'id del database: l'utente non
  // cerca contenuti per identificatore, e il messaggio del tool è la conferma
  // che vede. L'id resta nei dati del tool, dove il modello può leggerlo.
  assert.doesNotMatch(
    finalEvents[0].text,
    /cmu[a-z0-9]{10,}/i,
    "la chat non mostra identificatori di database"
  );
  assert.equal(data.id !== undefined, true, "l'id resta nei dati del tool");
});

test("MULTI-POST: due destinazioni nella stessa frase producono due DRAFT", async () => {
  // Il caso segnalato: "un post su Ibiza e un post su Mallorca" era letto come
  // una richiesta sola, perché il totale era il massimo delle quantità (1 e 1)
  // e il secondo post veniva respinto come duplicato.
  const before = await prisma.content.count();
  const { toolEvents, finalEvents, toolData } = await runScripted(
    "Crea un post su Ibiza e un post su Mallorca",
    [
      JSON.stringify({
        message: "Creo entrambi i post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: { topic: "proposta Ibiza", type: "POST", platforms: ["INSTAGRAM"] },
          },
          {
            name: "createContent",
            arguments: { topic: "proposta Mallorca", type: "POST", platforms: ["INSTAGRAM"] },
          },
        ],
      }),
    ]
  );

  const creates = toolEvents.filter((e) => e.name === "createContent");
  assert.equal(creates.length, 2, "entrambe le chiamate restano visibili");
  // Il criterio: nessuna delle due è stata bloccata. Il tetto esiste per fermare
  // i duplicati, non per impedire un multi-post.
  assert.equal(creates[0].ok, true, String(creates[0].error ?? ""));
  assert.equal(creates[1].ok, true, `il secondo post non deve essere bloccato: ${creates[1].error}`);
  assert.doesNotMatch(
    String(creates[1].error ?? ""),
    /già (creato|stat[o] creato) in questo turno/i,
    "due destinazioni diverse non sono un duplicato"
  );

  assert.equal(
    await prisma.content.count(),
    before + 2,
    "entrambi i post devono esistere: la richiesta ne elencava due"
  );

  // Strutture diverse: due post identici non sarebbero due post.
  // `createContent` senza catalogo dichiara il formato che l'agente ha assegnato.
  const latest = await toolData("createContent", 0) as { editorialFormat?: string | null };
  const previous = await toolData("createContent", 1) as { editorialFormat?: string | null };
  assert.notEqual(
    latest.editorialFormat,
    previous.editorialFormat,
    "l'agente assegna un formato diverso a ciascun post"
  );

  // E la chiusura del turno è una frase pulita.
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, /2/);
  assert.doesNotMatch(finalEvents[0].text, /cmu[a-z0-9]{10,}/i, "nessun id in chat");
});

test("MULTI-POST: ogni post della stessa richiesta segue la matrice del suo formato", async () => {
  // La regola dei formati vale in un multi-post esattamente come in un post
  // singolo: il tetto del turno non può essere la scusa per copiare la stessa
  // struttura due volte, e nessuno dei due titoli può essere una formula.
  const idsBefore = new Set(
    (await prisma.content.findMany({ select: { id: true } })).map((r) => r.id)
  );

  const { toolEvents } = await runScripted("Crea un post su Formentera e un post su Mallorca", [
    JSON.stringify({
      message: "Creo entrambi.",
      tool_calls: [
        {
          name: "createContent",
          arguments: { topic: "proposta Formentera", type: "POST", platforms: ["INSTAGRAM"] },
        },
        {
          name: "createContent",
          arguments: { topic: "proposta Mallorca", type: "POST", platforms: ["INSTAGRAM"] },
        },
      ],
    }),
  ]);

  const creates = toolEvents.filter((e) => e.name === "createContent");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].ok, true, String(creates[1].error));

  const rows = await prisma.content.findMany({
    where: { id: { notIn: [...idsBefore] } },
    select: { id: true, title: true, caption: true },
  });
  contentIds.push(...rows.map((r) => r.id));
  assert.equal(rows.length, 2, "entrambi i post devono esistere");

  for (const row of rows) {
    const title = row.title ?? "";
    const place = title.includes("Mallorca") ? "Mallorca" : "Formentera";
    assert.match(title, new RegExp(place, "i"), `${title} deve nominare ${place}`);
    assert.doesNotMatch(
      title,
      /proposta di viaggio|la nostra proposta|da vivere con calma|vacanza in/i,
      `titolo generico: ${title}`
    );
    assert.match(row.caption ?? "", new RegExp(place, "i"), "la caption parla del suo luogo");
    assert.ok((row.caption ?? "").length > 20, "la caption non è vuota");
  }

  // E i due post non sono lo stesso testo con un altro titolo.
  assert.notEqual(rows[0].caption, rows[1].caption, "due destinazioni, due copy diverse");
});

test("CHAT SILENZIOSA: un turno con tool lascia una sola riga in cronologia", async () => {
  // Il requisito è che l'utente veda solo la conferma. Ogni messaggio in più è
  // una stringa di avanzamento: il narratore di un tool, un'etichetta, un
  // contatore di round. Qui si verifica l'effetto finale sul database, che è
  // ciò che l'utente ricarica a schermo.
  const before = await prisma.chatMessage.count();
  const { finalEvents } = await runScripted(
    "Crea un post su Formentera e un post su Mallorca",
    [
      JSON.stringify({
        // Due frasi di avanzamento: una per tool. Nessuna delle due deve
        // arrivare in chat.
        message: "Cerco le proposte nel catalogo.",
        tool_calls: [
          { name: "searchCatalog", arguments: { query: "Formentera" } },
          {
            name: "createContent",
            arguments: { topic: "proposta Formentera", type: "POST", platforms: ["INSTAGRAM"] },
          },
          {
            name: "createContent",
            arguments: { topic: "proposta Mallorca", type: "POST", platforms: ["INSTAGRAM"] },
          },
        ],
      }),
    ]
  );

  const conversationId = conversationIds[conversationIds.length - 1];
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
  const assistants = rows.filter((r) => r.role === "ASSISTANT");

  // Una richiesta dell'utente, una risposta dell'assistente.
  assert.equal(assistants.length, 1, `una sola risposta finale: ${assistants.map((a) => a.content).join(" | ")}`);
  assert.equal(finalEvents.length, 1, "un solo messaggio finale emesso");
  assert.equal(
    assistants[0].content,
    finalEvents[0].text,
    "la riga in chat è esattamente il messaggio finale"
  );
  assert.doesNotMatch(
    assistants[0].content,
    /Cerco le proposte|advance|tool|round/i,
    "nessuna stringa di avanzamento in chat"
  );
  // Gli strumenti eseguiti restano tracciati: la chat è silenziosa, il registro no.
  assert.ok(rows.some((r) => r.role === "TOOL"), "gli esiti dei tool restano in cronologia");
  assert.ok(before > 0);
});

test("MULTI-POST: la richiesta conta le destinazioni senza numero", async () => {
  // Il tetto del turno viene dalla richiesta: se contasse una sola unità, il
  // secondo post sarebbe bloccato come duplicato.
  assert.equal(parseRequestedContentCount("Crea un post su Ibiza e un post su Mallorca"), 2);
  assert.equal(parseRequestedContentCount("un post su Ibiza, un post su Creta, un post a Rodi"), 3);
  assert.equal(parseRequestedContentCount("post su Ibiza e post su Creta"), 2);
  assert.equal(parseRequestedContentCount("3 post sulla Grecia"), 3);
  assert.equal(parseRequestedContentCount("1 Grecia + 1 Maldive"), 2);
  assert.equal(parseRequestedContentCount("crea un post su Ibiza"), 1);
  // Una quantità esplicita non si somma alle ripetizioni della parola.
  assert.equal(parseRequestedContentCount("2 post: Grecia + Maldive"), 2);
});

test("CASO REALE: 'proposta isola d'Elba' con tool + params e withMedia esplicito", async () => {
  const { images, toolEvents, toolData } = await runScripted(
    "Crea un post Instagram/Facebook per una proposta isola d'Elba",
    [
      JSON.stringify({
        tool: "createContent",
        params: {
          topic: "proposta isola d'Elba",
          type: "POST",
          title: "Isola d'Elba, cuore del Tirreno",
          caption: "Una proposta di viaggio all'isola d'Elba tra spiagge e borghi sul mare.",
          hashtags: "#elba #viaggi #proposta",
          platforms: ["INSTAGRAM", "FACEBOOK"],
          withMedia: true,
        },
      }),
      JSON.stringify({ message: "Post creato in DRAFT." }),
    ]
  );

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "createContent");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));
  const args = toolEvents[0].args as Record<string, unknown>;
  assert.equal(args.withMedia, true);
  assert.equal(args.topic, "proposta isola d'Elba");

  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.withMedia, true, "il visual arriva dallo stock");
  assert.equal(typeof data.assetId, "string");
  assert.equal(images.calls.length, 0, "nessuna generazione immagini");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 1, "il DRAFT non resta senza visual");
  assert.match(content.caption ?? "", /elba/i, "la copy resta sul topic");
  assert.deepEqual(foreignIn(content.caption ?? ""), []);
});

test("envelope moderno: 'Crea un post Instagram/Facebook per una proposta Calabria' usa createContent senza contentId", async () => {
  // Forma prodotta dal modello dopo think:false + JSON Schema.
  const { images, toolEvents, toolData } = await runScripted(
    "Crea un post Instagram e Facebook per una proposta Calabria",
    [
      JSON.stringify({
        message: "Creo il contenuto.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              platforms: ["INSTAGRAM", "FACEBOOK"],
              withMedia: true,
            },
          },
        ],
      }),
      JSON.stringify({ message: "Post in DRAFT." }),
    ]
  );

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "createContent");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  const args = toolEvents[0].args as Record<string, unknown>;
  assert.equal(args.topic, "proposta Calabria");
  assert.equal(
    args.contentId,
    undefined,
    "creare un contenuto nuovo non deve passare un contentId"
  );
  assert.deepEqual([...(args.platforms as string[])].sort(), [
    "FACEBOOK",
    "INSTAGRAM",
  ]);

  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.withMedia, true, "createContent recupera il visual dallo stock");
  assert.equal(images.calls.length, 0, "nessuna chiamata al provider immagini");
  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 1);
  assert.match(content.caption ?? "", /calabria/i);
  assert.deepEqual(foreignIn(content.caption ?? ""), []);
});

test("richiesta di idee: usa createIdea e non createContent", async () => {
  const { toolEvents } = await runScripted("Dammi 3 idee per una vacanza in Elba", [
    JSON.stringify({
      message: "Salvo tre idee.",
      tool_calls: [
        {
          name: "createIdea",
          arguments: {
            title: "Elba in barca",
            description: "Grotte e calette del Tirreno.",
            topic: "Elba",
          },
        },
      ],
    }),
    JSON.stringify({ message: "Idee salvate." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "createIdea");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));
  assert.equal((toolEvents[0].args as Record<string, unknown>).topic, "Elba");
});

test("richiesta di modifica: usa updateContent con il contentId indicato", async () => {
  const draft = await createContent({
    title: "[TEST] da modificare",
    caption: "Bozza.",
    platforms: [Platform.INSTAGRAM],
  });
  contentIds.push(draft.id);

  const { toolEvents } = await runScripted(`cambia il titolo del contenuto ${draft.id}`, [
    JSON.stringify({
      message: "Aggiorno il titolo.",
      tool_calls: [
        {
          name: "updateContent",
          arguments: { contentId: draft.id, title: "[TEST] titolo aggiornato" },
        },
      ],
    }),
    JSON.stringify({ message: "Titolo aggiornato." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "updateContent");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  const updated = await getContent(draft.id);
  assert.equal(updated?.title, "[TEST] titolo aggiornato");
});

test("deleteContent senza confirm: il contenuto NON viene eliminato", async () => {
  const draft = await createContent({
    title: "[TEST] da non eliminare",
    platforms: [Platform.INSTAGRAM],
  });
  contentIds.push(draft.id);

  const { toolEvents, finalEvents } = await runScripted(
    `elimina il contenuto ${draft.id}`,
    [
      JSON.stringify({
        message: "Per eliminare definitivamente il contenuto, conferma esplicitamente.",
        tool_calls: [
          { name: "deleteContent", arguments: { contentId: draft.id, confirm: false } },
        ],
      }),
      JSON.stringify({ message: "Non ho eliminato nulla: serve la tua conferma." }),
    ]
  );

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "deleteContent");
  assert.equal(toolEvents[0].ok, false, "senza conferma il tool deve rifiutare");
  assert.match(String(toolEvents[0].error), /conferma/i);

  const stillThere = await getContent(draft.id);
  assert.ok(stillThere, "il contenuto deve esistere ancora");
  assert.match(finalEvents[0].text, /conferma/i);
});

test("deleteContent senza il campo confirm: la conferma non può essere aggirata", async () => {
  const draft = await createContent({
    title: "[TEST] conferma obbligatoria",
    platforms: [Platform.INSTAGRAM],
  });
  contentIds.push(draft.id);

  const { toolEvents } = await runScripted(`elimina il contenuto ${draft.id}`, [
    JSON.stringify({
      message: "Ok.",
      tool_calls: [
        { name: "deleteContent", arguments: { contentId: draft.id } },
      ],
    }),
    JSON.stringify({ message: "Serve la conferma." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "deleteContent");
  assert.equal(toolEvents[0].ok, false);
// Senza `confirm` lo schema rifiuta la chiamata, ma l'utente non legge un
  // referto di validazione: legge che la richiesta era incompleta. Ciò che conta,
  // e che resta verificato qui, è che il contenuto non è stato toccato.
  assert.match(String(toolEvents[0].error), /richiesta era incompleta|conferma/i);
  assert.ok(await getContent(draft.id), "il contenuto deve esistere ancora");
});

test("deleteContent con confirm: l'eliminazione avviene", async () => {
  const draft = await createContent({
    title: "[TEST] da eliminare davvero",
    platforms: [Platform.INSTAGRAM],
  });

  const { toolEvents } = await runScripted(
    `sì, confermo, elimina il contenuto ${draft.id}`,
    [
      JSON.stringify({
        message: "Elimino il contenuto come richiesto.",
        tool_calls: [
          { name: "deleteContent", arguments: { contentId: draft.id, confirm: true } },
        ],
      }),
      JSON.stringify({ message: "Contenuto eliminato." }),
    ]
  );

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "deleteContent");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));
  assert.equal(await getContent(draft.id), null, "il contenuto deve essere sparito");
});

test("la cronologia non conserva l'envelope JSON interno", async () => {
  const conversation = await getOrCreateConversation(null, "[TEST] cronologia");
  conversationIds.push(conversation.id);

  const ai = new ScriptedAiProvider([
    JSON.stringify({
      message: "Guardo le approvazioni.",
      tool_calls: [{ name: READ_TOOL, arguments: {} }],
    }),
    JSON.stringify({ message: "Ecco cosa c'è da approvare." }),
  ]);
  setAiProvider(ai);
  setImageProvider(new FakeImageProvider());

  await runAgent({
    conversationId: conversation.id,
    userMessage: "dimmi cosa c'è da approvare",
  });

  const rows = await prisma.chatMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });
const assistants = rows.filter((r) => r.role === "ASSISTANT");
  assert.ok(assistants.length > 0, "la risposta finale deve essere salvata");
  for (const row of assistants) {
    assert.doesNotMatch(
      row.content,
      /tool_calls|"action"|"parameters"/,
      `l'envelope interno non deve finire in cronologia: ${row.content}`
    );
  }

  // La chat è silenziosa: per una richiesta e una risposta deve esserci una
  // sola bollicina dell'assistente. La frase che accompagna una tool call
  // ("Guardo le approvazioni.") è il narratore di un passaggio interno e non
  // viene salvata: in chat compariva come una risposta seguita, più in basso,
  // da quella vera.
  assert.deepEqual(
    assistants.map((row) => row.content),
    ["Ecco cosa c'è da approvare."],
    "in chat deve restare solo la risposta finale"
  );
  // Gli esiti dei tool invece restano registrati: servono al modello nei turni
  // successivi e al team per capire che cosa è successo.
  assert.ok(
    rows.some((r) => r.role === "TOOL"),
    "gli esiti dei tool restano in cronologia"
  );
  // il risultato del tool resta tracciato
  assert.ok(rows.some((r) => r.role === "TOOL" && r.toolName === READ_TOOL));
});

/* ------------------------------------------------------------------------- *
 * Regressione H1 (run reale del 26/09): oltre HISTORY_LIMIT la cronologia
 * passata al modello conteneva i messaggi più VECCHI, quindi la richiesta
 * appena scritta non arrivava e il modello rispondeva come se la chat fosse
 * vuota. Ora il prompt deve contenere gli ultimi messaggi, in ordine.
 * ------------------------------------------------------------------------- */

/** HISTORY_LIMIT di src/lib/ai/agent.ts: sopra questo numero si taglia. */
const HISTORY_LIMIT = 24;

/** Marcatori: il più vecchio non deve arrivare, l'ultimo deve arrivare sempre. */
const OLD_MARK = "MARCATORE-VECCHIO";
const RECENT_MARK = "MARCATORE-RECENTE";

/**
 * `msg-01` … `msg-30`: il numero serve a controllare l'ordine di ciò che il
 * modello riceve davvero, non solo la sua presenza.
 */
function marker(i: number, total: number): string {
  const label = `msg-${String(i + 1).padStart(2, "0")}`;
  if (i === 0) return `${label} ${OLD_MARK}`;
  if (i === total - 1) return `${label} ${RECENT_MARK}`;
  return label;
}

/**
 * Scrive `total` messaggi alternando utente e assistente, un minuto di distanza
 * l'uno dall'altro: l'ordinamento non deve dipendere dalla velocità della macchina.
 */
async function seedHistory(conversationId: string, total: number): Promise<void> {
  const start = new Date("2026-09-26T09:00:00.000Z").getTime();
  for (let i = 0; i < total; i += 1) {
    await prisma.chatMessage.create({
      data: {
        conversationId,
        role: i % 2 === 0 ? ChatRole.USER : ChatRole.ASSISTANT,
        content: marker(i, total),
        createdAt: new Date(start + i * 60_000),
      },
    });
  }
}

/** Numero di msg-NN presenti in un testo, nell'ordine in cui compaiono. */
function marksIn(text: string): number[] {
  return [...text.matchAll(/msg-(\d\d)/g)].map((m) => Number(m[1]));
}

test("H1. oltre HISTORY_LIMIT il modello riceve i messaggi più recenti, in ordine cronologico", async () => {
  const conversation = await getOrCreateConversation(null, "[TEST] cronologia oltre limite");
  conversationIds.push(conversation.id);

  const TOTAL = 30; // 6 messaggi oltre il limite
  await seedHistory(conversation.id, TOTAL);

  // 1. il servizio restituisce gli ultimi HISTORY_LIMIT, non i primi
  const history = await getMessageHistory(conversation.id, HISTORY_LIMIT);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].content, marker(6, TOTAL), "msg-07: il più vecchio che entra");
  assert.equal(history.at(-1)?.content, marker(29, TOTAL), "msg-30: deve entrare");
  assert.ok(
    history.every((m) => !m.content.includes(OLD_MARK)),
    "i messaggi più vecchi del limite restano fuori"
  );
  const stamps = history.map((m) => m.createdAt.getTime());
  assert.deepEqual(
    stamps,
    [...stamps].sort((a, b) => a - b),
    "la cronologia deve tornare in ordine cronologico"
  );

  // 2. ed è davvero quello che finisce nel prompt
  const ai = new ScriptedAiProvider([
    JSON.stringify({ message: "Ho riletto la conversazione." }),
  ]);
  setAiProvider(ai);
  setImageProvider(new FakeImageProvider());
  await runAgent({
    conversationId: conversation.id,
    userMessage: "Crea il post con l'ultima proposta che abbiamo discusso.",
  });

  const sent = ai.calls[0]
    .filter((m) => m.role !== "system")
    .map((m) => String(m.content))
    .join("\n");

  assert.ok(sent.includes(RECENT_MARK), "la richiesta recente deve arrivare al modello");
  assert.ok(!sent.includes(OLD_MARK), "i messaggi scartati dal limite non devono arrivare");
  assert.equal(
    ai.calls[0].at(-1)?.content,
    "Crea il post con l'ultima proposta che abbiamo discusso.",
    "l'ultimo messaggio del prompt è la richiesta corrente"
  );

  // 3. la sequenza inviata resta cronologica
  const marks = marksIn(sent);
  assert.deepEqual(
    marks,
    [...marks].sort((a, b) => a - b),
    "i messaggi inviati non sono in ordine cronologico"
  );
  assert.equal(marks.at(-1), TOTAL, "l'ultimo messaggio storico inviato è msg-30");
});

test("H1. sotto HISTORY_LIMIT la cronologia resta completa e in ordine", async () => {
  const conversation = await getOrCreateConversation(null, "[TEST] cronologia sotto limite");
  conversationIds.push(conversation.id);
  await seedHistory(conversation.id, 5);

  const history = await getMessageHistory(conversation.id, HISTORY_LIMIT);
  assert.equal(history.length, 5);
  assert.deepEqual(
    history.map((m) => m.content),
    [0, 1, 2, 3, 4].map((i) => marker(i, 5))
  );
});

test("H1. a parità di createdAt l'ultimo inserito resta il più recente", async () => {
  // createdAt ha granularità al millisecondo: più messaggi possono condividerlo
  // e il tie non deve far sparire quello appena scritto.
  const conversation = await getOrCreateConversation(null, "[TEST] cronologia stesso istante");
  conversationIds.push(conversation.id);
  const at = new Date("2026-09-26T09:00:00.000Z");

  for (const content of ["msg-01", "msg-02", "msg-03"]) {
    await prisma.chatMessage.create({
      data: { conversationId: conversation.id, role: ChatRole.USER, content, createdAt: at },
    });
  }

  const history = await getMessageHistory(conversation.id, 2);
  assert.deepEqual(history.map((m) => m.content), ["msg-02", "msg-03"]);
});

test("updateContent non viene usato per creare: senza contentId il tool fallisce", async () => {
  const { toolEvents } = await runScripted("cambia il titolo di tutto", [
    JSON.stringify({
      message: "Aggiorno.",
      tool_calls: [{ name: "updateContent", arguments: { title: "[TEST] senza id" } }],
    }),
    JSON.stringify({ message: "Mi serve un id." }),
  ]);

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "updateContent");
  assert.equal(toolEvents[0].ok, false);
  // Il messaggio non nomina il tool né il campo mancante: sono dettagli interni.
  // Dice che la richiesta era incompleta, che è l'unica cosa utile all'utente.
  assert.match(String(toolEvents[0].error), /richiesta era incompleta/i);
  assert.doesNotMatch(String(toolEvents[0].error), /updateContent|contentId/i);
});

/* ------------------------------------------------------------------------- *
 * Selezione del tool: createContent è l'unico autorizzato a creare contenuti.
 *
 * Regressione sul bug reale del 26/09: per "Crea un post ... Calabria"
 * qwen3:8b sceglieva generateCaption + generateHashtags, producendo un
 * DRAFT con piattaforme vuote, topic assente e nessun visual.
 * ------------------------------------------------------------------------- */

/** Nomi dei tool invocati, in ordine. */
function calledTools(events: { name: string }[]): string[] {
  return events.map((e) => e.name);
}

test("A. 'Crea un post Instagram/Facebook per una proposta Calabria' usa SOLO createContent", async () => {
  // Il modello passa solo topic/type/platforms/withMedia, come nel run reale
  // del 26/09: la copy resta quindi al fallback deterministico e deve comunque
  // essere utilizzabile.
  const { images, toolEvents, toolData } = await runScripted(
    "Crea un post Instagram e Facebook per una proposta Calabria",
    [
      JSON.stringify({
        message: "Creo il post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              type: "POST",
              platforms: ["INSTAGRAM", "FACEBOOK"],
              withMedia: true,
            },
          },
        ],
      }),
      JSON.stringify({ message: "Post in DRAFT con visual." }),
    ]
  );

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["createContent"], "solo createContent, nessun tool di testo");
  assert.ok(!names.includes("generateCaption"), "mai generateCaption");
  assert.ok(!names.includes("generateHashtags"), "mai generateHashtags");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  const args = toolEvents[0].args as Record<string, unknown>;
  assert.deepEqual([...(args.platforms as string[])].sort(), [
    "FACEBOOK",
    "INSTAGRAM",
  ]);
  assert.equal(args.withMedia, true);

  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.withMedia, true, "createContent non genera immagini AI");
  assert.equal(typeof data.assetId, "string", "l'asset dello stock è dichiarato");
  assert.equal(data.topic, "proposta Calabria");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.deepEqual(
    content.platforms.map((p) => p.platform).sort(),
    ["FACEBOOK", "INSTAGRAM"]
  );
  assert.equal(content.assets.length, 1, "il DRAFT nasce col visual recuperato");
  assert.equal(images.calls.length, 0, "nessun immagine generata");

  // Copy di fallback: non vuota, non banale, coerente col'argomento.
  const caption = content.caption ?? "";
  assert.ok(caption.trim().length > 20, "la caption di fallback non può essere vuota");
  assert.notEqual(
    caption.trim().toLowerCase(),
    "proposta calabria",
    "la caption non può essere il topic ripetito"
  );
  assert.match(caption, /calabria/i, "la caption deve parlare del topic");
  assert.notEqual(
    (content.title ?? "").trim(),
    caption.trim(),
    "il titolo non può essere la caption"
  );
  assert.notEqual(
    (content.title ?? "").trim(),
    "proposta Calabria",
    "il titolo non può essere il topic ripetito"
  );
});

test("B. 'Scrivimi una caption sulla Calabria' usa generateCaption e non createContent", async () => {
  const { toolEvents } = await runScripted("Scrivimi una caption sulla Calabria", [
    JSON.stringify({
      message: "Scrivo la caption.",
      tool_calls: [{ name: "generateCaption", arguments: { topic: "Calabria" } }],
    }),
    JSON.stringify({ message: "Ecco la caption." }),
  ]);

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["generateCaption"]);
  assert.ok(!names.includes("createContent"), "una richiesta di solo testo non crea contenuti");
});

test("C. 'Dammi hashtag per Calabria' usa generateHashtags e non createContent", async () => {
  const { toolEvents } = await runScripted("Dammi hashtag per Calabria", [
    JSON.stringify({
      message: "Genero gli hashtag.",
      tool_calls: [{ name: "generateHashtags", arguments: { topic: "Calabria", count: 10 } }],
    }),
    JSON.stringify({ message: "Ecco gli hashtag." }),
  ]);

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["generateHashtags"]);
  assert.ok(!names.includes("createContent"), "una richiesta di soli hashtag non crea contenuti");
});

test("D. 'Crea un post per Isola d'Elba' usa SOLO createContent e non inventa destinazioni", async () => {
  // Anche qui il modello passa solo topic/type/platforms: la caption arriva
  // dal fallback e non deve contenere altre destinazioni.
  const { images, toolEvents, toolData } = await runScripted(
    "Crea un post per Isola d'Elba",
    [
      JSON.stringify({
        message: "Creo il post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "Isola d'Elba",
              type: "POST",
              platforms: ["INSTAGRAM"],
              withMedia: true,
            },
          },
        ],
      }),
      JSON.stringify({ message: "Post in DRAFT." }),
    ]
  );

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["createContent"]);
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.topic, "Isola d'Elba");
  assert.equal(data.withMedia, true);
  assert.equal(images.calls.length, 0, "nessuna generazione di immagini");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 1, "il DRAFT nasce col visual recuperato");
  const caption = content.caption ?? "";
  assert.ok(caption.trim().length > 0, "la caption non può essere vuota");
  assert.match(caption, /elba/i, "la caption deve restare sul topic");
  assert.deepEqual(foreignIn(caption), [], "nessuna destinazione estranea in caption");
});

test("E. 'Dammi tre idee per la Sardegna' usa SOLO createIdea", async () => {
  const { toolEvents, toolData } = await runScripted("Dammi tre idee per la Sardegna", [
    JSON.stringify({
      message: "Creo le idee.",
      tool_calls: [
        {
          name: "createIdea",
          arguments: {
            title: "Sardegna fuori stagione",
            description: "Itinerario slow tra spiagge e borghi",
            topic: "Sardegna",
          },
        },
      ],
    }),
    JSON.stringify({ message: "Idee salvate." }),
  ]);

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["createIdea"]);
  assert.ok(!names.includes("createContent"), "le idee non creano contenuti");
  const data = await toolData("createIdea");
  assert.equal(typeof data.id, "string", "l'idea deve essere salvata");
  assert.equal(data.title, "Sardegna fuori stagione");
  await prisma.contentIdea.delete({ where: { id: String(data.id) } }).catch(() => {});
});

test("F. 'Crea un reel sulla Sardegna' usa SOLO createContent con type VIDEO", async () => {
  const { toolEvents, toolData } = await runScripted("Crea un reel sulla Sardegna", [
    JSON.stringify({
      message: "Creo il reel.",
      tool_calls: [
        {
          name: "createContent",
          arguments: {
            topic: "Sardegna",
            type: "VIDEO",
            title: "Sardegna, wild beauty",
            caption: "Una proposta di viaggio in Sardegna.",
            hashtags: "#sardegna #viaggi",
            platforms: ["INSTAGRAM"],
          },
        },
      ],
    }),
    JSON.stringify({ message: "Reel in DRAFT." }),
  ]);

  const names = calledTools(toolEvents);
  assert.deepEqual(names, ["createContent"]);
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  const args = toolEvents[0].args as Record<string, unknown>;
  assert.equal(args.type, "VIDEO");
  assert.equal(args.topic, "Sardegna");

  const data = await toolData("createContent");
  contentIds.push(String(data.id));

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.type, "VIDEO");
  assert.ok(content.platforms.length > 0, "il reel ha comunque le piattaforme");
});

test("G. createContent non produce mai un DRAFT incompleto (senza piattaforme/topic/testo)", async () => {
  // Il bug: generateCaption senza contentId creava un DRAFT con platforms
  // vuote, topic assente e nessun asset. Ora la creazione passa solo da
  // createContent, quindi ogni nuovo DRAFT deve essere completo.
  const before = await prisma.content.count();

  const { toolEvents, toolData } = await runScripted(
    "Crea un post Instagram e Facebook per una proposta Calabria",
    [
      JSON.stringify({
        message: "Creo il post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              type: "POST",
              title: "Calabria, il Sud che fa sognare",
              caption: "Una proposta di viaggio in Calabria.",
              hashtags: "#calabria",
              platforms: ["INSTAGRAM", "FACEBOOK"],
            },
          },
        ],
      }),
      JSON.stringify({ message: "Post in DRAFT." }),
    ]
  );

  assert.deepEqual(calledTools(toolEvents), ["createContent"]);

  const data = await toolData("createContent");
  contentIds.push(String(data.id));

  const created = await prisma.content.findMany({ where: { id: String(data.id) } });
  assert.equal(created.length, 1);
  assert.equal(
    await prisma.content.count(),
    before + 1,
    "una sola richiesta di creazione produce un solo Content"
  );

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.ok(content.platforms.length > 0, "mai piattaforme vuote");
  assert.ok(content.caption && content.caption.length > 0, "mai DRAFT senza testo");

  // il topic non è una colonna di Content: torna nel risultato del tool
  // (createContent non registra un AIJob, a differenza di generateHashtags).
  assert.equal(data.topic, "proposta Calabria", "topic richiesto dal modello");
  assert.equal(data.id, String(data.id));
  assert.equal(
    (await prisma.content.count({ where: { id: String(data.id) } })),
    1,
    "un solo Content per la richiesta"
  );
});

test("H. una seconda createContent nello stesso run viene bloccata (1 richiesta = 1 DRAFT)", async () => {
  // Regressione sul test reale del 26/09: sei DRAFT consecutivi per un solo
  // prompt. Qui il modello chiede la creazione due volte nello stesso envelope:
  // la seconda deve essere bloccata, non eseguita.
  const before = await prisma.content.count();
  const draftsBefore = await prisma.content.count({ where: { status: "DRAFT" } });
  // Gli id di partenza servono a contare i Content creati da QUESTO test.
  // Un confronto per titolo non basterebbe: restano sul database righe
  // prodotte da run precedenti con lo stesso titolo.
  const idsBefore = new Set(
    (await prisma.content.findMany({ select: { id: true } })).map((row) => row.id)
  );

  const { ai, images, toolEvents, toolData, finalEvents } = await runScripted(
    "Crea un post Instagram e Facebook per una proposta Calabria",
    [
      JSON.stringify({
        message: "Creo il post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              type: "POST",
              platforms: ["INSTAGRAM", "FACEBOOK"],
            },
          },
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              type: "POST",
              platforms: ["INSTAGRAM", "FACEBOOK"],
            },
          },
          { name: "generateCaption", arguments: { topic: "Calabria" } },
        ],
      }),
      JSON.stringify({ message: "Ne creo un altro." }),
    ]
  );

  const names = calledTools(toolEvents);
  assert.equal(names.length, 3, "le tre chiamate del modello restano visibili in chat");
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));

  // 2a. il duplicato è bloccato, non eseguito
  assert.equal(toolEvents[1].name, "createContent");
  assert.equal(toolEvents[1].ok, false, "la seconda creazione deve essere bloccata");
  assert.match(String(toolEvents[1].error ?? ""), /già stato creato in questo turno/);
  // Il blocco non espone identificatori: questo testo finisce in chat.
  assert.doesNotMatch(String(toolEvents[1].error ?? ""), /cmu[a-z0-9]{10,}/i);

  // 2b. i tool di testo sono bloccati: la copy è già stata creata
  assert.equal(toolEvents[2].name, "generateCaption");
  assert.equal(toolEvents[2].ok, false, "generateCaption dopo createContent è ridondante");

  // 2c. il codice strutturato del blocco è persistito
  const blocked = await prisma.chatMessage.findFirst({
    where: { toolName: "createContent", content: { contains: "content_already_created" } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(blocked, "il blocco deve riportare content_already_created");
  const redundant = await prisma.chatMessage.findFirst({
    where: { toolName: "generateCaption", content: { contains: "text_already_covered" } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(redundant, "il blocco dei tool di testo deve riportare text_already_covered");

  // 2d. un solo Content creato, un solo DRAFT
  const data = await toolData("createContent");
  if (data.id) contentIds.push(String(data.id));
  assert.equal(
    await prisma.content.count(),
    before + 1,
    "una richiesta non può creare più di un Content"
  );
  const drafts = await prisma.content.count({ where: { status: "DRAFT" } });
  assert.equal(drafts, draftsBefore + 1, "un solo DRAFT nuovo");
  // Il titolo non lo decide il modello: lo compone il fallback copy a partire
  // dal topic (cfr. test deterministico in fondo al file). Qui si verifica che
  // derivi dal topic richiesto e che il turno abbia salvato UN solo Content,
  // senza filtri sul titolo: `toolData` restituisce l'ultimo messaggio del
  // tool, cioè quello bloccato, quindi l'id va cercato per differenza.
  const created = await prisma.content.findMany({
    where: { id: { notIn: [...idsBefore] } },
    select: { id: true, title: true, status: true },
  });
  contentIds.push(...created.map((row) => row.id));
  assert.equal(created.length, 1, "una richiesta non può creare più di un Content");
  assert.equal(created[0].status, "DRAFT", "il Content creato è un DRAFT");
  assert.ok(created[0].title, "il DRAFT deve avere un titolo");
  // Il titolo è il nome del luogo, non il topic: "Proposta Calabria" è la
  // richiesta, "Calabria" è la destinazione, e solo la seconda sta su un post.
  assert.match(
    created[0].title,
    /^Calabria\b/,
    "il titolo deve essere il nome della destinazione richiesta"
  );
  assert.doesNotMatch(
    created[0].title,
    /proposta di viaggio|la nostra proposta|da vivere con calma/i,
    "il titolo non può essere una formula generica"
  );

  // 2e. nessuna immagine AI generata e turno chiuso
  assert.equal(images.calls.length, 0, "Magnific non deve essere chiamato");
  assert.equal(ai.calls.length, 1, "il turno si chiude dopo la creazione");
  assert.equal(finalEvents.length, 1);
  // La chiusura è la sola frase del tool: nessuna istruzione aggiuntiva, che
  // l'utente non ha chiesto e che non servirebbe a nulla.
  assert.equal(
    finalEvents[0].text,
    "Post creato con successo in stato DRAFT. Lo trovi nella sezione Contenuti."
  );
});

test("il contratto dichiara createContent come unico tool di creazione", () => {  const REPO = process.cwd();
  const read = (p: string) => readFileSync(join(REPO, p), "utf8");
  const generation = read("src/lib/ai/tools/generation.ts");
  const content = read("src/lib/ai/tools/content.ts");

  // generateCaption / generateHashtags: solo testo, mai come passo di creazione
  assert.match(generation, /Genera SOLO il testo \(caption\)/);
  assert.match(generation, /Genera SOLO hashtag/);
  assert.match(generation, /se l'utente chiede di creare un post, un reel o un contenuto, usa createContent/);

  // createContent: creazione completa, senza contentId. Il "NON genera
  // immagini AI" vale per il ramo senza catalogo: il flusso catalogo
  // materializza invece il visuale (la promessa è verificata nella suite del
  // Catalog Flow, non qui).
  assert.match(content, /nuovo Content in DRAFT/);
  assert.match(content, /non serve alcun contentId/);
  // Il sorgente è un literal TypeScript: le virgolette interne sono escaped,
  // quindi il backslash è opzionale nel pattern.
  assert.match(content, /SENZA catalogo \(solo \\?"topic\\?"\): il visual viene SEMPRE recuperato/);
  // La generazione è il ripiego, non il primo percorso, e va dichiarata.
  assert.match(content, /il visual viene GENERATO con il provider immagini/);
  // Il numero di post richiesto è vincolante: una chiamata per post, tutti
  // nello stesso turno, e solo per un solo post ci si ferma a una chiamata.
  assert.match(content, /puoi chiamarlo PIÙ VOLTE nello stesso turno/);
  assert.match(content, /Per un solo post basta una chiamata/);
});

test("il SYSTEM_PROMPT è gerarchico, compatto e senza regole duplicate", () => {
  const agent = readFileSync(join(process.cwd(), "src", "lib", "ai", "agent.ts"), "utf8");

  // Le sezioni richieste, in quest'ordine: gerarchia leggibile per qwen3:8b.
  const sections = [
    "## RUOLO",
    "## REGOLA PRINCIPALE",
    "## CREAZIONE CONTENUTI",
    "## GENERAZIONE PARZIALE",
    "## IDEE",
    "## CONTENUTI ESISTENTI",
    "## VISUAL",
    "## PIATTAFORME",
    "## COPY",
    "## SICUREZZA",
    "## RISPOSTA",
  ];
  let cursor = -1;
  for (const section of sections) {
    const at = agent.indexOf(section);
    assert.ok(at > cursor, `sezione mancante o fuori ordine: ${section}`);
    cursor = at;
  }

  // Le regole operative ci sono tutte.
  assert.match(agent, /È un VINCOLO: copy, hashtag e immagine parlano solo di quello/);
  assert.match(agent, /platforms: array con le piattaforme richieste/);
  assert.match(agent, /type: "POST" o "VIDEO"/);
  assert.match(agent, /Carousel: createCarousel/);
  assert.match(agent, /DRAFT → APPROVED → SCHEDULED → PUBLISHED/);
  assert.match(agent, /confirm=true/);
  assert.match(agent, /Non inventare prezzi, date, hotel, voli, durata, offerte o servizi/);
  assert.match(agent, /Titolo e caption distinti/);
  assert.match(agent, /Non inventarli/);

  // Il titolo: la regola che il modello non può violate da solo, perché è la
  // parte stampata più in grande sul fotogramma.
  assert.match(agent, /Il titolo contiene SEMPRE il nome della destinazione richiesta/);
  assert.match(agent, /Formentera/);
  assert.match(agent, /Mallorca/);
  assert.match(agent, /I segreti di Formentera/);
  assert.match(agent, /VIETATO un titolo generico/);
  assert.match(agent, /vacanza in spiaggia/);
  // E la struttura della caption segue il formato scelto.
  assert.match(agent, /3 punti per TRAVEL_TIPS/);
  assert.match(agent, /una tappa o un\s+giorno per riga per ITINERARY/);
  assert.match(agent, /domanda e risposta per FAQ/);

  // Una richiesta multipla produce tutti i post, e il visual non è mai
  // generato: la ricerca nella libreria stock è l'unico percorso.
  assert.match(agent, /PIÙ POST NELLO STESSO TURNO/);
  assert.match(agent, /non fermarti al primo/);
  assert.match(agent, /Per un solo post basta una chiamata/);
  assert.match(agent, /createContent NON genera immagini AI/);
  assert.match(agent, /nessun post resta senza visual/);
  assert.match(agent, /solo se l'utente la chiede esplicitamente/);

  // Nessun vincolo di catalogo è rimasto nel prompt: la creazione non dipende
  // dall'esistenza della destinazione nel Catalogo.
  assert.doesNotMatch(agent, /## CATALOGO/);
  assert.doesNotMatch(agent, /NON creare il DRAFT/);
  assert.doesNotMatch(agent, /SEMPRE prima searchCatalog/);
  assert.doesNotMatch(agent, /Non usare mai la tua memoria sul catalogo/);
  assert.doesNotMatch(
    agent,
    /Prima di dirlo devi aver chiamato searchCatalog in questo turno/
  );

  // E la regola opposta è dichiarata: qualsiasi destinazione produce i contenuti.
  assert.match(agent, /Qualsiasi destinazione o argomento è ammesso/);
  assert.match(agent, /crea SEMPRE i contenuti richiesti/);
  assert.match(agent, /Nessun controllo di catalogo blocca la creazione/);

  // Nessuna regola ripetuta: contiamo le due che in passato si duplicavano.
  const count = (needle: string) => agent.split(needle).length - 1;
  assert.equal(
    count("NON usare generateCaption o generateHashtags come passaggi intermedi"),
    1,
    "il divieto dei tool intermedi deve comparire una volta sola"
  );
  assert.equal(
    count("È un VINCOLO"),
    1,
    "il vincolo sul topic non deve essere ripetuto"
  );
  assert.equal(
    count("PIÙ POST NELLO STESSO TURNO"),
    1,
    "la regola dei più post nello stesso turno deve comparire una volta sola"
  );
});

test("il fallback copy è deterministico, non vuoto e non ripete il topic", () => {
  const sample = () => fallbackCopyFromTopic({ topic: "proposta Calabria" });
  const first = sample();
  assert.deepEqual(sample(), first, "stesso topic, stesso risultato");

  const caption = first.caption ?? "";
  assert.ok(caption.trim().length > 20, "la caption non può essere vuota o banale");
  assert.notEqual(caption.trim().toLowerCase(), "proposta calabria");
  assert.match(caption, /calabria/i);
  assert.ok(!/^proposta:/i.test(caption), "niente ripetizione meccanica del topic");
  assert.notEqual((first.title ?? "").trim(), caption.trim(), "titolo e caption distinti");
  assert.ok((first.hashtags ?? "").length > 0);

  // Nessun fatto commerciale inventato: prezzi, date, strutture o servizi.
  assert.doesNotMatch(
    caption,
    /€|euro|prezzo|\d{1,2}\s*(giorni|notti)|hotel|volo|offerta|soggiorno/i
  );
  assert.doesNotMatch(caption, /amalfi|costiera|puglia|sardegna|sicilia|roma|parigi|tokyo/i);
});

/* ------------------------------------------------------------------------- *
 * H2: cap dei tool result.
 *
 * Il prompt cresce a ogni round di un envelope più un risultato per tool
 * chiamato. Senza un tetto, un `listContents` o un `searchCatalog` con molte
 * proposte faceva superare il context window già dal secondo giro. I limiti
 * sono importati dal codice: il test non può passare se i due divergono.
 * ------------------------------------------------------------------------- */

/** Dati enormi, come quelli di un elenco di contenuti o di proposte catalogo. */
function bulkyData(id: string) {
  return {
    id,
    title: "Titolo",
    status: "DRAFT",
    caption: "x".repeat(2000),
    platforms: ["INSTAGRAM"],
  };
}

test("H2. sotto il limite il risultato resta identico a quello non compresso", () => {
  const result = { ok: true, message: "Contenuto creato (id abc).", data: { id: "abc", status: "DRAFT" } };

  const text = compactToolResult(result);

  // stessa formula di sempre: nessuna compressione sotto soglia
  assert.equal(text, `ok: ${result.message} data=${JSON.stringify(result.data)}`);
  assert.ok(text.length < TOOL_RESULT_MAX);
});

test("H2. sopra il limite il risultato viene troncato ma conserva ok e message", () => {
  const result = { ok: true, message: "Trovate 8 proposte.", data: bulkyData("p1") };

  const text = compactToolResult(result);

  assert.ok(text.length <= TOOL_RESULT_MAX, `oltre il limite singolo: ${text.length}`);
  assert.ok(text.startsWith(`ok: ${result.message} data={`), "esito e message intatti");
  assert.ok(text.includes('"id":"p1"'), "l'identificativo iniziale resta leggibile");
  assert.ok(text.endsWith("…"), "il dato troncato deve essere marcato");
});

test("H2. ok e message non vengono mai persi, nemmeno senza spazio per i dati", () => {
  // max 0 = budget residuo del round esaurito: spariscono i dati, non l'esito.
  assert.equal(
    compactToolResult({ ok: false, message: "serve la conferma esplicita", data: { a: 1 } }, 0),
    "errore: serve la conferma esplicita"
  );
  // un messaggio più lungo del tetto resta comunque intero
  const long = "m".repeat(3000);
  assert.equal(compactToolResult({ ok: true, message: long }, 100), `ok: ${long}`);
});

test("H2. il codice di un esito bloccato resta leggibile", () => {
  assert.equal(
    compactToolResult({ ok: false, code: "content_already_created", message: "Contenuto già creato" }),
    "errore[content_already_created]: Contenuto già creato"
  );
  assert.equal(compactToolResult({ ok: true, message: "fatto" }), "ok: fatto");
});

test("H2. il cap cumulativo tiene più risultati entro il budget del round", () => {
  // stessa aritmetica del loop in agent.ts: il limite residuo scende a ogni
  // tool chiamato nello stesso round.
  const results = Array.from({ length: 5 }, (_, i) => ({
    ok: true,
    message: `Trovate ${i + 1} proposte del Catalogo.`,
    data: bulkyData(`p${i}`),
  }));

  let spent = 0;
  const texts = results.map((result) => {
    const limit = Math.max(0, Math.min(TOOL_RESULT_MAX, TOOL_ROUND_BUDGET - spent));
    const text = compactToolResult(result, limit);
    spent += text.length;
    return text;
  });

  for (const text of texts) {
    assert.ok(text.length <= TOOL_RESULT_MAX, `oltre il limite singolo: ${text.length}`);
  }
  const dataChars = texts.reduce(
    (acc, t) => acc + (t.includes(" data=") ? t.length - t.indexOf(" data=") - 6 : 0),
    0
  );
  assert.ok(dataChars <= TOOL_ROUND_BUDGET, `dati oltre il budget di round: ${dataChars}`);
  texts.forEach((text, i) => {
    assert.ok(
      text.startsWith(`ok: Trovate ${i + 1} proposte del Catalogo.`),
      "ogni risultato conserva esito e message"
    );
  });
});

test("H2. un risultato reale sopra 1200 caratteri arriva compresso al modello", async () => {
  // Caso reale: l'elenco dei contenuti supera abbondantemente il limite singolo
  // ed è reinviato al modello nel giro successivo.
  for (let i = 0; i < 12; i += 1) {
    const draft = await createContent({
      title: `[TEST] cap risultato ${i + 1}`,
      caption: `Didascalia di prova numero ${i + 1}. `.repeat(12),
      platforms: [Platform.INSTAGRAM],
    });
    contentIds.push(draft.id);
  }

  const { ai, toolEvents } = await runScripted("quali contenuti ho", [
    JSON.stringify({
      message: "Guardo i contenuti.",
      tool_calls: [{ name: "listContents", arguments: {} }],
    }),
    JSON.stringify({ message: "Ecco i contenuti." }),
  ]);

  assert.deepEqual(calledTools(toolEvents), ["listContents"]);
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));
  assert.equal(ai.calls.length, 2, "il secondo giro rimette il risultato nel prompt");

  const sent = ai.calls[1].find((m) => m.role === "tool");
  assert.ok(sent, "il risultato del tool deve essere rimesso nel prompt");
  const text = String(sent.content);
  assert.ok(text.length <= TOOL_RESULT_MAX, `oltre il limite singolo: ${text.length}`);
  assert.match(text, /^ok: Trovati \d+ contenuti\./, "esito e message intatti");
  assert.ok(text.endsWith("…"), "il risultato reale troppo grande deve essere troncato");
});

/* ---------------------------------------------------------------------------
 * H3: l'output del modello deve essere un envelope valido.
 *
 * Prima un output non JSON (prosa ragionata, JSON troncato) finiva nel
 * ramo "risposta finale" e veniva mostrato all'utente come se fosse una
 * risposta dell'agente, senza che nessun tool fosse stato eseguito. Ora
 * l'output viene classificato e, se non conforme, non diventa mai una
 * risposta: si concede un solo retry e poi un errore strutturato.
 * ------------------------------------------------------------------------- */

/** Output del modello che non contiene alcun envelope. */
const FREE_TEXT =
  "Per risponderti ho bisogno di ragionare passo passo. " +
  "Prima analizzo il Catalogo, poi confronto le proposte con la stagionalità, " +
  "infine valuto quali contenuti ha senso creare. ".repeat(6) +
  "Non sto usando strumenti, ma il risultato è lo stesso: ecco la mia analisi.";

/** JSON troncato: è ciò che produce un output tagliato dal limite di output. */
const MALFORMED_JSON = '{"message": "Ecco cosa ho trovato nel Catalogo", "tool_calls": [';

/** JSON valido, ma non è l'envelope: campi che il modello non dovrebbe usare. */
const SCHEMA_INVALID_JSON = JSON.stringify({
  risposta: "Ho analizzato il Catalogo e ti propongo 8 contenuti.",
  tool: "searchCatalog",
});

/** Contatore DRAFT, per provare che il retry non crei contenuti. */
async function draftCount() {
  return prisma.content.count({ where: { status: "DRAFT" } });
}

test("H3. envelope conforme con tool_calls: accettato, un solo giro", async () => {
  const { ai, toolEvents, finalEvents, result } = await runScripted(
    "dimmi cosa c'è da approvare",
    [
      JSON.stringify({
        message: "Controllo le approvazioni.",
        tool_calls: [{ name: READ_TOOL, arguments: {} }],
      }),
      JSON.stringify({ message: "Non c'è nulla da approvare." }),
    ]
  );

  assert.deepEqual(calledTools(toolEvents), [READ_TOOL], "il tool viene eseguito");
  assert.equal(ai.calls.length, 2);
  assert.equal(finalEvents[0].text, "Non c'è nulla da approvare.");
  assert.equal(result.ok, true);
});

test("H3. envelope conforme senza tool: la message è la risposta finale", async () => {
  const { ai, toolEvents, finalEvents } = await runScripted("ciao", [
    JSON.stringify({ message: "Ciao, sono l'assistente AI.", tool_calls: [] }),
  ]);

  assert.equal(ai.calls.length, 1, "nessun retry quando l'envelope è valido");
  assert.equal(toolEvents.length, 0);
  assert.equal(finalEvents[0].text, "Ciao, sono l'assistente AI.");
});

test("H3. testo libero del modello non diventa mai la risposta finale", async () => {
  const { ai, toolEvents, finalEvents } = await runScripted("crea un post", [
    FREE_TEXT,
    JSON.stringify({ message: "Non ho creato nulla." }),
  ]);

  assert.equal(ai.calls.length, 2, "un solo retry, poi si corregge");
  assert.equal(toolEvents.length, 0, "nessun tool eseguito");
  assert.equal(finalEvents.length, 1);
  assert.notEqual(finalEvents[0].text, FREE_TEXT.trim(), "la prosa non è la risposta");
  assert.ok(
    !finalEvents[0].text.includes("ragionare passo passo"),
    "nessun frammento della risposta ragionata a schermo"
  );
  // il retry è esplicito: stessa grammatica, stesso schema
  assert.match(String(ai.calls[1].at(-1)?.content), /tool_calls/);
});

test("H3. JSON malformato: rifiutato come non_json", async () => {
  const { ai, toolEvents, finalEvents } = await runScripted("crea un post", [
    MALFORMED_JSON,
    FREE_TEXT,
  ]);

  assert.equal(ai.calls.length, 2, "il retry non si ripete");
  assert.equal(toolEvents.length, 0);
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, /non ho eseguito nessuna operazione/i);
  assert.doesNotMatch(finalEvents[0].text, /[{}]/, "nessun JSON grezzo a schermo");
  assert.ok(!finalEvents[0].text.includes("Ecco cosa ho trovato"), "niente prosa grezza");
});

test("H3. JSON valido ma non conforme allo schema: rifiutato come schema_invalid", async () => {
  const { ai, toolEvents, finalEvents } = await runScripted("crea un post", [
    SCHEMA_INVALID_JSON,
    FREE_TEXT,
  ]);

  assert.equal(ai.calls.length, 2, "il retry non si ripete");
  assert.equal(toolEvents.length, 0, "nessun tool inventato");
  assert.equal(finalEvents.length, 1);
  assert.ok(
    !finalEvents[0].text.includes("ti propongo 8 contenuti"),
    "il messaggio del modello fuori schema non viene mostrato"
  );
  assert.match(finalEvents[0].text, /non ho eseguito nessuna operazione/i);
});

test("H3. più di un output non conforme: un solo retry in tutta l'esecuzione", async () => {
  // Tre round non conformi di fila: il terzo non genera un quarto giro.
  const { ai, finalEvents } = await runScripted("crea un post", [
    FREE_TEXT,
    MALFORMED_JSON,
    SCHEMA_INVALID_JSON,
    JSON.stringify({ message: "Dovrebbe arrivare qui, ma non deve." }),
  ]);

  assert.equal(ai.calls.length, 2, "massimo un retry per risposta malformata");
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, /non ho eseguito nessuna operazione/i);
  assert.notEqual(finalEvents[0].text, "Dovrebbe arrivare qui, ma non deve.");
});

test("H3. dopo un tool eseguito, un output non conforme dà l'errore di interruzione", async () => {
  const { ai, toolEvents, finalEvents, result } = await runScripted(
    "dimmi cosa c'è da approvare",
    [
      JSON.stringify({
        message: "Controllo le approvazioni.",
        tool_calls: [{ name: READ_TOOL, arguments: {} }],
      }),
      FREE_TEXT,
      FREE_TEXT,
    ]
  );

  assert.deepEqual(calledTools(toolEvents), [READ_TOOL], "il tool resta eseguito una volta");
  assert.equal(ai.calls.length, 3, "il retry avviene una sola volta, dopo il tool");
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, /non era interpretabile/i, "errore strutturato");
  assert.match(finalEvents[0].text, /controlla lo stato aggiornato/i);
  assert.equal(result.executed?.length, 1, "l'esecuzione reale non viene persa");
});

test("H3. il retry non duplica tool call, DRAFT, asset o messaggi", async () => {
  const draftsBefore = await draftCount();

  const { ai, images, toolEvents, finalEvents, toolData } = await runScripted(
    "Crea un post Instagram per la proposta Calabria",
    [
      FREE_TEXT,
      JSON.stringify({
        message: "Creo il post.",
        tool_calls: [
          {
            name: "createContent",
            arguments: {
              topic: "proposta Calabria",
              type: "POST",
              platforms: ["INSTAGRAM"],
            },
          },
        ],
      }),
      JSON.stringify({ message: "Ho creato il post." }),
    ]
  );

  // il tool viene eseguito una sola volta, dopo il retry
  assert.deepEqual(calledTools(toolEvents), ["createContent"]);
  assert.equal(toolEvents[0].ok, true, String(toolEvents[0].error ?? ""));
  // dopo un createContent riuscito il turno finisce: due chiamate al modello
  assert.equal(ai.calls.length, 2, "un round scartato, il retry, un round utile");

  const data = await toolData("createContent");
  const created = String(data.id);
  contentIds.push(created);
  assert.equal(await draftCount(), draftsBefore + 1, "esattamente un DRAFT in più");
  // nessuna richiesta di immagine: il retry non ha generato un secondo asset
  assert.equal(images.calls.length, 0, "nessuna immagine generata");

  // la prosa del round scartato non entra in chat: solo in memoria, per il retry
  const persisted = await prisma.chatMessage.findMany({
    where: { conversationId: await lastConversationId() },
  });
  const raw = persisted.map((m) => m.content).join("\n");
  assert.ok(!raw.includes("ragionare passo passo"), "la prosa scartata non viene persistita");
  assert.equal(
    persisted.filter((m) => m.role === "TOOL" && m.toolName === "createContent").length,
    1,
    "un solo messaggio TOOL: nessuna duplicazione"
  );
  assert.ok(
    !finalEvents[0].text.includes("ragionare passo passo"),
    "la risposta finale non contiene la prosa scartata"
  );
});

test("H3. l'errore finale non contiene mai l'output grezso del modello", async () => {
  for (const reply of [FREE_TEXT, MALFORMED_JSON, SCHEMA_INVALID_JSON, "[{\"message\":\"x\"}]"]) {
    const { finalEvents } = await runScripted("crea un post", [reply, reply]);
    assert.equal(finalEvents.length, 1);
    assert.doesNotMatch(finalEvents[0].text, /[{}[\]]/, `output grezzo mostrato: ${reply.slice(0, 40)}`);
    assert.ok(
      !finalEvents[0].text.includes(reply.slice(0, 20)),
      "l'output del modello non viene riproposto all'utente"
    );
  }
});

/** Ultima conversazione creata da `runScripted`: serve ai controlli sul DB. */
async function lastConversationId() {
  const row = await prisma.chatConversation.findFirst({
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  assert.ok(row, "la conversazione di test deve esistere");
  return row.id;
}



