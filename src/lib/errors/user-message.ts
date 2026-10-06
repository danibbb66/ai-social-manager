/**
 * Gli errori interni, prima di arrivare all'utente.
 *
 * ## Il problema
 *
 * Un errore non gestito contiene quasi sempre un indirizzo, una porta, un
 * identificativo di database o il nome di un servizio: "Ollama non
 * raggiungibile su http://127.0.0.1:11434", "cuid non è un UUID valido",
 * "content clyv8k2p40000abc... non trovato". Sono informazioni vere e utili
 * per chi diagnostica, e informazioni che non servono a chi ha chiesto un
 * post: non può agire sulla porta di Ollama e non può usare un id interno.
 * Nell'agente finivano anche in chat, cioè nel testo che l'utente riapre la
 * settimana dopo.
 *
 * ## La regola
 *
 * Un errore tecnico non viene tradotto: viene sostituito. Chi deve
 * diagnosticare legge il log server-side (`logAIError`), che conserva tutto;
 * chi scrive in chat legge una frase di cortesia che dice che cosa fare e non
 * contiene nulla di interno. Il punto non è nascondere un guasto, è non
 * chiedere all'utente di essere un amministratore di rete.
 *
 * `maskInternalDetail` è comunque applicata a ogni messaggio che passa da
 * qui, anche a quelli già scritti a mano: una difesa in più costa poco e
 * chiude il caso in cui qualcuno domani mette un messaggio tecnico in una
 * stringa di cortesia.
 */

/** Le frasi che un utente può ricevere al posto di un errore. */
const GENERIC_MESSAGES = {
  /** Un'operazione è fallita per un motivo interno. */
  operation: "Si è verificato un errore durante l'operazione. Riprova tra poco.",
  /** Il servizio che risponde alle richieste non è raggiungibile. */
  service:
    "Il servizio che risponde alle richieste non è disponibile in questo momento. " +
    "Riprova tra poco: il resto del pannello continua a funzionare.",
  /** Un tool non ha potuto completare il lavoro. */
  tool: "Non sono riuscito a completare l'operazione. Riprova.",
} as const;

/**
 * Ciò che non può mai raggiungere l'utente.
 *
 * L'ordine conta: prima gli indirizzi completi, poi host e porte isolati, poi
 * i percorsi e infine gli identificatori. Ogni regola è pensata per non
 * cancellare il resto della frase: se un messaggio contiene un indirizzo, si
 * perde l'indirizzo e resta il motivo.
 */
const INTERNAL_PATTERNS: readonly RegExp[] = [
  // URL completi, con o senza schema, con o senza percorso.
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  // Host con porta: 127.0.0.1:11434, ollama:11434, cdn.example.com:8080.
  /\b[\w.-]+:\d{2,5}\b/g,
  // Resto di un host con porta, senza schema: "api.magnific.com/v1".
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+/gi,
  // Percorsi di file e di progetto.
  /(?:[A-Za-z]:)?[\\/](?:[\w .-]+[\\/])+[\w .-]+/g,
  // Chiavi di query e frammenti di URL rimasti.
  /[?&](?:[\w-]+=[^\s&]*)/g,
  // UUID e identificatori lunghi (cuid, cuid2, hash di contenuto).
  /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi,
  /\b[0-9a-z]{20,}\b/gi,
];

/** Il segnaposto che sostituisce un dettaglio interno tolto dal messaggio. */
const REDACTED = "";

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const message = (e as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * Toglie dalla frase tutto ciò che è interno, senza riscriverne il senso.
 *
 * Restituisce la frase ripulita e `true` se è rimasto qualcosa di utilizzabile.
 * Un messaggio già pulito torna identico: la funzione non è una normalizzazione,
 * è una rimozione, e non deve cambiare la voce dell'applicazione.
 */
function maskInternalDetail(message: string): { text: string; usable: boolean } {
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) return { text: "", usable: false };

  let text = trimmed;
  for (const pattern of INTERNAL_PATTERNS) {
    text = text.replace(pattern, REDACTED);
  }
  text = text.replace(/\s{2,}/g, " ").replace(/[\s:;,.-]+$/g, "").trim();

  // Una frase rimasta di tre caratteri ("404", "null") non è un messaggio:
  // sotto questa soglia non dice niente e fa solo rumore in chat.
  if (text.length < 8) return { text: "", usable: false };
  return { text, usable: true };
}

/** `true` se il testo contiene ancora un dettaglio che non deve essere mostrato. */
export function exposesInternalDetail(message: string): boolean {
  return INTERNAL_PATTERNS.some((pattern) => {
    const fresh = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return fresh.test(message);
  });
}

/**
 * Il messaggio di cortesia per un errore, con il dettaglio interno già tolto.
 *
 * La firma accetta il valore di default per non ripetere la stessa frase in
 * ogni tool: `friendlyMessage(e)` per il caso comune,
 * `friendlyMessage(e, "...")` quando l'operazione ha una frase sua.
 *
 * Un errore la cui frase è già dell'applicazione e non contiene nulla di
 * interno passa: un messaggio come "Generatore immagini non configurato" dice
 * all'utente che cosa fare, e riscriverlo con una frase generica lo
 * peggiorerebbe senza proteggere nulla.
 */
export function friendlyMessage(
  e: unknown,
  fallback: string = GENERIC_MESSAGES.operation
): string {
  const { text, usable } = maskInternalDetail(rawMessage(e));
  return usable ? text : fallback;
}

/** Il messaggio di cortesia quando è il servizio AI a non rispondere. */
export function friendlyServiceMessage(): string {
  return GENERIC_MESSAGES.service;
}

/** Il messaggio di cortesia per un tool che non ha potuto finire il lavoro. */
export function friendlyToolMessage(): string {
  return GENERIC_MESSAGES.tool;
}