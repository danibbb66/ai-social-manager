const { PrismaClient } = require("@prisma/client");

/**
 * Correzione dati per gli asset caricati PRIMA dell'introduzione della
 * classificazione automatica: i video venivano registrati con kind = IMAGE
 * perché la route non passava il campo kind.
 *
 * Criterio di selezione, volutamente restrittivo:
 *   kind = 'IMAGE' AND mimeType che identifica un video
 *
 * Non vengono toccati immagini, audio, documenti o asset di qualsiasi altro
 * tipo. L'unica colonna aggiornata e' `kind`: nessun file fisico, nessun URL,
 * nessuna associazione a contenuti, nessuno stato di workflow, approvazione o
 * pubblicazione viene toccato. ContentAsset non ha updatedAt, quindi un UPDATE
 * non altera alcun altro dato della riga.
 *
 * Lo script e' idempotente: rieseguendolo non trova piu' candidati.
 *
 * Uso:
 *   node prisma/fix-asset-kind.js --dry-run   (solo conteggio, nessuna scrittura)
 *   node prisma/fix-asset-kind.js
 */

/**
 * Costante, nessun input utente: unica fonte di verita' usata sia per
 * individuare i candidati sia per l'UPDATE, cosi' il conteggio del dry-run e
 * quello dell'esecuzione non possono divergere.
 */
const TARGET_SQL = "kind = 'IMAGE' AND LOWER(mimeType) LIKE 'video/%'";

/** Elenco dei soli asset da correggere (sola lettura). */
async function findMisclassifiedVideoAssets(client) {
  return client.$queryRawUnsafe(
    `SELECT id, filename, mimeType, url, contentId
       FROM ContentAsset
      WHERE ${TARGET_SQL}
      ORDER BY createdAt`
  );
}

/**
 * Corregge kind IMAGE -> VIDEO per i soli asset video mal classificati.
 * Con dryRun=true non scrive nulla e restituisce comunque i candidati.
 */
async function fixMisclassifiedVideoAssets(client, options) {
  const dryRun = Boolean(options && options.dryRun);
  const candidates = await findMisclassifiedVideoAssets(client);

  if (candidates.length === 0) {
    return { candidates: 0, fixed: 0, dryRun, rows: [] };
  }

  if (dryRun) {
    return { candidates: candidates.length, fixed: 0, dryRun, rows: candidates };
  }

  const affected = await client.$executeRawUnsafe(
    `UPDATE ContentAsset SET kind = 'VIDEO' WHERE ${TARGET_SQL}`
  );

  return { candidates: candidates.length, fixed: affected, dryRun, rows: candidates };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await fixMisclassifiedVideoAssets(prisma, { dryRun });

  if (result.candidates === 0) {
    console.log("Nessun asset da correggere: nessun video risulta classificato come IMAGE.");
  } else if (dryRun) {
    console.log(`[dry-run] ${result.candidates} asset video da correggere (kind IMAGE -> VIDEO):`);
    for (const row of result.rows) {
      console.log(`  - ${row.id}  ${row.mimeType}  ${row.filename}  ${row.url}`);
    }
    console.log("Nessuna scrittura eseguita. Rilancia senza --dry-run per applicare.");
  } else {
    console.log(`Corretti ${result.fixed} asset: kind IMAGE -> VIDEO (mimeType video/*).`);
    for (const row of result.rows) {
      console.log(`  - ${row.id}  ${row.mimeType}  ${row.filename}  ${row.url}`);
    }
  }

  const remaining = await findMisclassifiedVideoAssets(prisma);
  console.log(
    dryRun
      ? `Verifica: ${remaining.length} asset incoerenti presenti (correzione non applicata).`
      : `Verifica: ${remaining.length} asset incoerenti rimasti.`
  );

  return result;
}

const prisma = new PrismaClient();

module.exports = {
  TARGET_SQL,
  findMisclassifiedVideoAssets,
  fixMisclassifiedVideoAssets,
};

if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error(e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
