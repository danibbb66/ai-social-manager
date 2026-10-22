import { AiChatMessage, AiUnavailableError } from "@/lib/ai/provider";
import { getAiProvider } from "@/lib/ai/factory";
import { buildAgentEnvelopeSchema } from "@/lib/ai/ollama";
import { getTool, toolsSystemDescription, AI_TOOLS, toolSchemaVariants } from "@/lib/ai/tools/registry";
import { tryParseJson } from "@/lib/ai/generate";
import { getConversation, getMessageHistory, toAiMessages, addMessages } from "@/lib/services/chat";
import { logAudit } from "@/lib/audit";
import { logAIError } from "@/lib/logger";
import { friendlyMessage, friendlyServiceMessage } from "@/lib/errors/user-message";

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

## COSA PUOI CREARE
Questa chat crea SOLO post (immagini) e video (reel) con foto reali del luogo. Non esiste alcun Catalogo qui: non parlarne, non cercarlo e non rifiutare mai la creazione per la sua assenza.
- POST: un'immagine verticale con la foto del luogo, il titolo (nome della destinazione) e il logo. Se l'utente fornisce un testo, questo va al centro con un banner (vedi "TESTO GANCIO").
- VIDEO: un reel verticale montato con clip reali del luogo.
Un VIDEO è sempre un reel.

## TESTO "GANCIO" SUL POST (callout)
Quando l'utente fornisce un testo da stampare DIRETTAMENTE sul post (es. "crea un post per Tokyo con testo: hotel 4★, mezza pensione, dal 22/11/2026 al 27/11/2026, da € 2899", "aggiungi la scritta...", "con testo: ..."), passalo come campo "callout" a createContent con type "POST". È testo FORNITO DALL'UTENTE, quindi può citare prezzi, date e servizi (li ha dettati lui): Il testo dell'utente va al centro della foto con un banner dietro. Il callout si stampa ESATTAMENTE come lo ha scritto l'utente, senza inventarlo né riscriverlo.

## CREAZIONE CONTENUTI
Usa createContent quando l'utente chiede di creare un post, un reel, un contenuto, di preparare un post o un contenuto da pubblicare.
- contentId: non serve, il contenuto è nuovo.
- topic: argomento esatto chiesto (es. "proposta Calabria"). È un VINCOLO: copy, hashtag e immagine parlano solo di quello, senza altre destinazioni.
- platforms: array con le piattaforme richieste ["INSTAGRAM","FACEBOOK"], mai stringa.
- type: "POST" o "VIDEO". Carousel: createCarousel.
- format: struttura editoriale del post, tra TRAVEL_TIPS, ITINERARY, HERO_DESTINATION, FAQ.
  Scegli il formato in base a che cosa serve al lettore, e rispettane la struttura:
  - HERO_DESTINATION: il luogo in primo piano.
  - TRAVEL_TIPS: 3 consigli pratici sul posto, uno per riga.
  - ITINERARY: il percorso, una tappa o un giorno per riga.
  - FAQ: una domanda vera sul luogo e la sua risposta chiara.
createContent produce il DRAFT completo CON il suo visual già collegato (vedi VISUAL).
- Qualsiasi destinazione o argomento è ammesso (es. "3 post sulla Grecia"): crea SEMPRE i contenuti richiesti e le relative bozze in DRAFT.
- Nessun controllo blocca la creazione: non rifiutare e non rimandare la richiesta solo perché una destinazione non è presente da qualche parte.
PIÙ POST NELLO STESSO TURNO: se l'utente chiede N post devi crearli TUTTI nello stesso turno, con una chiamata a createContent per ciascuno: non fermarti al primo e non aspettare un'altra richiesta.
Riconosci N anche quando non c'è un numero: conta ogni "post"/"reel"/"contenuto" che l'utente nomina. "un post su Ibiza e un post su Mallorca" sono DUE post, "3 post sulla Grecia" sono tre, "1 Grecia + 1 Maldive" sono due.
Puoi anche chiamare createContent più volte nello stesso envelope: se la richiesta contiene più destinazioni, metti una chiamata per ciascuna.
Per ogni post cambia il "format" e l'angolazione del tema (racconto, consigli di viaggio, itinerario, ispirazione, ...), usando il topic della destinazione di quel post: due post sulla stessa destinazione devono avere topic o formato diversi. Chiudi il turno solo quando tutti gli N sono stati creati.
Per un solo post basta una chiamata a createContent.
NON usare generateCaption o generateHashtags come passaggi intermedi.

