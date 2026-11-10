import { prisma } from "@/lib/prisma";
import { deleteUploadedFile } from "@/lib/uploads";
import { logAudit } from "@/lib/audit";

/**
 * Pulizia dei reel GENERATI dopo la pubblicazione.
 *
 * Ogni reel prodotto occupa spazio su Cloudflare R2 (montaggio ~10-20 MB +
 * copertina). A pubblicazione avvenuta quei file servono solo come anteprima
 * nell'app: dopo N giorni (default 7) vengono eliminati dal cloud e la riga
 * dell'asset viene rimossa, così lo spazio non si esaurisce col tempo.
 *
 * Cosa NON viene mai toccato:
 *  - i media CURATI (clip/foto delle destinazioni) e gli audio;
 *  - i file caricati a mano dall'utente (nel loro nome non c'è il prefisso
 *    generato "montage-"/"poster-");
 *  - i contenuti non ancora pubblicati su TUTTE le piattaforme (un retry di
 *    Instagram può ancora aver bisogno del video).
 *
 * Il contenuto in sé resta nel database (storico e calendario), sparisce solo
 * il file dal bucket. La pubblicazione sui social non viene toccata.
 */

const RETENTION_DAYS_DEFAULT = 7;

/** Riconosce i file prodotti dal generatore (mai i media dell'utente). */
const GENERATED_VIDEO = /^montage-/;
const GENERATED_POSTER = /^poster-/;

export interface CleanupResult {
  contents: number;
  deletedAssets: number;
  failed: number;
}

export async function cleanupPublishedMedia(
  opts: { retentionDays?: number; dryRun?: boolean } = {}
): Promise<CleanupResult> {
  const rawDays = Number(
    opts.retentionDays ?? process.env.PUBLISHED_MEDIA_RETENTION_DAYS ?? RETENTION_DAYS_DEFAULT
  );
  const retentionDays =
    Number.isFinite(rawDays) && rawDays >= 0 ? Math.floor(rawDays) : RETENTION_DAYS_DEFAULT;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Contenuti PUBBLICATI su tutte le piattaforme, con almeno un asset generato,
  // la cui pubblicazione più recente è più vecchia del limite.
  const candidates = await prisma.content.findMany({
    where: {
      status: "PUBLISHED",
      // Almeno una piattaforma, e TUTTE già pubblicate (niente retry in sospeso).
      platforms: { some: {}, every: { publishedAt: { not: null } } },
      assets: {
        some: { kind: "VIDEO" },
      },
    },
    select: {
      id: true,
      assets: { select: { id: true, url: true, filename: true, kind: true } },
      platforms: { select: { publishedAt: true } },
    },
  });

  const expired = candidates.filter((c) => {
    const latest = c.platforms.reduce<Date | null>((acc, p) => {
      if (!p.publishedAt) return acc;
      return !acc || p.publishedAt > acc ? p.publishedAt : acc;
    }, null);
    if (!latest || latest > cutoff) return false;
    // Almeno un file generato ancora presente su questo contenuto.
    return c.assets.some(
      (a) =>
        (a.kind === "VIDEO" && GENERATED_VIDEO.test(a.filename)) ||
        (a.kind === "IMAGE" && GENERATED_POSTER.test(a.filename))
    );
  });

  const result: CleanupResult = { contents: 0, deletedAssets: 0, failed: 0 };

  for (const content of expired) {
    const generated = content.assets.filter(
      (a) =>
        (a.kind === "VIDEO" && GENERATED_VIDEO.test(a.filename)) ||
        (a.kind === "IMAGE" && GENERATED_POSTER.test(a.filename))
    );
    if (generated.length === 0) continue;

    if (opts.dryRun) {
      result.contents += 1;
      result.deletedAssets += generated.length;
      continue;
    }

    let deletedHere = 0;
    for (const asset of generated) {
      try {
        // Prima il file nel bucket, poi la riga: un errore sul file non deve
        // far perdere la traccia dell'asset.
        await deleteUploadedFile(asset.url).catch(() => {});
        await prisma.contentAsset.delete({ where: { id: asset.id } });
        deletedHere += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (deletedHere > 0) {
      result.contents += 1;
      result.deletedAssets += deletedHere;
      await logAudit("CONTENT_MEDIA_CLEANED", "Content", content.id, {
        assets: deletedHere,
        retentionDays,
      }).catch(() => {});
    }
  }

  return result;
}
