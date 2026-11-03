// Configura il CORS del bucket R2 per l'upload DIRETTO dal browser.
//
// Senza questa configurazione il browser blocca il PUT verso
// <account>.r2.cloudflarestorage.com con un errore CORS e i file grandi non
// si caricano. Da eseguire UNA VOLTA (o quando cambiano le regole volute).
//
// AllowedOrigins "*": sicuro in questo contesto perché il PUT richiede
// SEMPRE un URL pre-firmato valido (rilasciato dal server, scade in 10
// minuti); il GET è già pubblico tramite il dominio r2.dev del bucket.
//
// Uso:
//   node scripts/setup-r2-cors.mjs

import fs from "node:fs";
import path from "node:path";
import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

const ROOT = process.cwd();

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
    // .env assente
  }
  return out;
}

const env = loadEnv();
const accountId = env.R2_ACCOUNT_ID?.trim();
const accessKey = env.R2_ACCESS_KEY_ID?.trim();
const secretKey = env.R2_SECRET_ACCESS_KEY?.trim();
const bucket = env.R2_BUCKET_NAME?.trim();

if (!accountId || !accessKey || !secretKey || !bucket) {
  console.error("Mancano i parametri R2 in .env.");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

await client.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ["*"],
          AllowedMethods: ["GET", "PUT", "HEAD"],
          AllowedHeaders: ["*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  })
);

console.log(`CORS configurato sul bucket "${bucket}": upload diretto dal browser abilitato.`);