## GENERAZIONE PARZIALE
- generateCaption solo su richiesta esplicita di caption o testo.
- generateHashtags solo su richiesta esplicita di hashtag.
Non usarli per creare un contenuto completo.

## IDEE
createIdea per idee, spunti o proposte da salvare. Non usarlo se l'utente chiede un post o un reel.

## CONTENUTI ESISTENTI
I contentId servono solo per contenuti già esistenti. Non inventarli: se manca, chiedilo o usa listContents.

## VISUAL
Il visual di ogni post va SEMPRE recuperato cercandolo nella libreria stock (foto di Pixabay) in base alla destinazione: createContent fa da solo la ricerca, applica il layout/template e collega il file, quindi nessun post resta senza visual. createContent NON genera immagini AI: generateImage solo se l'utente la chiede esplicitamente.
Per i VIDEO: createContent con type "VIDEO" esegue l'intera pipeline IN AUTOMATICO, in un'unica chiamata: crea la bozza, recupera i fotogrammi del luogo dalla libreria stock, lancia subito ffmpeg per renderizzare il reel, e collega l'asset VIDEO alla bozza. Il video è pronto nel DRAFT: NON dire mai all'utente di caricare il file a mano se il tool non ha restituito un errore. Se il tool risponde ok:false con l'errore reale di generazione, riporta QUELLO all'utente: puoi riprovare UNA sola volta se l'errore sembra transitorio (timeout, rete), altrimenti proponi attachVideo (video già in libreria) o il caricamento manuale come ultima opzione. NON ritentare all'infinito e NON inventare strumenti (es. createVideo, uploadVideo). generateVideo serve per rigenerare il video di un contenuto esistente, su richiesta esplicita.
Il visual deve essere coerente con il topic, senza destinazioni o prodotti non richiesti.

## PIATTAFORME
Usa esattamente le piattaforme richieste. Non inventarne.

## COPY
La copy di un contenuto completo deve essere usabile da un'agenzia di viaggi.
- Il titolo contiene SEMPRE il nome della destinazione richiesta (es. "Formentera",
  "Mallorca") o un gancio che la contiene (es. "I segreti di Formentera").
- VIETATO un titolo generico: niente "vacanza in spiaggia", "proposta di viaggio",
  "la nostra proposta", "da vivere con calma". Un titolo che non nomina il posto non
  identifica niente.
- Il titolo segue il formato che hai scelto: per TRAVEL_TIPS "Destinazione — Consigli
  di viaggio", per ITINERARY "Destinazione in X giorni", per FAQ la domanda vera.
- La caption ha la struttura del formato: 3 punti per TRAVEL_TIPS, una tappa o un
  giorno per riga per ITINERARY, domanda e risposta per FAQ.
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

## COSA SCRIVERE ALL'UTENTE
Il campo "message" di un tool è già scritto per essere mostrato all'utente: è la sua risposta. Rilovvalo.
Non aggiungere e non ripetere: id del contenuto, nomi dei provider o degli strumenti usati, nomi dei layout,
query di ricerca delle immagini, avvisi tecnici, né lo stato interno delle operazioni.
Non scrivere MAI: indirizzi web o di rete, porte, chiavi API, codici di errore, nomi di tabelle o di servizi,
percorsi di file. Un errore tecnico si riassume in una frase di cortesia ("non sono riuscito a creare il
contenuto, riprova"), senza copiare il messaggio interno dell'errore.
Un utente che chiede "crea un post" vuole sapere se è stato creato e dove trovarlo, non come è stato prodotto.
I dettagli sono in "data": leggili se ti servono per decidere o se l'utente chiede, ma non mostrarli per procura.
Gli unici due casi in cui aggiungi qualcosa: se un tool ha fallito, spiega il motivo in una frase; se hai creato
più contenuti, dillo una volta sola ("Ho creato 3 bozze").

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
 * Una richiesta = un numero noto di contenuti.
 *
 * Il modello, dopo un `createContent` riuscito, può tornare a chiedere la
 * stessa creazione (il caso reale del 26/09: sei DRAFT consecutivi per un solo
 * prompt). Il limite non è più "uno per turno" ma "quanti post ha chiesto
 * l'utente": finché mancano contenuti il turno prosegue, e raggiunto il
 * numero gli ulteriori `createContent` vengono bloccati.
 */
const CREATE_TOOL = "createContent";
const TEXT_TOOLS_BLOCKED_AFTER_CREATE = new Set(["generateCaption", "generateHashtags"]);

/**
 * Formati editoriali ruotati quando un turno produce più post.
 *
 * Tutti e cinque, nell'ordine con cui un post si legge dal più discorsivo al più
 * commerciale: la rotazione parte dal consiglio e finisce sull'offerta, così due
 * post della stessa richiesta non sono due stessi pezzi con un nome diverso.
 *
 * OFFER e FAQ chiedono dati commerciali per essere onesti: dove i dati non ci
 * sono la copy non inventa e lo dichiara, quindi sono ammessi anche loro.
 * Escluderli lascerebbe due dei cinque formati senza struttura distinta.
 */
const FORMAT_ROTATION = [
  "TRAVEL_TIPS",
  "ITINERARY",
  "HERO_DESTINATION",
  "FAQ",
  "OFFER",
] as const;

/** Tetto dei post richiesti in un turno: non deve superare i round disponibili. */
const MAX_REQUESTED_POSTS = 10;

/** Quantità scritte in parole, come le scrive un utente in chat italiana. */
const COUNT_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
};

