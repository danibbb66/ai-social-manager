import { AiChatMessage, AiUnavailableError } from "@/lib/ai/provider";
import { getAiProvider } from "@/lib/ai/factory";
import { buildAgentEnvelopeSchema } from "@/lib/ai/ollama";
import { getTool, toolsSystemDescription, AI_TOOLS, toolSchemaVariants } from "@/lib/ai/tools/registry";
import { tryParseJson } from "@/lib/ai/generate";
import { getConversation, getMessageHistory, toAiMessages, addMessages } from "@/lib/services/chat";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";

export type AgentStreamEvent =
  | { type: "round"; n: number }
  | {
      type: "tool";
      name: string;
      label: string;
      args: unknown;
      ok?: boolean;
      error?: string;
    }
  | { type: "final"; text: string }
  | { type: "error"; text: string };

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Perché l'output del modello non è un envelope utilizzabile.
 *
 * - `non_json`: non è JSON. Prose libera, oppure JSON troncato o che non
 *   contiene un oggetto `{...}` estraibile.
 * - `schema_invalid`: è JSON valido ma non è l'envelope: nessuna `message`
 *   utilizzabile e nessuna tool call riconoscibile (es. `{}`).
 */
type EnvelopeIssue = "non_json" | "schema_invalid";

interface ParsedAgentReply {
  toolCalls: ToolCall[];
  message?: string;
  /**
   * Presente solo quando l'output non è un envelope valido. In quel caso
   * `message` non c'è: l'output non diventa mai una risposta per l'utente.
   */
  issue?: EnvelopeIssue;
}

/** Chiavi con cui il modello può aver nominato i parametri di una singola call. */
const ARGUMENT_KEYS = ["arguments", "args", "parameters", "params"] as const;

/** Normalizza gli argomenti di una call da stringa JSON, oggetto o assenti. */
function toArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // argomenti non parsabili: si continua con un oggetto vuoto
    }
  }
  return {};
}

function toToolCall(nameRaw: unknown, argsRaw: unknown): ToolCall | null {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  return name ? { name, arguments: toArguments(argsRaw) } : null;
}

function firstArgumentKey(obj: Record<string, unknown>): unknown {
  for (const key of ARGUMENT_KEYS) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

/**
 * Estrae le tool call da uno qualsiasi degli envelope usati dal modello.
 *
 * Riconosciuti, tutti normalizzati in `{ name, arguments }`:
 * - formato moderno: `{"tool_calls": [{"name", "arguments"}]}`
 * - legacy: `{"action": "...", "parameters" | "params" | "args": {...}}`
 * - legacy variante: `{"tool": "...", "params" | "parameters": {...}}`
 * - stile OpenAI: `{"name": "...", "arguments": {...}}`
 *
 * Sugli envelope legacy la call viene prodotta solo se c'è un oggetto
 * argomenti esplicito: evita di eseguire un tool per un falso positivo.
 */
function parseToolCalls(obj: Record<string, unknown>): ToolCall[] {
  const calls: ToolCall[] = [];
  const push = (call: ToolCall | null) => {
    if (call) calls.push(call);
  };

  if (Array.isArray(obj.tool_calls)) {
    for (const entry of obj.tool_calls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      push(toToolCall(rec.name, firstArgumentKey(rec)));
    }
    return calls;
  }

  if (obj.tool_calls !== undefined) {
    const rec = obj.tool_calls;
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const r = rec as Record<string, unknown>;
      push(toToolCall(r.name, firstArgumentKey(r)));
    }
    return calls;
  }

  // Envelope legacy: nome in `action`, `tool` o `name`.
  for (const key of ["action", "tool", "name"] as const) {
    const nameRaw = obj[key];
    if (typeof nameRaw !== "string" || !nameRaw.trim()) continue;
    const argsRaw = firstArgumentKey(obj);
    if (argsRaw === undefined) continue;
    push(toToolCall(nameRaw, argsRaw));
    break;
  }
  return calls;
}

