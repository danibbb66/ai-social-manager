import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createContent,
  approveContent,
  rejectContent,
  scheduleContent,
  unscheduleContent,
  changeStatus,
  deleteContent,
  getContent,
  updateContent,
  listContents,
  countContents,
} from "../src/lib/services/content";
import { moveContentOnCalendar, getCalendar } from "../src/lib/services/calendar";
import { hasExplicitApproval, getPendingApprovals, getApprovalState } from "../src/lib/services/approvals";
import { publishContent } from "../src/lib/services/publish";
import { prisma } from "../src/lib/prisma";
import {
  approveContentTool,
  rejectContentTool,
  getPendingApprovalsTool,
} from "../src/lib/ai/tools/approvals";
import { createContentTool } from "../src/lib/ai/tools/content";
import { getTool } from "../src/lib/ai/tools/registry";
import { ALLOWED_TRANSITIONS, STATUS_ORDER, canTransition } from "../src/lib/status";
import { setImageProvider } from "../src/lib/images/factory";
import { ImageProvider } from "../src/lib/images/provider";

/**
 * createContentTool genera il visual del DRAFT: nei test il provider è un
 * doppione che NON genera, così nessuna chiamata di rete e nessun consumo di
 * crediti. Il percorso di generazione è verificato in
 * tests/content-creation-media.test.ts.
 */
class NoopImageProvider implements ImageProvider {
  readonly name = "test-noop";
  readonly canGenerate = false;
  async generateImage(): Promise<never> {
    throw new Error("il provider di test non genera immagini");
  }
  async saveUploadedFile(): Promise<never> {
    throw new Error("il provider di test non salva file");
  }
}

const createdIds: string[] = [];
const REPO_ROOT = join(__dirname, "..");

function futureDate(days = 1): Date {
  return new Date(Date.now() + days * 86400000);
}

function pastDate(): Date {
  return new Date(Date.now() - 86400000);
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

async function makeDraft(title: string) {
  const c = await createContent({
    title,
    caption: "Caption di test",
    platforms: ["INSTAGRAM"],
  });
  createdIds.push(c.id);
  return c;
}

before(async () => {
  setImageProvider(new NoopImageProvider());
  await cleanup();
});

after(async () => {
  setImageProvider(null);
  await cleanup();
});

test("createContent crea sempre un contenuto in DRAFT", async () => {
  const c = await makeDraft("[TEST] create DRAFT");
  assert.equal(c.status, "DRAFT");
});

test("DRAFT → APPROVED ok e registra approvazione esplicita", async () => {
  const c = await makeDraft("[TEST] approve from draft");
  const up = await approveContent(c.id, "ok");
  assert.equal(up.status, "APPROVED");
  assert.equal(await hasExplicitApproval(c.id), true);
});

test("approveContent crea il record Approval con decisione APPROVED", async () => {
  const c = await makeDraft("[TEST] approval record");
  await approveContent(c.id, "approvato dal test");
  const records = await prisma.approval.findMany({ where: { contentId: c.id } });
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "APPROVED");
  assert.equal(records[0].note, "approvato dal test");
  assert.ok(records[0].createdAt instanceof Date, "il record deve avere un timestamp");
});

test("approveContent registra l'audit CONTENT_APPROVED", async () => {
  const c = await makeDraft("[TEST] approval audit");
  await approveContent(c.id);
  const audit = await prisma.auditLog.findMany({
    where: { entityId: c.id, action: "CONTENT_APPROVED" },
  });
  assert.equal(audit.length, 1, "deve essere scritto un CONTENT_APPROVED");
});

test("approveContent rifiuta contenuti che non sono in DRAFT", async () => {
  const c = await makeDraft("[TEST] approve twice");
  await approveContent(c.id);
  await assert.rejects(approveContent(c.id), /DRAFT/);
  const kept = await getContent(c.id);
  assert.equal(kept?.status, "APPROVED", "lo stato non deve cambiare");
});

test("DRAFT → APPROVED non è raggiungibile con changeStatus generico", async () => {
  const c = await makeDraft("[TEST] bypass via changeStatus");
  await assert.rejects(changeStatus(c.id, "APPROVED"), /approvazione richiede/i);
  await assert.rejects(
    updateContent(c.id, { status: "APPROVED" }),
    /approvazione richiede/i
  );
  const kept = await getContent(c.id);
  assert.equal(kept?.status, "DRAFT");
  assert.equal(await hasExplicitApproval(c.id), false, "nessun approval deve esistere");
});

test("DRAFT → REJECTED ok con motivazione e creazione del record", async () => {
  const c = await makeDraft("[TEST] reject from draft");
  const up = await rejectContent(c.id, "testo da rivedere");
  assert.equal(up.status, "REJECTED");
  const records = await prisma.approval.findMany({ where: { contentId: c.id } });
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "REJECTED");
  assert.equal(records[0].note, "testo da rivedere");
});