/** Quantità seguita dall'unità ("3 post", "due reel", "un contenuto"). */
const COUNT_PATTERN =
  /(?:^|[^\p{L}\p{N}])(\d+|un[oa]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci)\s+(?:post|reel|contenut\w*|bozz\w*|stor(?:y|ie)|carosell\w*)/gu;

/**
 * Quanti contenuti chiede l'utente in questo turno.
 *
 * Tre segnali, in quest'ordine di precedenza.
 *
 * 1. **Quantità esplicita maggiore di uno**: "3 post", "due reel", "5 contenuti".
 *    Vince su tutto il resto, perché è l'unico segnale in cui l'utente ha detto
 *    un numero. "3 post su Grecia + Maldive" resta 3.
 * 2. **Unità ripetute**: "un post su ibiza e un post su mallorca". Ogni
 *    ripetizione dell'unità è un post chiesto, quindi si contano le occorrenze.
 *    È il caso che rendeva il flusso multi-post inutilizzabile: il totale
 *    veniva calcolato come massimo delle quantità, due richieste da 1 producevano
 *    1 e il secondo post veniva respinto come duplicato.
 * 3. **Destinazioni separate da "+"**: "1 Grecia + 1 Maldive".
 *
 * Nessun segnale → un solo contenuto. Il risultato è sempre limitato a
 * `MAX_REQUESTED_POSTS`: oltre, il tetto di round del modello non basterebbe e
 * un numero più grande non produrrebbe post, solo richieste non eseguite.
 */
export function parseRequestedContentCount(userMessage: string): number {
  const text = userMessage.toLowerCase();
  const values: number[] = [];

  for (const match of text.matchAll(COUNT_PATTERN)) {
    const raw = match[1];
    values.push(/^\d+$/.test(raw) ? Number(raw) : (COUNT_WORDS[raw] ?? 1));
  }

  // Una quantità maggiore di uno è l'intento esplicito e non si somma con le
  // ripetizioni: "3 post" significa tre post, non tre più una ripetizione della
  // parola "post" nella stessa frase.
  const explicit = values.filter((v) => v > 1);
  if (explicit.length > 0) {
    return Math.min(Math.max(...explicit), MAX_REQUESTED_POSTS);
  }

  // Nessuna quantità: contare le unità, con o senza quantificatore ("un post su
  // ibiza e un post su mallorca", "post su ibiza e post su mallorca").
  let count = Math.max(values.length, 0);
  if (count === 0) {
    const units = text.match(/\b(?:post|reel|contenut\w*|bozz\w*|carosell\w*)\b/g);
    count = units ? units.length : 0;
  }

  const segments = text
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length > count) count = segments.length;

  return Math.min(Math.max(count, 1), MAX_REQUESTED_POSTS);
}

type CreatedContent = { id: string; message: string; format: string | null };

/**
 * Chiusura del turno: riepilogo di TUTTI i contenuti creati.
 *
 * Con più post l'utente deve poter vedere quanti sono e con quale struttura
 * ciascuno: un riepilogo che nomina solo il primo nasconderebbe gli altri.
 */