/**
 * Classifica l'output del modello.
 *
 * Un envelope è valido in due casi, e solo due:
 * 1. contiene almeno una tool call riconoscibile (schema moderno o envelope
 *    legacy): viene eseguito, come prima;
 * 2. non ha tool call ma ha un `message` non vuoto: è la risposta finale.
 *
 * Tutto il resto non è un envelope: `non_json` (prosa, JSON troncato) o
 * `schema_invalid` (JSON valido senza `message` e senza tool call). Prima
 * invece la prosa libera diventava la risposta finale mostrata all'utente,
 * mentre il modello non aveva eseguito nulla.
 */
function parseAgentReply(raw: string): ParsedAgentReply {
  const json = tryParseJson(raw);
  if (!json) {
    return { toolCalls: [], issue: "non_json" };
  }
  if (typeof json !== "object" || Array.isArray(json)) {
    // JSON valido (per esempio un array) ma non l'oggetto envelope
    return { toolCalls: [], issue: "schema_invalid" };
  }
  const obj = json as Record<string, unknown>;
  const toolCalls = parseToolCalls(obj);
  const message =
    typeof obj.message === "string" && obj.message.trim()
      ? obj.message.trim()
      : undefined;
  if (toolCalls.length === 0 && !message) {
    return { toolCalls, issue: "schema_invalid" };
  }
  return { toolCalls, message };
}

export const SYSTEM_PROMPT = `## RUOLO
Sei l'assistente AI Social Manager di un'agenzia di viaggi. Rispondi sempre in italiano.
Usi tool reali sui dati: se un tool risponde ok:false riporta il suo messaggio, non inventare risultati.

## REGOLA PRINCIPALE
Individua l'azione richiesta, poi usa il tool che la completa direttamente. Non usare tool intermedi.
Non usare mai la tua memoria sul catalogo: non dire che una destinazione non c'è e non dire che hai trovato una proposta senza aver chiamato searchCatalog in questo turno. Se non sei sicuro, chiama searchCatalog.

## CREAZIONE CONTENUTI
Usa createContent quando l'utente chiede di creare un post, un reel, un contenuto, di preparare un post o un contenuto da pubblicare.
- contentId: non serve, il contenuto è nuovo.
- topic: argomento esatto chiesto (es. "proposta Calabria"). È un VINCOLO: copy, hashtag e immagine parlano solo di quello, senza altre destinazioni.
- platforms: array con le piattaforme richieste ["INSTAGRAM","FACEBOOK"], mai stringa.
- type: "POST" o "VIDEO". Carousel: createCarousel.
createContent produce il DRAFT completo. Con "fromCatalog": true nasce anche con il visuale (vedi CATALOGO); senza catalogo, cioè solo "topic", resta senza visual.
Chiamalo una sola volta per richiesta, poi chiudi il turno e rispondi all'utente.
NON usare generateCaption o generateHashtags come passaggi intermedi.

## CATALOGO
Il Catalogo Agenzia è la fonte di verità per i post: contiene solo proposte realmente pubblicate sul sito, con la loro provenienza.
- Post su una destinazione: SEMPRE prima searchCatalog con "query", anche se la destinazione ti sembra conosciuta, poi createContent con "fromCatalog": true e "destination" (o "catalogProposalId" dalla ricerca).
- La destinazione non è nel catalogo: NON creare il DRAFT, non inventare l'offerta e non usare conoscenze tue. Dillo all'utente e proponi un'altra destinazione o l'aggiornamento del Catalogo. Prima di dirlo devi aver chiamato searchCatalog in questo turno e aver visto zero risultati per quella destinazione.
- L'utente non ha indicato una destinazione: createContent con "fromCatalog": true sceglie da sola una proposta già presente.
- Il catalogo è vuoto: nessun DRAFT, spiega che il Catalogo va importato.
- Dati commerciali assenti in una proposta: la copy non cita prezzi, date, durata o servizi. Non scegliere il formato OFFER senza quei dati.
- Il DRAFT di catalogo nasce completo: il visuale usa l'immagine ufficiale della proposta quando è valida, altrimenti viene generato dal provider immagini configurato. Non chiamare generateImage per completarlo: è già fatto.
- Se il visuale non si può materializzare non viene creato alcun DRAFT e createContent risponde ok:false con il motivo. Non riprovare a crearlo e non offrire un post senza immagine: riferisci il problema all'utente.

## GENERAZIONE PARZIALE
- generateCaption solo su richiesta esplicita di caption o testo.
- generateHashtags solo su richiesta esplicita di hashtag.
Non usarli per creare un contenuto completo.

## IDEE
createIdea per idee, spunti o proposte da salvare. Non usarlo se l'utente chiede un post o un reel.

## CONTENUTI ESISTENTI
I contentId servono solo per contenuti già esistenti. Non inventarli: se manca, chiedilo o usa listContents.

## VISUAL
Con "fromCatalog": true il visuale è già pronto: non generarne un altro e non chiamare generateImage.
Senza catalogo createContent NON genera immagini: il DRAFT resta senza visual e si completa dalla Media Library. Genera un'immagine con generateImage solo se l'utente la chiede esplicitamente. Per i VIDEO usa generateVideo.
Il visual deve essere coerente con il topic, senza destinazioni o prodotti non richiesti.

## PIATTAFORME
Usa esattamente le piattaforme richieste. Non inventarne.

## COPY
La copy di un contenuto completo deve essere usabile da un'agenzia di viaggi.
- Parla concretamente della proposta o destinazione, con tono editoriale naturale.
- Niente formule generiche tipo "scopri questa meravigliosa destinazione".
- Non inventare prezzi, date, hotel, voli, durata, offerte o servizi non forniti.
- CTA naturale quando serve, coerente con Instagram e Facebook.
- Titolo e caption distinti: non ripetere il topic come titolo e come testo.
- hashtags: stringa con spazi, "#calabria #viaggi".

## SICUREZZA
- Workflow: DRAFT → APPROVED → SCHEDULED → PUBLISHED. Non saltarlo.
- Non approvare, programmare o pubblicare senza richiesta esplicita.
- deleteContent e publishContent: chiedi prima conferma, poi richiama con confirm=true. La richiesta iniziale non è già conferma.

## RISPOSTA
I tool rispondono {"ok": true|false, "message": "...", "data": {...}}: ok:false = operazione non eseguita.
Rispondi in italiano, in linguaggio naturale: mai JSON, envelope, parametri o dettagli tecnici.
Se un tool risponde "Parametri non validi", correggi il formato e richiamalo una volta sola.

TOOLS DISPONIBILI:
${toolsSystemDescription()}`;