test("REJECTED → DRAFT torna in lavorazione", async () => {
  const c = await makeDraft("[TEST] rejected back to draft");
  await rejectContent(c.id, "no");
  const back = await changeStatus(c.id, "DRAFT");
  assert.equal(back.status, "DRAFT");
  // tornato in bozza, è di nuovo approvabile
  const up = await approveContent(c.id);
  assert.equal(up.status, "APPROVED");
});

test("FAILED → DRAFT recupera un contenuto con errore tecnico", async () => {
  const c = await makeDraft("[TEST] failed back to draft");
  await prisma.content.update({ where: { id: c.id }, data: { status: "FAILED" } });
  const back = await changeStatus(c.id, "DRAFT");
  assert.equal(back.status, "DRAFT");
});

test("DRAFT → SCHEDULED non consentito direttamente", async () => {
  const c = await makeDraft("[TEST] draft schedule no");
  await assert.rejects(scheduleContent(c.id, futureDate()), /approvat/i);
  const kept = await getContent(c.id);
  assert.equal(kept?.status, "DRAFT");
});

test("DRAFT → PUBLISHED non consentito (manca approvazione)", async () => {
  const c = await makeDraft("[TEST] draft publish no");
  await assert.rejects(publishContent(c.id), /approvato|approvazione/i);
  const kept = await getContent(c.id);
  assert.equal(kept?.status, "DRAFT");
});

test("APPROVED → SCHEDULED ok con data futura", async () => {
  const c = await makeDraft("[TEST] approved schedule");
  await approveContent(c.id);
  const up = await scheduleContent(c.id, futureDate());
  assert.equal(up.status, "SCHEDULED");
});

test("scheduleContent rifiuta data nel passato", async () => {
  const c = await makeDraft("[TEST] no past date");
  await approveContent(c.id);
  await assert.rejects(scheduleContent(c.id, pastDate()), /passato/i);
});

test("SCHEDULED senza Approval esplicita non è programmabile", async () => {
  const c = await makeDraft("[TEST] schedule senza approval");
  // Bypass lato database: stato APPROVED senza record Approval.
  await prisma.content.update({ where: { id: c.id }, data: { status: "APPROVED" } });

  await assert.rejects(
    scheduleContent(c.id, futureDate()),
    /approvazione esplicita/i,
    "programmare senza Approval creerebbe una coda che non può mai essere pubblicata"
  );

  const kept = await getContent(c.id);
  assert.equal(kept?.status, "APPROVED", "resta dov'è, senza finire in coda");
  assert.equal(kept?.scheduledDate, null);
});

test("PUBLISHED raggiungibile solo con approvazione esplicita", async () => {
  const c = await makeDraft("[TEST] publish explicit only");
  // changeStatus/updateContent non possono forzare APPROVED senza record esplicito
  await assert.rejects(changeStatus(c.id, "APPROVED"), /approvazione richiede/i);
  await assert.rejects(
    updateContent(c.id, { status: "APPROVED" }),
    /approvazione richiede/i
  );
  // Nemmeno APPROVED via prisma può essere pubblicato senza record di approvazione
  await prisma.content.update({
    where: { id: c.id },
    data: { status: "APPROVED" },
  });
  assert.equal(await hasExplicitApproval(c.id), false);
  await assert.rejects(publishContent(c.id), /approvazione esplicita/i);
});

test("SCHEDULED → APPROVED annulla la programmazione e mantiene l'approvazione", async () => {
  const c = await makeDraft("[TEST] unschedule");
  await approveContent(c.id);
  await scheduleContent(c.id, futureDate());
  const up = await unscheduleContent(c.id);
  assert.equal(up.status, "APPROVED");
  assert.equal(up.scheduledDate, null);
  assert.equal(await hasExplicitApproval(c.id), true, "l'approvazione resta valida");
});

test("changeStatus rispetta le transizioni consentite (APPROVED → DRAFT ok, DRAFT → PUBLISHED no)", async () => {
  const c = await makeDraft("[TEST] transitions");
  await approveContent(c.id);
  const back = await changeStatus(c.id, "DRAFT");
  assert.equal(back.status, "DRAFT");
  await assert.rejects(changeStatus(c.id, "PUBLISHED"), /Transizione non consentita/i);
});

test("getCalendar restituisce solo SCHEDULED e PUBLISHED", async () => {
  const draft = await makeDraft("[TEST] calendar draft");
  const approved = await makeDraft("[TEST] calendar approved");
  await approveContent(approved.id);
  await scheduleContent(approved.id, futureDate());

  const items = await getCalendar({ from: new Date(Date.now() - 3600000), to: futureDate(7) });
  const ids = items.map((c) => c.id);
  assert.equal(ids.includes(draft.id), false);
  assert.equal(ids.includes(approved.id), true);
});

