import type { ContentStatus, Platform } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getContentOrThrow } from "@/lib/services/content";
import { hasExplicitApproval } from "@/lib/services/approvals";
import { getSocialProvider } from "@/lib/social/factory";
import { redactSecrets } from "@/lib/security";

/**
 * Pubblica un contenuto tramite le API ufficiali della piattaforma.
 *
 * REGOLA FONDAMENTALE: la pubblicazione è possibile SOLO se:
 *  1. il contenuto ha ricevuto un'approvazione ESPLICITA (record Approval APPROVED);
 *  2. l'account della piattaforma è configurato con credenziali reali in .env;
 *  3. viene richiesta una conferma ESPLICITA (opzioni.confirm === true).
 * Senza queste condizioni la pubblicazione NON viene nemmeno tentata.
 *
 * @param options.confirm  Conferma esplicita richiesta. La pubblicazione viene rifiutata se non è `true`.
 */
export async function publishContent(
  contentId: string,
  platform?: string,
  options?: { confirm?: boolean }
): Promise<{ ok: boolean; message: string; jobId: string }> {
  const content = await getContentOrThrow(contentId);

  if (!["APPROVED", "SCHEDULED"].includes(content.status)) {
    throw new Error(
      `Il contenuto è in stato "${content.status}". Per pubblicarlo deve essere approvato (o programmato).`
    );
  }

  const approved = await hasExplicitApproval(contentId);
  if (!approved) {
    throw new Error(
      "Pubblicazione rifiutata: il contenuto non ha un'approvazione esplicita precedente."
    );
  }

  if (options?.confirm !== true) {
    throw new Error(
      "Pubblicazione rifiutata: richiesta la conferma esplicita (confirm=true)."
    );
  }

  const targets =
    platform && platform !== "ALL"
      ? content.platforms.filter((p) => p.platform === platform)
      : content.platforms;

  if (targets.length === 0 && platform !== "FACEBOOK") {
    throw new Error(
      `Nessuna piattaforma selezionata per la pubblicazione. Aggiungi le piattaforme al contenuto.`
    );
  }

  if (targets.length === 0 && platform === "FACEBOOK") {
    targets.push({ platform } as (typeof content.platforms)[number]);
  }

  if (!content.caption) {
    throw new Error("Il contenuto non ha un testo (caption) da pubblicare.");
  }

  const job = await prisma.aIJob.create({
    data: {
      kind: "PUBLISH",
      status: "PENDING",
      contentId,
      input: {
        platforms: targets.map((t) => t.platform),
      },
    },
  });

  await logAudit("PUBLISH_REQUESTED", "Content", contentId, {
    platforms: targets.map((t) => t.platform),
    jobId: job.id,
  });

  const results: { platform: string; ok: boolean; message: string; externalId?: string }[] = [];

  const videoAsset = content.assets.find((a) => a.kind === "VIDEO");
  const payloadInput = {
    contentType: content.type,
    caption: content.caption,
    hashtags: content.hashtags,
    mediaUrls: content.assets
      .filter((a) => a.kind !== "VIDEO")
      .map((a) => a.url)
      .slice(0, 10),
    videoUrl: videoAsset ? videoAsset.url : content.assets[0]?.url ?? null,
  };

  for (const target of targets) {
    try {
      const provider = getSocialProvider(target.platform);
      const res = await provider.publish(payloadInput, content);
      results.push({
        platform: target.platform,
        ok: res.ok,
        message: redactSecrets(res.message),
        externalId: res.externalId,
      });
      await prisma.contentPlatform.updateMany({
        where: { contentId, platform: target.platform },
        data: {
          externalId: res.ok ? res.externalId ?? null : null,
          publishedAt: res.ok ? new Date() : null,
          error: res.ok ? null : redactSecrets(res.message),
        },
      });
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      results.push({ platform: target.platform, ok: false, message });
      await prisma.contentPlatform.updateMany({
        where: { contentId, platform: target.platform },
        data: {
          externalId: null,
          publishedAt: null,
          error: message,
        },
      });
    }
  }

  const allOk = results.every((r) => r.ok);
  const resultsSummary = results
    .map((r) => `${r.platform}: ${r.ok ? "ok" : r.message}`)
    .join(" | ");

  if (allOk) {
    await prisma.$transaction([
      prisma.aIJob.update({
        where: { id: job.id },
        data: { status: "SUCCESS", output: { results } },
      }),
      prisma.content.update({
        where: { id: contentId },
        data: { status: "PUBLISHED" },
      }),
    ]);
    await logAudit("CONTENT_PUBLISHED", "Content", contentId, {
      platforms: targets.map((t) => t.platform),
      results,
    });
    return {
      ok: true,
      message: `Pubblicato con successo su ${targets.length} piattaforma/e.`,
      jobId: job.id,
    };
  }

  // Pubblicazione fallita: lo stato FAILED conserva le informazioni sull'errore (pulite dai token).
  await prisma.$transaction([
    prisma.aIJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        output: { results },
        error: resultsSummary,
      },
    }),
    prisma.content.update({
      where: { id: contentId },
      data: { status: "FAILED" },
    }),
  ]);
  await logAudit("CONTENT_PUBLISH_FAILED", "Content", contentId, {
    results,
  });

  return {
    ok: false,
    message: `Pubblicazione fallita: ${resultsSummary}`,
    jobId: job.id,
  };
}