/**
 * Schema di risposta usato per il decoding strutturato: deriva dagli stessi
 * tool del registry, quindi non può divergere da `SYSTEM_PROMPT` né accettare
 * un tool inesistente. `format: "json"` da solo lascia il modello libero di
 * scegliere nomi e forme diverse da quelle previste.
 */
export const AGENT_ENVELOPE_SCHEMA = buildAgentEnvelopeSchema(toolSchemaVariants());

const MAX_ROUNDS = 6;
const HISTORY_LIMIT = 24;
/** Prefisso diagnostico (troncato) dell'output non conforme, solo se AI_DEBUG=1. */
const INVALID_PREVIEW = 200;
/**
 * Limite di caratteri per un singolo tool result passato al modello.
 *
 * Il context overflow non nasce solo dal prompt iniziale: a ogni round il
 * prompt cresce di un envelope + un risultato per tool chiamato, e un
 * `searchCatalog` può portare 8 proposte. 6.000 caratteri per risultato
 * bastavano a far esplodere il contesto già dal secondo round.
 */
export const TOOL_RESULT_MAX = 1200;

/**
 * Limite cumulativo dei tool result accumulati nello stesso round.
 *
 * Deterministico: ogni chiamata riceve il minore fra `TOOL_RESULT_MAX` e il
 * budget residuo del round, e i dati già spesi non si recuperano. Il tetto
 * può quindi essere superato dalle sole teste (`ok`/`errore` + `message`),
 * che per costruzione non vengono mai compresse.
 */
