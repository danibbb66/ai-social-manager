import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chat silenziosa: in chat deve arrivare solo la risposta finale.
 *
 * ## Perché questi test leggono il sorgente
 *
 * Le regole da verificare sono di due nature diverse e nessuna delle due si
 * può provare chiamando una funzione. La prima riguarda l'agente, e lì un test
 * sul database dice già tutto. La seconda riguarda il pannello, che è un
 * componente React senza test esistenti: renderizzarlo richiederebbe
 * un'infrastruttura che questo progetto non ha, e una stringa come
 * "Esecuzione round {round}" è proprio il tipo di dettaglio che si reintroduce
 * con un refactor.
 *
 * Quindi il pannello viene verificato sul sorgente, con un controllo che guarda
 * il comportamento e non l'identità delle righe: la verifica è che certe
 * stringhe e certi costrutti non ci siano, e che la card di un tool riuscito non
 * venga renderizzata.
 *
 * Non è il controllo più forte possibile — un test di rendering lo sarebbe — ma
 * è il controllo che può esistere qui, e fallisce se qualcuno rimette a posto
 * una riga di avanzamento.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const chatPanel = read("src/components/chat/chat-panel.tsx");
const toolCard = read("src/components/chat/tool-result-card.tsx");
const agent = read("src/lib/ai/agent.ts");

test("CHAT: il pannello non contiene stringhe di avanzamento", () => {
  // Nessun contatore di round, nessun nome di modello, nessun nome di provider
  // nell'intestazione: sono tutte cose che descrivono l'esecuzione e non il
  // risultato.
  for (const vietata of [
    /Esecuzione round/,
    /Ollama/,
    /Qwen/,
    /round \{round\}/,
    /setRound/,
  ]) {
    assert.doesNotMatch(
      chatPanel,
      vietata,
      `chat-panel.tsx contiene "${vietata}": è una stringa di avanzamento`
    );
  }
});

test("CHAT: un tool riuscito non produce una riga", () => {
  // La regola è letterale nel sorgente: le card si mostrano solo quando il
  // tool è fallito. È la differenza fra "ha creato il contenuto" e una lista di
  // passaggi intermedi.
  assert.match(
    chatPanel,
    /m\.role === "TOOL"[\s\S]{0,200}toolOk !== false\) return null/,
    "le card dei tool devono essere mostrate solo per i fallimenti"
  );
  // E nel caricamento dal database, che è il caso di un reload.
  assert.match(
    chatPanel,
    /const failed = parsed\?\.ok === false;/,
    "il caricamento dal database deve distinguere i tool falliti"
  );
  assert.match(
    chatPanel,
    /hide: !failed,/,
    "un tool riuscito ricaricato dal database non deve avere una riga"
  );
});

test("CHAT: nessuna etichetta di tool viene mostrata mentre si lavora", () => {
  // Nel ramo "in esecuzione" la card non stampa il nome dello strumento: se lo
  // stampa, l'utente legge "Creazione contenuto" e poi la conferma, cioè due
  // messaggi per un'azione sola.
  assert.doesNotMatch(
    toolCard,
    /\{displayLabel\}\s*$/m,
    "tool-result-card.tsx stampa ancora il nome del tool nello stato in esecuzione"
  );
  assert.match(
    toolCard,
    /INTERNAL_LABELS/,
    "i nomi interni dei tool devono essere filtrati prima di arrivare a schermo"
  );
});

test("AGENTE: la frase di un round con tool non viene persistita in chat", () => {
  // Il narratore di un passaggio interno ("Cerco le proposte nel catalogo")
  // finiva in cronologia e compariva come una risposta seguita dalla conferma.
  assert.doesNotMatch(
    agent,
    /if \(parsed\.message\) await persistAssistant\(parsed\.message, calls\)/,
    "agent.ts persiste ancora la frase che accompagna una tool call"
  );
  // La conferma finale deve invece continuare a essere persistita.
  assert.match(
    agent,
    /await persistAssistant\(finalText, undefined\)/,
    "la risposta finale deve restare in cronologia"
  );
});

test("AGENTE: gli errori non portano prefissi di avviso", () => {
  // "⚠️" davanti a un errore lo fa sembrare un allarme, e l'utente legge un
  // allarme come un problema che non può risolvere.
  assert.doesNotMatch(agent, /persistAssistant\(`⚠️/, "agent.ts antepone ancora un avviso");
});