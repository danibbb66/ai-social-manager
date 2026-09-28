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