export const TOOL_ROUND_BUDGET = 2400;
/** Budget massimo per i messaggi di cronologia passati al modello */
const HISTORY_BUDGET = 14000;

/**
 * Istruzione usata per l'unico retry consentito quando il modello risponde con
 * un output non utilizzabile: prosa non JSON, JSON troncato, oppure JSON valido
 * senza `message` e senza tool call (es. `{}`). Non crea loop: viene inviata al
 * massimo una volta per esecuzione e con lo stesso schema dell'agent.
 */
const ENVELOPE_RETRY_INSTRUCTION = `La tua risposta precedente non era utilizzabile: non conteneva un envelope valido (un solo oggetto JSON con "message" e "tool_calls"), quindi non ho eseguito nulla.
Rispondi di nuovo con UN SOLO oggetto JSON valido, senza testo attorno, con questo schema esatto:
{"message": "testo in italiano per l'utente", "tool_calls": [{"name": "nome_del_tool", "arguments": {}}]}
- "message": testo in italiano, sempre presente anche se esegui un tool.
- "tool_calls": array con i tool da usare, presi SOLO dalla lista TOOLS DISPONIBILI. Se devi creare un contenuto devi per forza usare "createContent".
- Se non devi eseguire operazioni, usa "tool_calls": [].`;

/** Messaggio mostrato quando il retry non produce un envelope utilizzabile. */
function unusableReplyMessage(executed: number): string {
  return executed > 0
    ? "La risposta del modello non era interpretabile e ho interrotto le operazioni: controlla lo stato aggiornato dei contenuti e riprova."
    : "Non sono riuscito a interpretare la richiesta e non ho eseguito nessuna operazione. Riprova a riformularla.";
}

/**
 * Una richiesta utente = un solo contenuto.
 *
 * Il modello, dopo un `createContent` riuscito, può tornare a chiedere la
 * stessa creazione (il caso reale del 26/09: sei DRAFT consecutivi per un solo
 * prompt). La garanzia è applicativa, non affidata al prompt: dopo la prima
 * creazione riuscita, `createContent` non viene più eseguito e i tool di solo
 * testo vengono ignorati, perché la copy è già stata prodotta.
 */
const SINGLE_SHOT_TOOL = "createContent";
const TEXT_TOOLS_BLOCKED_AFTER_CREATE = new Set(["generateCaption", "generateHashtags"]);

/** Chiusura del turno: il contenuto creato è l'unico risultato della richiesta. */
function createdContentFinalText(created: { id: string; message: string }): string {
  const suffix = created.id
    ? " Ho chiuso il turno qui: per un altro post devi chiedermelo esplicitamente."
    : "";
  return `${created.message}${suffix}`;
}

/**
 * Logging diagnostico del percorso Chat → modello → tool.
 * Disattivato di default: si attiva con AI_DEBUG=1 nell'ambiente del server.
 * Logga solo dati già presenti in chat (richiesta utente, risposta del modello,
 * tool chiamati). Nessun token, nessuna API key, nessun header.
 */
const AI_DEBUG = process.env.AI_DEBUG === "1";
const RAW_PREVIEW = 2000;

function debugLog(step: string, detail: string): void {
  if (!AI_DEBUG) return;
  console.log(`[ai:debug] ${step} ${detail}`);
}

/** Prefisso con cui i dati strutturati seguono esito e messaggio. */
const TOOL_DATA_PREFIX = " data=";

/**
 * Testo compatto di un esito tool, entro `max` caratteri.
 *
 * Ordine delle regole, deterministico:
 * 1. `ok`/`errore` e `message` non si comprimono mai. Sono l'unica cosa che il
 *    modello usa per decidere, quindi il tetto può ridurre solo i dati: se il
 *    messaggio da solo supera `max`, resta intero e il testo supera il limite.
 * 2. Il codice di un esito bloccato resta leggibile subito dopo l'esito.
 * 3. I dati si troncano dall'inizio, dove stanno gli identificativi (id, nome,
 *    stato, formato): nei tool reali le chiavi che servono a decidere vengono
 *    prima e caption e metadati dopo.
 * 4. Sotto soglia il testo è identico a quello non compresso.
 */