export interface UnpublishResult {
  ok: boolean;
  /** `false` quando non c'era una pubblicazione attiva: nessuna riga scritta. */
  changed: boolean;
  contentId: string;
  platform: Platform;
  /** L'id del post rimosso, conservato per l'audit. */
  removedExternalId: string | null;
  status: ContentStatus;
  message: string;
}

/**
 * Riallinea il DB a una pubblicazione social cancellata FUORI dall'app.
 *
 * Il post è davvero uscito (ne resta il job `PUBLISH SUCCESS` con il suo
 * `externalId`), ma è stato rimosso a mano su Instagram o Facebook: da quel
 * momento il DB racconterebbe una pubblicazione che non esiste più.
 *
 * Cosa fa, e cosa NON fa per principio:
 *   - azzera `externalId` e `publishedAt` SOLO sulla piattaforma indicata:
 *     le altre piattaforme del contenuto restano intatte;
 *   - NON cancella l'`AIJob` del publish: quello storico è la prova che il post
 *     è uscito, e deve restare consultabile;
 *   - NON crea una nuova `Approval`. Se il contenuto torna `APPROVED` è perché
 *     l'approvazione esistente è ancora valida, non perché ne sia nata una
 *     nuova: per questo il passaggio non passa da DRAFT e non aggira il divieto
 *     di `changeStatus` sull'ingresso in APPROVED;
 *   - NON chiama le API di Meta. La rimozione è già avvenuta, questo servizio
 *     si limita a riallineare lo stato locale.
 *
 * Idempotente: senza `externalId` non c'è una pubblicazione attiva da togliere,
 * quindi non scrive nulla e non genera un secondo evento di rimozione.
 *
 * @param reason Motivo della rimozione. Va nell'audit: senza un motivo
 *   verificabile il riallineamento non è controllabile.
 */
export async function unpublishContent(
  contentId: string,
  platform: Platform,
  reason: string
): Promise<UnpublishResult> {
  const content = await getContentOrThrow(contentId);

  const target = content.platforms.find((p) => p.platform === platform);
  if (!target) {
    throw new Error(
      `Il contenuto ${contentId} non ha la piattaforma ${platform}: non c'è una pubblicazione da rimuovere.`
    );
  }

  const rawReason = typeof reason === "string" ? reason.trim() : "";
  const cleanReason = redactSecrets(rawReason);
  if (!cleanReason) {
    throw new Error(
      "Indica il motivo della rimozione (reason): senza motivo l'audit non è verificabile."
    );
  }

  if (target.externalId === null) {
    return {
      ok: true,
      changed: false,
      contentId,
      platform,
      removedExternalId: null,
      status: content.status,
      message: `Nessuna pubblicazione attiva su ${platform}: nessuna modifica eseguita.`,
    };
  }

  const removedExternalId = target.externalId;

  const nextStatus = await prisma.$transaction(
    async (tx) => {
      await tx.contentPlatform.update({
        where: { contentId_platform: { contentId, platform } },
        data: { externalId: null, publishedAt: null },
      });

      // Un contenuto è "pubblicato" se almeno una piattaforma conserva un
      // riferimento a un post realmente uscito. Se non ne resta nessuna, torna
      // APPROVED, che è lo stato che l'approvazione già valida copre.
      const remaining = await tx.contentPlatform.findMany({
        where: { contentId },
        select: { externalId: true, publishedAt: true },
      });
      const stillLive = remaining.some(
        (p) => p.externalId !== null || p.publishedAt !== null
      );

      let status: ContentStatus = content.status;
      if (!stillLive && content.status === "PUBLISHED") {
        // Stessa regola del gate di pubblicazione: serve l'Approval APPROVED
        // reale. Si interroga qui, e non con `hasExplicitApproval` (che usa la
        // connessione globale), perché il controllo deve stare nella stessa
        // transazione dello stato che protegge. Senza approvazione esplicita il
        // contenuto resta com'era: non si promuove a APPROVED nessuno.
        const explicitApprovals = await tx.approval.count({
          where: { contentId, decision: "APPROVED" },
        });
        if (explicitApprovals > 0) status = "APPROVED";
      }

      if (status !== content.status) {
        await tx.content.update({ where: { id: contentId }, data: { status } });
      }
      return status;
    },
    { timeout: 15_000 }
  );

  await logAudit("CONTENT_UNPUBLISHED", "Content", contentId, {
    platform,
    removedExternalId,
    reason: cleanReason,
  });

  return {
    ok: true,
    changed: true,
    contentId,
    platform,
    removedExternalId,
    status: nextStatus,
    message: `Rimossa la pubblicazione su ${platform} (${removedExternalId}). Stato del contenuto: ${nextStatus}.`,
  };
}