test("moveContentOnCalendar rifiuta contenuti non APPROVED/SCHEDULED", async () => {
  const draft = await makeDraft("[TEST] move draft no");
  await assert.rejects(moveContentOnCalendar(draft.id, futureDate()), /approvato/i);
});

test("getPendingApprovals restituisce i DRAFT e non i REJECTED", async () => {
  const draft = await makeDraft("[TEST] pending draft");
  const rejected = await makeDraft("[TEST] pending rejected");
  await rejectContent(rejected.id, "no");

  const pending = await getPendingApprovals();
  const ids = pending.map((c) => c.id);
  assert.equal(ids.includes(draft.id), true, "il DRAFT deve essere in attesa");
  assert.equal(ids.includes(rejected.id), false, "un REJECTED non è in attesa");
  assert.equal(
    pending.some((c) => c.status !== "DRAFT"),
    false,
    "la coda di approvazione contiene solo DRAFT"
  );
});

test("lo stato di approvazione per la UI usa la stessa fonte del publish gate", async () => {
  const c = await makeDraft("[TEST] ui approval truth");
  await approveContent(c.id, "prima approvazione");
  // Tre rifiuti successivi: l'array caricato con take:3 conterrebbe solo
  // REJECTED e la UI dedurrebbe "non approvato" mentre il server direbbe sì.
  for (let i = 0; i < 3; i++) {
    await prisma.approval.create({
      data: { contentId: c.id, decision: "REJECTED", note: `rifiuto ${i}` },
    });
  }

  const state = await getApprovalState(c.id);
  assert.equal(state.hasExplicitApproval, true, "deve coincidere con hasExplicitApproval");
  assert.equal(await hasExplicitApproval(c.id), true);
  assert.equal(state.approvals.length, 4, "lo storico deve essere completo, non troncato");
  assert.equal(
    state.approvals.slice(0, 3).some((a) => a.decision === "APPROVED"),
    false,
    "i 3 più recenti sono tutti REJECTED: è il caso che rompeva la UI"
  );
});

test("nessun tool AI per l'invio in revisione esiste più", async () => {
  assert.equal(getTool("submitForReview"), undefined);
});

test("createContent via tool AI crea DRAFT e non approva automaticamente", async () => {
  const res = await createContentTool.execute({
    title: "[TEST] tool draft",
    caption: "Caption di test",
    platforms: ["INSTAGRAM"],
  });
  assert.equal(res.ok, true);
  const data = res.data as { id: string; status: string };
  assert.equal(data.status, "DRAFT");
  createdIds.push(data.id);
  const content = await getContent(data.id);
  assert.equal(content?.status, "DRAFT");
  assert.equal(await hasExplicitApproval(data.id), false, "l'AI non auto-approva");
});

test("getPendingApprovalsTool elenca i DRAFT", async () => {
  const draft = await makeDraft("[TEST] tool pending");
  const res = await getPendingApprovalsTool.execute({});
  assert.equal(res.ok, true);
  const data = res.data as { id: string; status: string }[];
  assert.equal(
    data.some((c) => c.id === draft.id),
    true
  );
  assert.equal(
    data.every((c) => c.status === "DRAFT"),
    true
  );
});

test("approveContent tool opera da DRAFT e crea l'approvazione", async () => {
  const c = await makeDraft("[TEST] tool approve flow");
  const approved = await approveContentTool.execute({ contentId: c.id, note: "ok" });
  assert.equal(approved.ok, true);
  assert.equal((approved.data as { status: string }).status, "APPROVED");
  assert.equal(await hasExplicitApproval(c.id), true);
  // seconda chiamata: non è più in DRAFT, quindi il tool deve fallire
  const again = await approveContentTool.execute({ contentId: c.id });
  assert.equal(again.ok, false);
});

test("rejectContent tool porta da DRAFT a REJECTED", async () => {
  const c = await makeDraft("[TEST] tool reject flow");
  const res = await rejectContentTool.execute({ contentId: c.id, note: "no" });
  assert.equal(res.ok, true);
  assert.equal((res.data as { status: string }).status, "REJECTED");
});

/* -------------------------------------------------------------------------
 * REVIEW è legacy: presente nell'enum Prisma, irraggiungibile dal workflow.
 * ---------------------------------------------------------------------- */