/**
 * Chiusura del turno: una frase, senza log.
 *
 * Un solo contenuto riusa il messaggio del tool, che è già scritto per l'utente:
 * è una frase sola, e una seconda frase aggiungerebbe un'istruzione che l'utente
 * non ha chiesto e che non serve a nulla.
 * Con più contenuti non si elencano: gli id sono identificatori di database e
 * l'utente cerca i post per destinazione e per data, non per codice. La frase
 * dice solo quanti ne sono stati creati e dove trovarli.
 *
 * Il numero di contenuti richiesti non compare: se ne sono stati creati meno,
 * dirlo qui sarebbe un dettaglio di esecuzione che l'utente non può agire su, e
 * il modello ha già la verità nei dati del tool.
 */
function createdContentsFinalText(created: CreatedContent[]): string {
  if (created.length === 1) return created[0].message;
  return `Post creati con successo in stato DRAFT: sono ${created.length}. Li trovi nella sezione Contenuti.`;
}

/**
 * Formato del prossimo post di un turno multi-post.
 *
 * Garanzia applicativa, non un suggerimento al modello: se il modello non
 * passa il formato, o ripete quello già usato, viene assegnato il primo non
 * ancora impiegato. Gli N post escono quindi con strutture diverse per
 * costruzione, qualunque ordine scelga il modello.
 */