export function compactToolResult(
  result: { ok: boolean; message: string; code?: string; data?: unknown },
  max = TOOL_RESULT_MAX
): string {
  const status = result.ok ? "ok" : "errore";
  const head = result.code
    ? `${status}[${result.code}]: ${result.message}`
    : `${status}: ${result.message}`;
  if (result.data === undefined) return head;

  const dataText =
    typeof result.data === "string"
      ? result.data
      : (() => {
          try {
            return JSON.stringify(result.data);
          } catch {
            return "";
          }
        })();
  if (!dataText) return head;

  const room = Math.max(max, head.length) - head.length - TOOL_DATA_PREFIX.length;
  if (room <= 0) return head;
  if (dataText.length <= room) return `${head}${TOOL_DATA_PREFIX}${dataText}`;
  // il "…" sta dentro il tetto: room caratteri di dati, non room + 1
  return `${head}${TOOL_DATA_PREFIX}${dataText.slice(0, room - 1)}…`;
}

/** Messaggio d'errore mostrato all'utente: non espone dettagli interni non necessari. */
function friendlyError(e: unknown): string {
  if (e instanceof AiUnavailableError) return e.message;
  return "Si è verificato un errore durante l'operazione. Riprova tra poco.";
}

export async function runAgent(opts: {
  conversationId: string;
  userMessage: string;
  emit?: (e: AgentStreamEvent) => void;
}) {
  const { conversationId, userMessage, emit } = opts;
  let conversation;
  try {
    conversation = await getConversation(conversationId);
  } catch (e) {
    logAIError("agent.getConversation", { conversationId }, e);
    throw new Error("Conversazione non trovata.");
  }
  if (!conversation) throw new Error("Conversazione non trovata.");

  try {
    await addMessages(conversationId, [{ role: "USER", content: userMessage }]);
  } catch (e) {
    logAIError("agent.persistUser", { conversationId }, e);
    throw new Error("Impossibile salvare il messaggio. Riprova.");
  }

  const history = await getMessageHistory(conversationId, HISTORY_LIMIT);
  const messages: AiChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...toAiMessages(history, HISTORY_BUDGET),
  ];

  const provider = getAiProvider();
  const executed: { name: string; args: unknown; label: string; ok: boolean }[] = [];
  /**
   * Un solo retry per esecuzione quando l'output non è un envelope valido:
   * nessun loop di insistenza sul modello. Il retry avviene solo con zero tool
   * call già eseguite, quindi non può duplicare tool, DRAFT o asset, e non
   * viene persistito in chat.
   */
  let envelopeRetried = false;
  /** Contenuto già creato in questo run: rende bloccabili i duplicati. */
  let createdContent: { id: string; message: string } | null = null;

  const persistAssistant = async (content: string, calls?: ToolCall[]) => {
    try {
      await addMessages(conversationId, [
        {
          role: "ASSISTANT",
          content,
          toolName: null,
          toolArgs: calls ? { calls: calls.map((c) => c.name) } : null,
        },
      ]);
    } catch (e) {
      logAIError("agent.persistAssistant", { conversationId }, e);
    }
  };

  debugLog(
    "request",
    `conv=${conversationId} history=${history.length}msgs system=${SYSTEM_PROMPT.length}car ` +
      `tools=[${AI_TOOLS.map((t) => t.name).join(",")}] user=${JSON.stringify(userMessage)}`
  );

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      emit?.({ type: "round", n: round + 1 });

      let raw: string;
      try {
        const completion = await provider.chat(messages, {
          jsonSchema: AGENT_ENVELOPE_SCHEMA,
          temperature: 0.3,
        });
        raw = completion.text;
        debugLog(
          "tokens",
          `round=${round + 1} prompt=${completion.promptEvalCount ?? "?"} ` +
            `generated=${completion.evalCount ?? "?"}`
        );
        debugLog(
          "raw",
          `round=${round + 1} model=${provider.model} len=${raw.length} ${JSON.stringify(raw.slice(0, RAW_PREVIEW))}`
        );
      } catch (e) {
        if (e instanceof AiUnavailableError) {
          const msg = `${e.message} Puoi comunque usare il pannello, l'archivio contenuti, il calendario, la media library e le approvazioni normalmente.`;
          await persistAssistant(msg);
          emit?.({ type: "error", text: msg });
          return { ok: false, error: msg };
        }
        logAIError("agent.chat", { conversationId, round }, e);
        await persistAssistant(
          "Mi dispiace, la richiesta all'AI non è andata a buon fine. Riprova tra poco."
        );
        emit?.({ type: "error", text: "Richiesta AI non completata. Riprova." });
        return { ok: false, error: friendlyError(e) };
      }

      if (!raw.trim()) {
        const msg =
          "Mi dispiace, non ho ricevuto risposta dal modello. Controlla che Ollama sia attivo e riprova.";
        await persistAssistant(msg);
        emit?.({ type: "error", text: msg });
        return { ok: false, error: "no response" };
      }

      const parsed = parseAgentReply(raw);
      const calls = parsed.toolCalls;
      debugLog(
        "parsed",
        `round=${round + 1} calls=[${calls.map((c) => c.name).join(",")}] ` +
          `message=${JSON.stringify(parsed.message ?? null)} issue=${parsed.issue ?? "none"}`
      );

      if (parsed.issue) {
        // Output non conforme: mai una risposta per l'utente. Si registra il
        // motivo (non_json / schema_invalid), la lunghezza e un prefisso
        // diagnostico troncato, senza loggare l'output completo.
        debugLog(
          "invalid",
          `round=${round + 1} reason=${parsed.issue} len=${raw.length} ` +
            `preview=${JSON.stringify(raw.slice(0, INVALID_PREVIEW))}`
        );
      }

      if (calls.length === 0) {
        // Envelope non utilizzabile (prosa, JSON troncato, `{}`): mai mostrare
        // l'output grezzo. Si concede un solo retry chiedendo esplicitamente
        // l'envelope corretto, con le stesse regole e lo stesso schema.
        if (parsed.issue && !envelopeRetried && round < MAX_ROUNDS - 1) {
          envelopeRetried = true;
          messages.push({ role: "assistant", content: raw });
          messages.push({ role: "user", content: ENVELOPE_RETRY_INSTRUCTION });
          continue;
        }
        // Nessuna `message` valida: errore strutturato, non testo del modello.
        const finalText = parsed.message ?? unusableReplyMessage(executed.length);
        await persistAssistant(finalText, undefined);
        emit?.({ type: "final", text: finalText });
        return { ok: true, finalText, executed };
      }

      // Round con tool: in cronologia salviamo solo testo leggibile.
      // L'envelope grezzo ("content": "{...}") è un dettaglio interno del
      // protocollo: persisted in chat verrebbe riletto come messaggio
      // dell'utente nei turni successivi e riporterebbe il modello al
      // formato legacy. L'esito dei tool resta registrato dai messaggi TOOL.
      if (parsed.message) await persistAssistant(parsed.message, calls);
      messages.push({
        role: "assistant",
        name: undefined,
        content: raw,
      });

      // Budget cumulativo dei tool result di QUESTO round: ogni chiamata prende
      // il minore fra il limite singolo e il residuo, così più tool nello stesso
      // envelope non fanno crescere il prompt oltre TOOL_ROUND_BUDGET.
      let roundToolChars = 0;

      for (const call of calls) {
        const tool = getTool(call.name);
        const label = tool?.brief ?? call.name;

        if (!tool) {
          const msg = `Tool "${call.name}" sconosciuto.`;
          const content = JSON.stringify({ ok: false, message: msg });
          messages.push({ role: "tool", name: call.name, content });
          await addMessages(conversationId, [
            { role: "TOOL", content: msg, toolName: call.name, toolArgs: call.arguments, toolSummary: msg },
          ]);
          executed.push({ name: call.name, args: call.arguments, label, ok: false });
          emit?.({ type: "tool", name: call.name, label, args: call.arguments, ok: false, error: msg });
          continue;
        }

        const validation = tool.schema.safeParse(call.arguments);
        let result: { ok: boolean; message: string; data?: unknown; code?: string };
        try {
          // 1 richiesta = 1 contenuto: dopo la creazione riuscita i duplicati
          // non vengono eseguiti, ma vengono eseguiti e rendicati come bloccati.
          const duplicateCreate =
            call.name === SINGLE_SHOT_TOOL && createdContent !== null;
          const redundantText =
            createdContent !== null && TEXT_TOOLS_BLOCKED_AFTER_CREATE.has(call.name);

          if (duplicateCreate) {
            result = {
              ok: false,
              code: "content_already_created",
              message:
                `Contenuto già creato in questo turno (id ${createdContent?.id}): ` +
                "non ne creo un secondo. Se serve un altro post, chiedilo come nuova richiesta.",
            };
          } else if (redundantText) {
            result = {
              ok: false,
              code: "text_already_covered",
              message:
                `La copy del contenuto ${createdContent?.id} è già stata creata insieme al contenuto: non la rigenero.`,
            };
          } else if (!validation.success) {
            result = {
              ok: false,
              message: `Parametri non validi per ${call.name}: ${validation.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`,
            };
          } else {
            result = await tool.execute(call.arguments);
            if (result.ok && call.name === SINGLE_SHOT_TOOL) {
              const data = (result.data ?? {}) as { id?: unknown };
              createdContent = {
                id: typeof data.id === "string" ? data.id : "",
                message: result.message,
              };
            }
          }
        } catch (e) {
          logAIError("tool.execute", { conversationId, tool: call.name }, e);
          result = {
            ok: false,
            message: "Il tool ha restituito un errore imprevisto. Riprova.",
          };
        }

        const limit = Math.max(
          0,
          Math.min(TOOL_RESULT_MAX, TOOL_ROUND_BUDGET - roundToolChars)
        );
        const content = compactToolResult(result, limit);
        roundToolChars += content.length;
        messages.push({ role: "tool", name: call.name, content });
        try {
          await addMessages(conversationId, [
            {
              role: "TOOL",
              content: JSON.stringify({ ...result, _label: label }),
              toolName: call.name,
              toolArgs: call.arguments,
              toolSummary: result.message,
            },
          ]);
        } catch (e) {
          logAIError("agent.persistTool", { conversationId, tool: call.name }, e);
        }
        executed.push({ name: call.name, args: call.arguments, label, ok: result.ok });
        debugLog(
          "executed",
          `tool=${call.name} known=${Boolean(tool)} ok=${result.ok} ` +
            `args=${JSON.stringify(call.arguments).slice(0, RAW_PREVIEW)} ` +
            `result=${JSON.stringify(result.message).slice(0, 400)}`
        );
        emit?.({
          type: "tool",
          name: call.name,
          label,
          args: call.arguments,
          ok: result.ok,
          error: result.ok ? undefined : result.message,
        });
      }

      // La richiesta è soddisfatta: dopo un createContent riuscito il turno
      // finisce qui, senza lasciare che il modello ripeta la creazione.
      if (createdContent) {
        const finalText = createdContentFinalText(createdContent);
        await persistAssistant(finalText, undefined);
        emit?.({ type: "final", text: finalText });
        return { ok: true, finalText, executed };
      }
    }

    const fallbackMsg =
      "Ho eseguito molte operazioni in sequenza: controlla lo stato aggiornato dei contenuti, il calendario e le approvazioni per vedere il risultato, oppure chiedimi di continuare.";
    await persistAssistant(fallbackMsg);
    emit?.({ type: "final", text: fallbackMsg });
    return { ok: true, finalText: fallbackMsg, executed };
  } catch (e) {
    const internal = e instanceof Error ? e.message : String(e);
    await logAudit("AI_AGENT_ERROR", "ChatConversation", conversationId, { error: internal });
    logAIError("agent.run", { conversationId }, e);
    const msg = friendlyError(e);
    await persistAssistant(`⚠️ ${msg}`);
    emit?.({ type: "error", text: msg });
    return { ok: false, error: msg };
  }
}
