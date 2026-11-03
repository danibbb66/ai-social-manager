// Reset dei contenuti di TEST: elimina TUTTI i contenuti (bozze, approvati,
// programmati) e i job AI collegati, così i media curati (foto/video) tornano
// riutilizzabili per la pubblicazione vera.
//
// Il tracciamento "media già usati" deriva dagli asset collegati ai contenuti:
// eliminando i contenuti, le clip e le foto curate risultano di nuovo libere.
// I file su R2 (uploads/videos, uploads/images) diventano orfani ma innocui:
// non influenzano la generazione.
//
// NON tocca: Brand, account social, idee, catalogo, media library scollegata.
//
// Uso:
//   node scripts/reset-test-contents.mjs --dry-run   (solo conteggio)
//   node scripts/reset-test-contents.mjs --yes       (esegue davvero)

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes");

function loadEnv() {
  const out = { ...process.env };
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(m[1] in out)) out[m[1]] = val;
    }
  } catch {
    // .env assente: si usano solo le variabili già presenti nell'ambiente
  }
  return out;
}

const env = loadEnv();
if (!process.env.DATABASE_URL && env.DATABASE_URL) {
  process.env.DATABASE_URL = env.DATABASE_URL;
}

if (!DRY_RUN && !YES) {
  console.error(
    "Operazione distruttiva: rilancia con --yes per confermare, oppure --dry-run per il solo conteggio."
  );
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const [contents, assets, platforms, approvals, jobs] = await Promise.all([
    prisma.content.count(),
    prisma.contentAsset.count(),
    prisma.contentPlatform.count(),
    prisma.approval.count(),
    prisma.aIJob.count(),
  ]);
  console.log("Stato PRIMA:");
  console.log(
    `  Contenuti: ${contents} | Asset: ${assets} | Piattaforme: ${platforms} | Approvazioni: ${approvals} | AIJob: ${jobs}`
  );

  if (DRY_RUN) {
    console.log("\n(dry-run) Nessuna modifica eseguita.");
    return;
  }

  // Ordine: prima gli AIJob (FK verso Content senza cascade), poi i contenuti
  // (che eliminano in cascata asset, piattaforme, slide e approvazioni).
  const delJobs = await prisma.aIJob.deleteMany({});
  const delContents = await prisma.content.deleteMany({});

  console.log("\nReset completato:");
  console.log(`  AIJob eliminati: ${delJobs.count}`);
  console.log(`  Contenuti eliminati: ${delContents.count} (con asset, piattaforme, slide, approvazioni in cascata)`);

  const after = await prisma.content.count();
  console.log(`  Contenuti rimasti: ${after}`);
}

main()
  .catch((e) => {
    console.error("Reset fallito:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
