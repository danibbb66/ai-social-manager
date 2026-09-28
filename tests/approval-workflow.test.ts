import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createContent,
  deleteContent,
  getContent,
  changeStatus,
  approveContent,
} from "../src/lib/services/content";
import { hasExplicitApproval } from "../src/lib/services/approvals";
import { publishContent } from "../src/lib/services/publish";
import {
  updateContentAction,
  approveAction,
  rejectAction,
  setStatusAction,
  scheduleAction,
  unscheduleAction,
  publishAction,
} from "../src/lib/actions/content";
import { prisma } from "../src/lib/prisma";

const createdIds: string[] = [];
const REPO_ROOT = join(__dirname, "..");

type ActionResult = { ok: boolean; status?: string; message?: string };

/**
 * revalidatePath() lancia "static generation store missing" quando le server
 * action sono invocate fuori dal runtime Next (cioè nei test). L'action ha già
 * scritto sul DB a quel punto, ma l'eccezione viene convertita in ok:false.
 * È un artefatto dell'ambiente, preesistente e comune a tutte le action.
 * Perciò il successo lo verifichiamo sullo stato persistito, non su ok:true.
 */
const REVALIDATE_ARTIFACT = /static generation store missing/i;

/**
 * Vince la promise dell'action solo se si assesta entro il limite.
 * Se la promise resta appesa (spinner infinito) il test fallisce.
 * Una rejection viene rilanciata: il chiamante deve vedere l'errore.
 */
async function settlesWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const result = await Promise.race([
    p.then(
      (v) => ({ kind: "settled" as const, value: v }),
      (e) => ({ kind: "rejected" as const, error: e })
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), ms).unref?.()
    ),
  ]);
  if (result.kind === "timeout") {
    assert.fail(
      `${label}: la promise non si è assestata entro ${ms}ms (spinner infinito)`
    );
  }
  if (result.kind === "rejected") throw result.error;
  return result.value;
}

async function makeDraft(title: string, caption: string | null = "Caption di test") {
  const c = await createContent({
    title,
    caption,
    hashtags: "#test",
    platforms: ["INSTAGRAM"],
  });
  createdIds.push(c.id);
  return c;
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
});

after(async () => {
  await cleanup();
});