function nextFormatArgument(
  args: Record<string, unknown>,
  usedFormats: Set<string>,
  createdCount: number
): string {
  const current = typeof args.format === "string" ? args.format.trim() : "";
  if (current && !usedFormats.has(current)) return current;
  const free = FORMAT_ROTATION.find((format) => !usedFormats.has(format));
  return free ?? FORMAT_ROTATION[createdCount % FORMAT_ROTATION.length];
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

/**
 * Messaggio d'errore mostrato all'utente: non espone dettagli interni non necessari.
 *
 * Non è una traduzione dell'errore: è una decisione. Il testo originale vive
 * nel log server-side, dove chi diagnostica lo legge per intero; in chat
 * finisce solo ciò che l'utente può usare. Il caso che lo rende obbligatorio è
 * proprio `AiUnavailableError`, che porta con sé l'indirizzo e la porta del
 * provider: rimandare quel messaggio all'utente pubblicava l'infrastruttura
 * della macchina.
 */
function friendlyError(e: unknown): string {
  return friendlyMessage(e, "Si è verificato un errore durante l'operazione. Riprova tra poco.");
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
  /**
   * Quanti contenuti ha chiesto l'utente in questo turno. È la misura con cui
   * si decide se il turno continua o si chiude: non il primo contenuto creato,
   * ma tutti quelli richiesti ("3 post", "1 Grecia + 1 Maldive", ...).
   */
  const requestedCount = parseRequestedContentCount(userMessage);
  /** Round disponibili: abbastanza per i post richiesti, con un margine. */
  const maxRounds = Math.max(MAX_ROUNDS, Math.min(MAX_ROUNDS + 6, requestedCount + 3));
  /** Contenuti creati in questo run, nell'ordine in cui sono stati creati. */
  const created: CreatedContent[] = [];
  /** Formati già impiegati: servono a imporre strutture diverse fra i post. */
  const usedFormats = new Set<string>();
  /** Quanti createContent sono ancora attesi in questo turno. */
  const pendingCreates = () => Math.max(0, requestedCount - created.length);

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
      `requested=${requestedCount} ` +
      `tools=[${AI_TOOLS.map((t) => t.name).join(",")}] user=${JSON.stringify(userMessage)}`
  );

  try {
    for (let round = 0; round < maxRounds; round++) {
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
          // Il messaggio dell'errore contiene l'indirizzo e la porta del
          // provider: qui si mette la frase di cortesia, non quello. Chi
          // amministra la macchina legge il dettaglio nel log.
          logAIError("agent.chat", { conversationId, round, reason: "unavailable" }, e);
          const msg =
            `${friendlyServiceMessage()} Puoi comunque usare il pannello, l'archivio ` +
            "contenuti, il calendario, la media library e le approvazioni normalmente.";
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
        // Nessun nome di provider e nessun indirizzo: la frase dice che il
        // servizio non ha risposto, non come si chiama né dove sta.
        const msg =
          "Mi dispiace, non ho ricevuto risposta. Riprova tra poco: se continua, " +
          "verifica che il servizio di generazione sia attivo.";
        await persistAssistant(msg);
        emit?.({ type: "error", text: msg });
        return { ok: false, error: msg };
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
        if (parsed.issue && !envelopeRetried && round < maxRounds - 1) {
          envelopeRetried = true;
          messages.push({ role: "assistant", content: raw });
          messages.push({ role: "user", content: ENVELOPE_RETRY_INSTRUCTION });
          continue;
        }
        // La richiesta è ancora aperta: il modello ha chiuso il turno con un
        // testo mentre mancano contenuti. Non si passa la parola all'utente
        // con un post su N: si rientra nel giro con l'istruzione mancante.
        const stillPending = pendingCreates();
        if (!parsed.issue && created.length > 0 && stillPending > 0 && round < maxRounds - 1) {
          messages.push({ role: "assistant", content: raw });
          messages.push({
            role: "user",
            content:
              `Non hai ancora finito: mancano ${stillPending} contenuti della richiesta ` +
              `(${created.length} su ${requestedCount} già creati). Usa createContent per crearli ` +
              "tutti nello stesso turno, con un formato editoriale diverso per ciascuno.",
          });
          continue;
        }
        // Nessuna `message` valida: errore strutturato, non testo del modello.
        // Se il turno aveva già creato dei post, il riepilogo è quello
        // dell'agente e non il messaggio del modello: il modello non sa
        // quante bozze sono a terra e potrebbe dirlo in modo sbagliato.
        const finalText =
          created.length > 0
            ? createdContentsFinalText(created)
            : (parsed.message ?? unusableReplyMessage(executed.length));
        await persistAssistant(finalText, undefined);
        emit?.({ type: "final", text: finalText });
        return { ok: true, finalText, executed };
      }

      // Round con tool: in cronologia salviamo solo testo leggibile.
      // L'envelope grezzo ("content": "{...}") è un dettaglio interno del
      // protocollo: persisted in chat verrebbe riletto come messaggio
      // dell'utente nei turni successivi e riporterebbe il modello al
      // formato legacy. L'esito dei tool resta registrato dai messaggi TOOL.
      //
      // La frase del modello che accompagna una tool call NON viene persistita.
      // È il narratore di un passaggio intermedio — "Cerco la proposta", "Ora
      // creo il contenuto" — e finendo in chat compariva come una risposta
      // seguita, più in basso, dalla conferma vera. Due messaggi per un'azione
      // sola, il primo dei quali non aggiunge niente. Il modello continua a
      // riceverlo nei round successivi: la persistenza serve all'utente, non al
      // contesto del modello, che riceve già l'esito dei tool.
      //
      // Non viene persistito nemmeno l'errore di un tool fallito: la chat è
      // muta finché non arriva `final`, che spiega cosa è successo in una frase.
      // Un tool bloccato o non eseguito è un dettaglio della stessa operazione,
      // non un messaggio a sé.
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

        // Più post nello stesso turno = strutture diverse. È una garanzia
        // applicativa: se il modello non dichiara il formato, o ripete quello
        // già usato, l'agente assegna il primo non ancora impiegato.
        if (call.name === CREATE_TOOL && requestedCount > 1) {
          call.arguments.format = nextFormatArgument(call.arguments, usedFormats, created.length);
        }

        const validation = tool.schema.safeParse(call.arguments);
        let result: { ok: boolean; message: string; data?: unknown; code?: string };
        try {
          // Il tetto è il numero di post chiesti, non "uno per turno": raggiunto
          // il tetto gli ulteriori createContent non vengono eseguiti, ma
          // restano eseguiti e rendicati come bloccati.
          const duplicateCreate =
            call.name === CREATE_TOOL && created.length >= requestedCount;
          const redundantText =
            created.length > 0 && TEXT_TOOLS_BLOCKED_AFTER_CREATE.has(call.name);

          if (duplicateCreate) {
            // Il blocco esiste per fermare i post duplicati quando il modello
            // ne chiede più di quelli richiesti: è un tetto, non un divieto. Il
            // messaggio non contiene id, perché finisce in chat.
            result = {
              ok: false,
              code: "content_already_created",
              message:
                created.length <= 1
                  ? "Questo post è già stato creato in questo turno. " +
                    "Se ne serve un altro su una destinazione diversa, chiedilo."
                  : `I ${created.length} post richiesti sono già stati creati in questo turno. ` +
                    "Se ne serve un altro su una destinazione diversa, chiedilo.",
            };
          } else if (redundantText) {
            result = {
              ok: false,
              code: "text_already_covered",
              message:
                "La copy del post è già stata scritta insieme al contenuto: non la rigenero.",
            };
          } else if (!validation.success) {
            // Il messaggio che finisce in chat non contiene nomi di tool né
            // percorsi di validazione: sono dettagli di esecuzione, e l'utente
            // ha chiesto un contenuto, non una diagnosi dello schema. Il
            // dettaglio tecnico resta in `data`, dove il modello lo legge se
            // deve correggere la chiamata.
            result = {
              ok: false,
              message:
                "Non sono riuscito a creare il contenuto perché la richiesta era incompleta: " +
                "riprova indicando la destinazione.",
              data: {
                invalidTool: call.name,
                invalidFields: validation.error.issues.map((i) => ({
                  field: i.path.join("."),
                  problem: i.message,
                })),
              },
            };
          } else {
            result = await tool.execute(call.arguments);
            if (result.ok && call.name === CREATE_TOOL) {
              const data = (result.data ?? {}) as { id?: unknown; editorialFormat?: unknown };
              const format =
                typeof data.editorialFormat === "string" && data.editorialFormat
                  ? data.editorialFormat
                  : typeof call.arguments.format === "string" && call.arguments.format
                    ? call.arguments.format
                    : null;
              created.push({
                id: typeof data.id === "string" ? data.id : "",
                message: result.message,
                format,
              });
              if (format) usedFormats.add(format);

              // Il modello deve sapere quanto manca: senza questo il secondo
              // post non avrebbe motivo di venire creato nello stesso turno. Il
              // conteggio è un'istruzione, non un log da mostrare all'utente, e
              // resta in `data` dove il modello lo legge da solo.
              const remaining = pendingCreates();
              if (remaining > 0) {
                result = {
                  ...result,
                  message: result.message,
                  data: {
                    ...((result.data ?? {}) as Record<string, unknown>),
                    requestedInTurn: requestedCount,
                    createdInTurn: created.length,
                    remainingInTurn: remaining,
                    nextStep: `Crea i ${remaining} post restanti con createContent, su una destinazione o un tema diverso e con un formato editoriale diverso.`,
                  },
                };
              }
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

      // La richiesta è soddisfatta solo quando TUTTI i post richiesti sono
      // stati creati: il turno non si chiude più al primo contenuto, ma non
      // resta aperto oltre il tetto (gli eventuali createContent successivi
      // vengono bloccati come duplicati).
      if (created.length > 0 && created.length >= requestedCount) {
        const finalText = createdContentsFinalText(created);
        await persistAssistant(finalText, undefined);
        emit?.({ type: "final", text: finalText });
        return { ok: true, finalText, executed };
      }
    }

    // Il turno è finito senza aver raggiunto il numero richiesto. La frase dice
    // solo quanto è stato fatto e che si può continuare: i conteggi interni e i
    // nomi dei tool non aiutano l'utente a decidere nulla.
    const fallbackMsg =
      created.length > 0
        ? `Post creati in stato DRAFT: sono ${created.length}. Li trovi nella sezione Contenuti. ` +
          "Dimmi se vuoi che ne prepari altri."
        : "Ho eseguito molte operazioni in sequenza: controlla lo stato aggiornato dei contenuti, il calendario e le approvazioni per vedere il risultato, oppure chiedimi di continuare.";
    await persistAssistant(fallbackMsg);
    emit?.({ type: "final", text: fallbackMsg });
    return { ok: true, finalText: fallbackMsg, executed };
  } catch (e) {
    const internal = e instanceof Error ? e.message : String(e);
    await logAudit("AI_AGENT_ERROR", "ChatConversation", conversationId, { error: internal });
    logAIError("agent.run", { conversationId }, e);
    const msg = friendlyError(e);
    // Senza prefissi: un punto esclamativo iniziale o un'emoji di avviso
    // trasformano un errore in un allarme, e l'utente legge un allarme come un
    // problema che non può risolvere. Qui il problema è un errore momentaneo e
    // la frase dice già che cosa fare.
    await persistAssistant(msg);
    emit?.({ type: "error", text: msg });
    return { ok: false, error: msg };
  }
}