test("REVIEW non è raggiungibile da nessuno stato del workflow", () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.equal(
      (targets as string[]).includes("REVIEW"),
      false,
      `${from} non deve poter transitare verso REVIEW`
    );
  }
  assert.equal(canTransition("DRAFT", "REVIEW"), false);
  assert.equal(canTransition("APPROVED", "REVIEW"), false);
  assert.equal(canTransition("SCHEDULED", "REVIEW"), false);
  assert.equal(canTransition("REJECTED", "REVIEW"), false);
  assert.equal(canTransition("FAILED", "REVIEW"), false);
  assert.equal(canTransition("REVIEW", "REVIEW"), true, "l'identità resta consentita");
});

test("REVIEW non viene proposto tra gli stati mostrati all'utente", () => {
  assert.equal(STATUS_ORDER.includes("REVIEW"), false);
});

test("l'enum Prisma conserva REVIEW (legacy dormiente, niente rebuild SQLite)", () => {
  const schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  const block = schema.slice(schema.indexOf("enum ContentStatus"));
  const values = block
    .slice(0, block.indexOf("}"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z]+$/.test(l));
  assert.deepEqual(values, [
    "DRAFT",
    "REVIEW",
    "APPROVED",
    "SCHEDULED",
    "PUBLISHED",
    "REJECTED",
    "FAILED",
  ]);
});

test("nessun record applicativo nuovo entra in REVIEW", async () => {
  const draft = await makeDraft("[TEST] legacy no new review");
  await assert.rejects(changeStatus(draft.id, "REVIEW" as never), /Transizione non consentita/i);
  await approveContent(draft.id);
  await assert.rejects(changeStatus(draft.id, "REVIEW" as never), /Transizione non consentita/i);
  const kept = await getContent(draft.id);
  assert.equal(kept?.status, "APPROVED");
  const inReview = await prisma.content.count({ where: { status: "REVIEW" } });
  assert.equal(inReview, 0, "nessun contenuto deve essere finito in REVIEW");
});

test("gli audit storici che contengono REVIEW non vengono toccati", async () => {
  const historical = await prisma.auditLog.findMany({
    where: { action: "CONTENT_STATUS_CHANGED" },
    select: { detail: true },
    take: 5000,
  });
  const withReview = historical.filter((a) => JSON.stringify(a.detail).includes("REVIEW"));
  // Sono dati immutabili: il task non deve averli cancellati. Il test
  // fallisce solo se qualcuno li modifica, non se non ce ne sono.
  for (const a of withReview.slice(0, 5)) {
    assert.ok(JSON.stringify(a.detail).includes("REVIEW"));
  }
});

describe("La paginazione di /contents copre tutto senza buchi né duplicati", () => {
  const PAGE = 3;
  /** Termine univoco: isola questi contenuti dal resto del database. */
  const tag = "[TEST] paging";

  before(async () => {
    for (let i = 0; i < 7; i++) {
      const c = await createContent({
        title: `${tag} ${i}`,
        caption: "Caption di test",
        platforms: ["INSTAGRAM"],
      });
      createdIds.push(c.id);
    }
  });

  test("countContents e listContents applicano lo stesso filtro", async () => {
    const count = await countContents({ search: tag, status: "DRAFT" });
    const all = await listContents({ search: tag, status: "DRAFT", limit: 100 });
    assert.equal(count, 7);
    assert.equal(all.length, count, "conteggio e dataset filtrato devono concordare");
  });

  test("le pagine successive ricostruiscono l'elenco completo, senza ripetizioni", async () => {
    const expected = (await listContents({ search: tag, status: "DRAFT", limit: 100 })).map(
      (c) => c.id
    );
    assert.equal(expected.length, 7);

    const seen: string[] = [];
    const total = await countContents({ search: tag, status: "DRAFT" });
    const totalPages = Math.ceil(total / PAGE);
    for (let p = 0; p < totalPages; p++) {
      const chunk = await listContents({
        search: tag,
        status: "DRAFT",
        limit: PAGE,
        offset: p * PAGE,
      });
      assert.ok(chunk.length <= PAGE, "una pagina non può superare il limite");
      seen.push(...chunk.map((c) => c.id));
    }

    assert.deepEqual(
      [...seen].sort(),
      [...expected].sort(),
      "ogni contenuto deve comparire una e una sola volta su tutte le pagine"
    );
    assert.equal(new Set(seen).size, seen.length, "nessun contenuto può comparire due volte");
  });

  test("un offset oltre la fine restituisce una pagina vuota, non un errore", async () => {
    const empty = await listContents({ search: tag, status: "DRAFT", limit: PAGE, offset: 999 });
    assert.deepEqual(empty, []);
  });

  test("il filtro di ricerca resta applicato a ogni pagina", async () => {
    const chunk = await listContents({ search: "pagina-che-non-esiste", limit: PAGE });
    assert.deepEqual(chunk, [], "la ricerca non deve perdersi con l'offset");
  });
});