describe("Approvazione umana diretta: la action completa e non lascia promise appese", () => {
  test("1) approveAction assesta la promise e porta davvero in APPROVED", async () => {
    const content = await makeDraft("[TEST] approve action completa");
    assert.equal(content.status, "DRAFT", "precondizione: parte da DRAFT");

    const started = Date.now();
    const result = (await settlesWithin(
      approveAction(content.id, "approvata dal test"),
      10000,
      "approveAction"
    )) as ActionResult;
    const elapsed = Date.now() - started;

    assert.ok(result, "l'action deve restituire un valore");
    if (result.ok === false) {
      // Se l'action ha risposto ok:false, l'unico motivo ammesso qui è
      // l'artefatto revalidatePath: la scrittura è già avvenuta.
      assert.match(
        String(result.message ?? ""),
        REVALIDATE_ARTIFACT,
        "ok:false è ammesso solo per l'artefatto revalidatePath fuori da Next"
      );
    }
    assert.ok(elapsed < 10000, `l'action deve rispondere in tempi umani (${elapsed}ms)`);

    // Persistenza reale verificata direttamente sul DB.
    const after = await getContent(content.id);
    assert.ok(after, "il contenuto deve esistere dopo l'azione");
    assert.equal(after.status, "APPROVED", "lo stato deve essere persistito come APPROVED");

    // L'approvazione deve essere registrata, non solo lo stato.
    const records = await prisma.approval.findMany({
      where: { contentId: content.id, decision: "APPROVED" },
    });
    assert.equal(records.length, 1, "deve esistere un solo record Approval APPROVED");
    assert.equal(records[0].note, "approvata dal test");
    assert.equal(await hasExplicitApproval(content.id), true);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: content.id, action: "CONTENT_APPROVED" },
    });
    assert.equal(audit.length, 1, "deve essere scritto un solo CONTENT_APPROVED");
  });

  test("2) dopo l'approvazione l'editor non mostra più Approva/Rifiuta", async () => {
    const content = await makeDraft("[TEST] pulsanti non più visibili");
    await approveAction(content.id);

    const after = await getContent(content.id);
    assert.ok(after, "il contenuto deve esistere");
    // La UI decide con questa condizione: status DRAFT => pulsanti visibili.
    assert.equal(
      after.status === "DRAFT",
      false,
      "con status APPROVED canApprove/canReject sono false e i pulsanti vengono smontati"
    );
  });

  test("3) un errore di business viene restituito e la promise si assesta comunque", async () => {
    // Contenuto senza caption: il servizio rifiuta l'approvazione con un
    // messaggio esplicito. È il caso in cui l'utente deve vedere l'errore
    // e poter tornare indietro a correggerlo.
    const c = await makeDraft("[TEST] approve senza caption", null);

    const result = (await settlesWithin(
      approveAction(c.id),
      10000,
      "approveAction (senza caption)"
    )) as ActionResult;

    assert.equal(result.ok, false, "senza caption l'azione deve fallire");
    assert.match(
      String(result.message ?? ""),
      /caption/i,
      "il messaggio deve spiegare il motivo del rifiuto"
    );

    // Lo stato non deve essere cambiato da un tentativo fallito.
    const after = await getContent(c.id);
    assert.ok(after, "il contenuto deve esistere");
    assert.equal(after.status, "DRAFT", "lo stato resta DRAFT dopo un errore");
    assert.equal(await hasExplicitApproval(c.id), false, "nessuna approvazione registrata");

    // L'utente può correggere e riprovare.
    const fixed = await settlesWithin(
      updateContentAction({
        id: c.id,
        caption: "Caption aggiunta dopo l'errore",
      } as never),
      10000,
      "updateContentAction"
    );
    assert.ok(fixed, "la correzione deve restituire un valore");

    const check = await getContent(c.id);
    assert.ok(check, "il contenuto deve esistere");
    assert.ok(check.caption, "la caption deve essere stata salvata");
    assert.equal(check.status, "DRAFT", "la correzione non cambia lo stato");

    const retry = (await settlesWithin(
      approveAction(c.id),
      10000,
      "approveAction (retry)"
    )) as ActionResult;
    assert.ok(retry, "il retry deve restituire un valore");
    const final = await getContent(c.id);
    assert.ok(final, "il contenuto deve esistere");
    assert.equal(final.status, "APPROVED", "il retry porta davvero in APPROVED");
  });

  test("4) un id inesistente produce ok:false senza appese la promise", async () => {
    const result = (await settlesWithin(
      approveAction("cm0000000000000000000000"),
      10000,
      "approveAction (id inesistente)"
    )) as ActionResult;
    assert.equal(result.ok, false);
    assert.ok(result.message, "un errore deve sempre avere un messaggio");
    assert.doesNotMatch(
      String(result.message),
      REVALIDATE_ARTIFACT,
      "un id inesistente deve fallire per il motivo reale, non per l'ambiente"
    );
  });
});

describe("Rifiuto e ritorno in lavorazione", () => {
  test("5) rejectAction porta da DRAFT a REJECTED e registra la motivazione", async () => {
    const content = await makeDraft("[TEST] reject action");
    const result = (await settlesWithin(
      rejectAction(content.id, "non mi piace"),
      10000,
      "rejectAction"
    )) as ActionResult;
    assert.ok(result, "l'action deve restituire un valore");
    const after = await getContent(content.id);
    assert.equal(after?.status, "REJECTED");
    const records = await prisma.approval.findMany({
      where: { contentId: content.id, decision: "REJECTED" },
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].note, "non mi piace");
  });

  test("6) REJECTED → DRAFT tramite setStatusAction", async () => {
    const content = await makeDraft("[TEST] reject back to draft");
    await rejectAction(content.id, "no");
    const result = (await settlesWithin(
      setStatusAction(content.id, "DRAFT"),
      10000,
      "setStatusAction"
    )) as ActionResult;
    assert.ok(result, "l'action deve restituire un valore");
    const after = await getContent(content.id);
    assert.equal(after?.status, "DRAFT");
  });

  test("7) FAILED → DRAFT recupera un errore tecnico", async () => {
    const content = await makeDraft("[TEST] failed recovery");
    await prisma.content.update({
      where: { id: content.id },
      data: { status: "FAILED" },
    });
    const back = await changeStatus(content.id, "DRAFT");
    assert.equal(back.status, "DRAFT");
  });
});

