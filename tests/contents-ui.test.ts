import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardia di regressione sulla UI di /contents.
 *
 * Non prova il rendering (niente DOM nel test runner): verifica le invarianti
 * strutturali che tengono insieme l'architettura decisa.
 *
 *  1. Contents è il centro operativo: nessuna seconda coda di approvazione.
 *  2. I filtri sono globali, sempre visibili, e non introducono REVIEW.
 *  3. Approva/Rifiuta hanno una sola implementazione client.
 *  4. La Review Deck non introduce animazioni di layout/reflow e rispetta
 *     prefers-reduced-motion, mouse, tastiera e touch.
 *  5. La sidebar non duplica le sezioni e la dashboard non gestisce contenuti.
 */
const REPO_ROOT = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const SRC_FILES = walk("src");

const contentsPage = read("src", "app", "contents", "page.tsx");
const filterBar = read("src", "components", "content", "status-filter-bar.tsx");
const reviewDeck = read("src", "components", "content", "review-deck.tsx");
const approvalActions = read("src", "components", "content", "approval-actions.tsx");
const editor = read("src", "components", "content", "editor.tsx");
const sidebar = read("src", "components", "sidebar.tsx");
const approvalsPage = read("src", "app", "approvals", "page.tsx");
const dashboard = read("src", "app", "page.tsx");
const globals = read("src", "app", "globals.css");
const pkg = read("package.json");

