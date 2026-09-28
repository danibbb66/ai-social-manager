import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Platform } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { runAgent, type AgentStreamEvent } from "../src/lib/ai/agent";
import { fallbackCopyFromTopic } from "../src/lib/ai/content-copy";
import { setAiProvider } from "../src/lib/ai/factory";
import type {
  AiChatMessage,
  AiCompletion,
  AiPingResult,
  AiProvider,
} from "../src/lib/ai/provider";
import { getOrCreateConversation } from "../src/lib/services/chat";
import { getContent, deleteContent, createContent } from "../src/lib/services/content";
import { setImageProvider } from "../src/lib/images/factory";
import type { GeneratedImage, ImageProvider } from "../src/lib/images/provider";

/**
 * Envelope dell'agente e percorso Chat → createContent.
 *
 * Il modello locale non produce sempre `{"message", "tool_calls"}`: nei test
 * reali del 26/09 ha emesso `{"action", "params"}` e `{}`. Qui il provider AI
 * è uno script finto (nessuna chiamata a Ollama) e il provider immagini è un
 * doppione (nessuna chiamata a Magnific, nessun consumo di crediti).
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
/** Istante di avvio: serve a ripulire gli AIJob generati dai test. */
const TEST_START = new Date();

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

  const events: AgentStreamEvent[] = [];
  const result = await runAgent({
    conversationId: conversation.id,
    userMessage,
    emit: (e) => events.push(e),
  });

  const toolEvents = events.filter((e): e is ToolEvent => e.type === "tool");
  const finalEvents = events.filter((e): e is FinalEvent => e.type === "final");

  /** `data` dell'ultimo createContent eseguito in questa conversazione. */
  const toolData = async (toolName: string): Promise<Record<string, unknown>> => {
    const row = await prisma.chatMessage.findFirst({
      where: { conversationId: conversation.id, role: "TOOL", toolName },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row, `il tool ${toolName} deve aver lasciato il proprio messaggio`);
    const parsed = JSON.parse(row.content) as { data?: Record<string, unknown> };
    return parsed.data ?? {};
  };

  return { ai, images, result, events, toolEvents, finalEvents, toolData };
}

function foreignIn(text: string): string[] {
  return FOREIGN.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(text));
}

after(async () => {
  setAiProvider(null);
  setImageProvider(null);
  for (const id of contentIds.splice(0)) {
    await deleteContent(id).catch(() => {});
  }
  for (const id of conversationIds.splice(0)) {
    await prisma.chatConversation.delete({ where: { id } }).catch(() => {});
  }
  // i tool di testo lasciano traccia in AIJob: niente residui di test
  await prisma.aIJob.deleteMany({ where: { createdAt: { gte: TEST_START } } }).catch(() => {});
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
  assert.match(String(toolEvents[0].error), /Parametri non validi/);
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

  // 3. il DRAFT è completo di testo e piattaforme, SENZA visual generato
  const data = await toolData("createContent");
  contentIds.push(String(data.id));
  assert.equal(data.topic, "proposta Calabria");
  assert.equal(data.withMedia, false, "createContent non deve generare immagini");
  assert.equal(data.assetId, null, "nessun asset generato");
  assert.equal(images.calls.length, 0, "Magnific non deve mai essere chiamato da qui");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.deepEqual(
    content.platforms.map((p) => p.platform).sort(),
    ["FACEBOOK", "INSTAGRAM"]
  );
  assert.equal(content.assets.length, 0, "il DRAFT resta senza visual");
  assert.ok((content.caption ?? "").length > 0, "la copy c'è comunque");

  // 4. il turno si chiude dopo la creazione: il modello non viene richiamato
  //    per continuare a ragionare e creare altri contenuti.
  assert.equal(ai.calls.length, 1, "un solo round di modello per la creazione");
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, new RegExp(String(data.id)));
  assert.match(finalEvents[0].text, /Ho chiuso il turno qui/);
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
  assert.equal(data.withMedia, false, "nessun visual generato");
  assert.equal(data.assetId, null);
  assert.equal(images.calls.length, 0, "Magnific non viene chiamato");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 0, "il DRAFT resta senza visual");
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
  assert.equal(data.withMedia, false, "createContent non genera immagini");
  assert.equal(images.calls.length, 0, "nessuna chiamata al provider immagini");
  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 0);
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
  assert.match(String(toolEvents[0].error), /Parametri non validi|conferma/i);
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
  // il risultato del tool resta tracciato
  assert.ok(rows.some((r) => r.role === "TOOL" && r.toolName === READ_TOOL));
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
  assert.match(String(toolEvents[0].error), /Parametri non validi/);
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
  assert.equal(data.withMedia, false, "createContent non genera immagini AI");
  assert.equal(data.assetId, null, "nessun asset generato");
  assert.equal(data.topic, "proposta Calabria");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.status, "DRAFT");
  assert.deepEqual(
    content.platforms.map((p) => p.platform).sort(),
    ["FACEBOOK", "INSTAGRAM"]
  );
  assert.equal(content.assets.length, 0, "il DRAFT resta senza visual");
  assert.equal(images.calls.length, 0, "Magnific non deve mai essere chiamato");

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
  assert.equal(data.withMedia, false);
  assert.equal(images.calls.length, 0, "nessuna generazione di immagini");

  const content = await getContent(String(data.id));
  assert.ok(content);
  assert.equal(content.assets.length, 0, "il DRAFT resta senza visual");
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
  assert.match(String(toolEvents[1].error ?? ""), /già creato in questo turno/);

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
  assert.match(
    created[0].title,
    /^Proposta Calabria\b/,
    "il titolo deve partire dal topic richiesto"
  );

  // 2e. nessuna immagine AI generata e turno chiuso
  assert.equal(images.calls.length, 0, "Magnific non deve essere chiamato");
  assert.equal(ai.calls.length, 1, "il turno si chiude dopo la creazione");
  assert.equal(finalEvents.length, 1);
  assert.match(finalEvents[0].text, /Ho chiuso il turno qui/);
});

test("il contratto dichiara createContent come unico tool di creazione", () => {
  const REPO = process.cwd();
  const read = (p: string) => readFileSync(join(REPO, p), "utf8");
  const generation = read("src/lib/ai/tools/generation.ts");
  const content = read("src/lib/ai/tools/content.ts");

  // generateCaption / generateHashtags: solo testo, mai come passo di creazione
  assert.match(generation, /Genera SOLO il testo \(caption\)/);
  assert.match(generation, /Genera SOLO hashtag/);
  assert.match(generation, /se l'utente chiede di creare un post, un reel o un contenuto, usa createContent/);

  // createContent: creazione completa, senza contentId e senza immagini AI
  assert.match(content, /nuovo Content in DRAFT/);
  assert.match(content, /non serve alcun contentId/);
  assert.match(content, /NON genera immagini AI/);
  assert.match(content, /Chiamalo una sola volta per richiesta/);
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

  // Una richiesta = un contenuto, e nessuna immagine AI automatica.
  assert.match(agent, /Chiamalo una sola volta per richiesta/);
  assert.match(agent, /NON immagini: resta senza visual/);
  assert.match(
    agent,
    /createContent non genera mai immagini: il DRAFT nasce senza visual e si completa dalla Media Library/
  );
  assert.match(agent, /solo se l'utente la chiede esplicitamente/);

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
    count("senza visual"),
    2,
    "la regola 'senza visual' compare una volta in CREAZIONE e una in VISUAL"
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