describe("Gate: senza approvazione esplicita non si pubblica", () => {
  test("8) APPROVED forzato via prisma senza Approval non può essere pubblicato", async () => {
    const content = await makeDraft("[TEST] gate no approval");
    await prisma.content.update({
      where: { id: content.id },
      data: { status: "APPROVED" },
    });
    assert.equal(await hasExplicitApproval(content.id), false);
    await assert.rejects(publishContent(content.id), /approvazione esplicita/i);
  });

  test("9) con Approval esplicita il gate di approvazione viene superato", async () => {
    const content = await makeDraft("[TEST] gate with approval");
    await approveContent(content.id);
    assert.equal(await hasExplicitApproval(content.id), true);
    // Il publish si ferma al gate successivo (conferma esplicita): questo
    // dimostra che il gate di approvazione è passato, senza toccare alcun
    // provider reale.
    await assert.rejects(publishContent(content.id), /conferma esplicita/i);
  });

  test("10) SCHEDULED continua a richiedere APPROVED", async () => {
    const draft = await makeDraft("[TEST] gate schedule requires approved");
    // Le action non rigettano: riportano l'errore in ok:false.
    const refused = (await settlesWithin(
      scheduleAction(draft.id, new Date(Date.now() + 86400000).toISOString()),
      10000,
      "scheduleAction (da DRAFT)"
    )) as ActionResult;
    assert.equal(refused.ok, false);
    assert.match(String(refused.message ?? ""), /approvat/i);
    const kept = await getContent(draft.id);
    assert.equal(kept?.status, "DRAFT", "una DRAFT non può essere programmata");

    // Da APPROVED la programmazione va invece a buon fine.
    await approveAction(draft.id);
    const ok = (await settlesWithin(
      scheduleAction(draft.id, new Date(Date.now() + 86400000).toISOString()),
      10000,
      "scheduleAction"
    )) as ActionResult;
    assert.ok(ok, "la programmazione deve restituire un valore");
    assert.equal((await getContent(draft.id))?.status, "SCHEDULED");

    // E la programmazione si annulla tornando ad APPROVED.
    const off = (await settlesWithin(
      unscheduleAction(draft.id),
      10000,
      "unscheduleAction"
    )) as ActionResult;
    assert.ok(off, "l'annullamento deve restituire un valore");
    const back = await getContent(draft.id);
    assert.equal(back?.status, "APPROVED");
    assert.equal(back?.scheduledDate, null);
  });
});

/**
 * Guardia di regressione sul contratto client/server.
 *
 * Il bug: afterAction() chiamava router.refresh() DENTRO la startTransition.
 * Ogni action già revalida "/", "/contents", "/calendar" e "/contents/{id}",
 * quindi la risposta contiene l'albero aggiornato; il refresh ridondante
 * impediva la chiusura della transition e pending restava true per sempre.
 */