describe("Contents è l'unico centro operativo", () => {
  test("la coda di approvazione vive in Contents, non in /approvals", () => {
    assert.match(contentsPage, /view=approvals|view: "approvals"/);
    assert.match(approvalsPage, /redirect\("\/contents\?view=approvals"\)/);
    // La vecchia coda indipendente non deve più esistere.
    assert.equal(
      existsSync(join(REPO_ROOT, "src", "components", "approvals.tsx")),
      false,
      "src/components/approvals.tsx è stata sostituita da Contents"
    );
  });

  test("nessun link interno porta più a /approvals", () => {
    for (const file of SRC_FILES) {
      assert.doesNotMatch(
        read(...file.split("/")),
        /href=["'{`]\/approvals/,
        `${file} non deve più linkare /approvals come pagina`
      );
    }
  });

  test("la rotta /approvals non carica dati propri", () => {
    assert.doesNotMatch(approvalsPage, /listContents|getPendingApprovals|ApprovalActions/);
  });

  test("le tre viste sono sulla stessa rotta", () => {
    for (const view of ["approvals", "history", "list"]) {
      assert.match(contentsPage, new RegExp(`"${view}"`), `manca la vista ${view}`);
    }
    assert.match(contentsPage, /ReviewDeck/);
    assert.match(contentsPage, /ApprovalHistoryList/);
  });

  test("la ricerca è un solo form e non duplica la barra di ricerca", () => {
    const forms = contentsPage.match(/<form/g) ?? [];
    assert.equal(forms.length, 1, "un solo form di ricerca in Contents");
    assert.equal(
      (contentsPage.match(/name="q"/g) ?? []).length,
      1,
      "un solo input di ricerca"
    );
    // La ricerca non deve perdere il contesto della vista corrente.
    assert.match(contentsPage, /<input type="hidden" name="status"/);
  });
});

describe("I filtri sono globali e non reintroducono REVIEW", () => {
  test("i conteggi vengono da countsByStatus, non dal dataset filtrato", () => {
    assert.match(contentsPage, /countsByStatus\(\)/);
    assert.match(contentsPage, /<StatusFilterBar[\s\S]*counts=\{counts\}/);
    assert.doesNotMatch(
      contentsPage,
      /contents\.filter\([^)]*status/,
      "i conteggi non devono essere ricalcolati sui dati già filtrati"
    );
  });

  test("le voci derivano da STATUS_ORDER e mai da REVIEW", () => {
    assert.match(filterBar, /STATUS_ORDER\.map/);
    assert.doesNotMatch(filterBar, /"REVIEW"/);
    assert.doesNotMatch(contentsPage, /"REVIEW"/);
  });

  test("DRAFT è la coda: un solo filtro per i bozze", () => {
    // ?status=DRAFT e ?view=approvals convergono sulla Review Deck.
    assert.match(contentsPage, /rawStatus === "DRAFT"/);
    assert.match(contentsPage, /isDeck \? "APPROVALS"/);
    assert.match(filterBar, /linkFor\(\{ view: "approvals" \}\)/);
  });

  test("esiste una sola chiave di filtro attiva", () => {
    // Senza `active` un filtro per stato e "Tutti" risulterebbero entrambi attivi.
    assert.match(contentsPage, /const activeFilter =/);
    assert.match(filterBar, /aria-current=\{active === f\.value \? "page" : undefined\}/);
  });
});

describe("Approva e Rifiuta hanno una sola implementazione", () => {
  test("le sole chiamate client alle action di approvazione sono nello shared component", () => {
    for (const file of SRC_FILES) {
      const source = read(...file.split("/"));
      if (!/components[\\/]/.test(file)) continue;
      if (file.endsWith("content/approval-actions.tsx")) continue;
      assert.doesNotMatch(
        source,
        /\b(approveAction|rejectAction)\(/,
        `${file} non deve chiamare direttamente approveAction/rejectAction: passi da ApprovalActions`
      );
    }
  });

  test("un solo file chiama le action di approvazione lato client", () => {
    // Solo la UI client: le definizioni stanno in lib/actions e i tool AI usano
    // i service (approveContent/rejectContent), non le action.
    const callers = SRC_FILES.filter(
      (f) =>
        (f.startsWith("src/components/") || f.startsWith("src/app/")) &&
        /\b(approveAction|rejectAction)\(/.test(read(...f.split("/")))
    ).sort();
    assert.deepEqual(
      callers,
      ["src/components/content/approval-actions.tsx"],
      "le action di approvazione hanno un solo punto di ingresso client"
    );
  });

  test("l'editor delega e il dialog di rifiuto riusa rejectAction", () => {
    assert.match(editor, /<ApprovalActions/);
    assert.match(approvalActions, /approveAction\(contentId/);
    assert.match(approvalActions, /rejectAction\(contentId/);
    // Il rifiuto chiede una motivazione invece di cancellare.
    assert.match(approvalActions, /Motivo|motivazione|Perché/i);
    assert.doesNotMatch(approvalActions, /deleteContent/);
  });
});

describe("La Review Deck rispetta prestazione e accessibilità", () => {
  test("nessuna dipendenza di animazione aggiuntiva", () => {
    assert.doesNotMatch(pkg, /framer-motion|"motion"|react-spring|auto-animate/);
  });

  test("l'animazione usa solo transform e opacity", () => {
    assert.match(reviewDeck, /transform/);
    assert.match(reviewDeck, /opacity/);
    for (const forbidden of [
      /transition-all/,
      /animate-bounce/,
      /animate-pulse/,
      /animate-ping/,
      /width:\s*`/,
      /height:\s*`/,
      /\.style\.(width|height|top|left)\s*=/,
    ]) {
      assert.doesNotMatch(reviewDeck, forbidden, `animazione non consentita: ${forbidden}`);
    }
  });

  test("il loop di animazione è a riposo quando non serve", () => {
    assert.match(reviewDeck, /requestAnimationFrame/);
    assert.match(reviewDeck, /running\.current/);
    // Il rettangolo è cache: niente layout read a ogni pointermove.
    assert.match(reviewDeck, /rectRef/);
  });

  test("prefers-reduced-motion disattiva rotazione e parallax", () => {
    assert.match(reviewDeck, /prefers-reduced-motion: reduce/);
    assert.match(reviewDeck, /deck-card-reduced/);
    assert.match(globals, /\.deck-card-reduced/);
    assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
  });

  test("mouse, tastiera e touch hanno tutti un percorso di decisione", () => {
    assert.match(reviewDeck, /onPointerEnter/);
    assert.match(reviewDeck, /onClick/);
    assert.match(reviewDeck, /onKeyDown/);
    assert.match(reviewDeck, /e\.pointerType !== "mouse"/);
    // Le azioni ci sono anche come pulsanti reali, non solo come gesture.
    assert.match(reviewDeck, /aria-label="Approva questo contenuto"/);
    assert.match(reviewDeck, /aria-label="Scarta questo contenuto"/);
    assert.match(reviewDeck, /RejectReasonDialog/);
  });

  test("la card non legge la Media Library", () => {
    // L'anteprima usa i media già associati: nessuna query, nessun upload.
    assert.match(reviewDeck, /item\.assets\[0\]/);
    assert.doesNotMatch(reviewDeck, /generateImage|Magnific|listAssets/);
  });
});

describe("Sidebar e Dashboard non gestiscono contenuti", () => {
  test("la sidebar non ha più Approvazioni né Idee", () => {
    assert.doesNotMatch(sidebar, /href="\/approvals"/);
    assert.doesNotMatch(sidebar, /href="\/ideas"/);
    assert.match(sidebar, /Principale/);
    assert.match(sidebar, /Configurazione/);
    // Contents resta evidenziato anche su ?view=approvals e sulle sotto-route:
    // l'active state deriva dal pathname, non dalla query string.
    assert.match(sidebar, /pathname\.startsWith\(item\.href\)/);
    assert.match(
      sidebar,
      /item\.href === "\/" \? pathname === "\/" : pathname\.startsWith\(item\.href\)/,
      "la home deve essere attiva solo sulla home esatta"
    );
  });

  test("la dashboard porta ai numeri che contano e non duplica elenchi", () => {
    assert.match(dashboard, /\/contents\?view=approvals/);
    assert.match(dashboard, /Nuovo contenuto|new-content-button/);
    assert.doesNotMatch(dashboard, /Totale contenuti/);
    assert.doesNotMatch(dashboard, /approveAction|rejectAction/);
    // Idee, account e calendario restano aperti dai propri moduli.
    assert.doesNotMatch(dashboard, /\/ideas/);
  });

  test("le idee restano una fase separata e raggiungibili", () => {
    const chat = read("src", "app", "chat", "page.tsx");
    assert.ok(existsSync(join(REPO_ROOT, "src", "app", "ideas", "page.tsx")));
    assert.match(chat, /href="\/ideas"/);
  });
});