describe("Il percorso client non usa più un refresh ridondante", () => {
  const editorSource = readFileSync(
    join(REPO_ROOT, "src", "components", "content", "editor.tsx"),
    "utf8"
  );
  const actionsSource = readFileSync(
    join(REPO_ROOT, "src", "lib", "actions", "content.ts"),
    "utf8"
  );

  test("afterAction non chiama router.refresh()", () => {
    const start = editorSource.indexOf("const afterAction");
    assert.notEqual(start, -1, "afterAction deve esistere nell'editor");
    const body = editorSource.slice(start, editorSource.indexOf("};", start));
    assert.doesNotMatch(
      body,
      /router\.refresh\s*\(/,
      "afterAction non deve chiamare router.refresh(): competerebbe con la revalidazione della action"
    );
  });

  test("ogni action usata da runAction revalida la rotta corrente", () => {
    // Le action sono referenziate davvero a runtime: se una viene rimossa o
    // rinominata, questo test fallisce invece di passare silenziosamente.
    const used: [string, unknown][] = [
      ["updateContentAction", updateContentAction],
      ["approveAction", approveAction],
      ["rejectAction", rejectAction],
      ["setStatusAction", setStatusAction],
      ["scheduleAction", scheduleAction],
      ["unscheduleAction", unscheduleAction],
      ["publishAction", publishAction],
    ];

    for (const [name, fn] of used) {
      assert.equal(
        typeof fn,
        "function",
        `${name} deve essere esportata e chiamabile dall'editor`
      );
      const start = actionsSource.indexOf(`export async function ${name}`);
      assert.notEqual(start, -1, `${name} deve esistere in actions/content.ts`);
      const body = actionsSource.slice(start, actionsSource.indexOf("\n}", start));
      assert.match(
        body,
        /revalidatePath|paths\(/,
        `${name} deve revalidare lato server, altrimenti serve un refresh manuale`
      );
    }
    assert.match(
      actionsSource,
      /const paths = \(id\?: string\) => \["\/", "\/contents", "\/calendar", \.\.\.\(id \? \[`\/contents\/\$\{id\}`\] : \[\]\)\]/,
      "paths() deve includere la rotta del dettaglio contenuto"
    );
  });
});

/**
 * Guardia di regressione sul workflow.
 *
 * REVIEW è legacy: nessun src deve più introdurlo nel flusso utente,
 * e DRAFT → REVIEW non deve più essere una transizione applicativa.
 */
describe("Nessun ritorno di submitForReview né di REVIEW come fase", () => {
  const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf8");
  const editorSource = read("src", "components", "content", "editor.tsx");
  const contentService = read("src", "lib", "services", "content.ts");
  const actionsSource = read("src", "lib", "actions", "content.ts");
  const approvalsService = read("src", "lib", "services", "approvals.ts");
  const approvalsTools = read("src", "lib", "ai", "tools", "approvals.ts");
  const registrySource = read("src", "lib", "ai", "tools", "registry.ts");
  const agent = read("src", "lib", "ai", "agent.ts");
  const chatPanel = read("src", "components", "chat", "chat-panel.tsx");
  const stats = read("src", "lib", "services", "stats.ts");
  const status = read("src", "lib", "status.ts");
  const approvalsPage = read("src", "app", "approvals", "page.tsx");
  const contentsPage = read("src", "app", "contents", "page.tsx");
  const approvalActions = read("src", "components", "content", "approval-actions.tsx");

  test("nessun src importa o espone submitForReview", () => {
    for (const [name, source] of [
      ["services/content.ts", contentService],
      ["actions/content.ts", actionsSource],
      ["ai/tools/approvals.ts", approvalsTools],
      ["ai/tools/registry.ts", registrySource],
      ["components/content/editor.tsx", editorSource],
    ] as const) {
      assert.doesNotMatch(
        source,
        /submitForReview/,
        `${name} non deve più contenere submitForReview`
      );
    }
  });

  test("l'editor non propone più l'invio in revisione e delega le decisioni", () => {
    assert.doesNotMatch(editorSource, /Invia in revisione/);
    assert.doesNotMatch(editorSource, /in revisione/);
    assert.match(editorSource, /ApprovalActions/);
    assert.match(
      editorSource,
      /canApprove = content\.status === "DRAFT"/,
      "Approva e Rifiuta devono essere disponibili da DRAFT"
    );
    // Nessuna seconda implementazione client: l'editor non chiama più le action.
    assert.doesNotMatch(editorSource, /approveAction\(/);
    assert.doesNotMatch(editorSource, /rejectAction\(/);
  });

  test("Approva e Rifiuta vivono in un unico componente condiviso", () => {
    assert.match(approvalActions, /approveAction\(contentId/);
    assert.match(approvalActions, /rejectAction\(contentId/);
    assert.match(approvalActions, /Approva/);
    assert.match(approvalActions, /Rifiuta/);
    assert.doesNotMatch(approvalActions, /submitForReview/);
  });

  test("la coda di approvazione guarda i DRAFT, non i REVIEW", () => {
    assert.match(approvalsService, /where: \{ status: "DRAFT" \}/);
    assert.doesNotMatch(approvalsService, /status: "REVIEW"/);
    assert.match(stats, /pendingApproval: counts\.DRAFT \?\? 0/);
    assert.doesNotMatch(stats, /counts\.REVIEW/);
  });

  test("nessun tool AI né prompt descrive REVIEW come fase del workflow", () => {
    assert.doesNotMatch(registrySource, /submitForReview/);
    assert.doesNotMatch(approvalsTools, /REVIEW/);
    assert.doesNotMatch(agent, /DRAFT → REVIEW/);
    assert.doesNotMatch(agent, /submitForReview/);
    assert.match(agent, /DRAFT → APPROVED → SCHEDULED → PUBLISHED/);
    assert.doesNotMatch(chatPanel, /in revisione/);
  });

  test("la coda di approvazione vive in Contents, non in una pagina separata", () => {
    // /approvals resta solo come redirect: niente seconda UI di Approva/Rifiuta.
    assert.match(approvalsPage, /redirect\("\/contents\?view=approvals"\)/);
    assert.doesNotMatch(approvalsPage, /[Rr]evisione/);
    assert.match(contentsPage, /Da approvare/);
    assert.doesNotMatch(contentsPage, /[Rr]evisione/);
  });

  test("la matrice delle transizioni non contiene mai REVIEW come destinazione", () => {
    const block = status.slice(
      status.indexOf("ALLOWED_TRANSITIONS"),
      status.indexOf("export function canTransition")
    );
    const lines = block
      .split("\n")
      .filter((l) => /^\s+[A-Z]+: \[/.test(l));
    assert.ok(lines.length >= 7, "la matrice deve coprire tutti gli stati dell'enum");
    for (const line of lines) {
      assert.doesNotMatch(
        line,
        /"REVIEW"/,
        `nessuno stato può transitare verso REVIEW: ${line.trim()}`
      );
    }
  });
});
