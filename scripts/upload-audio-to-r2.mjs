// Carica public/audio/** su Cloudflare R2 con chiave "audio/<nomefile>".
// Idempotente: salta i file già presenti nel bucket, così quando aggiungi
// nuove canzoni in public/audio basta rilanciare questo script.
//
// Uso:
//   node scripts/upload-audio-to-r2.mjs
//   node scripts/upload-audio-to-r2.mjs --dry-run
//
// Legge i parametri R2 da .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const ROOT = process.cwd();
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const DRY_RUN = process.argv.includes("--dry-run");

const CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

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
const accountId = env.R2_ACCOUNT_ID?.trim();
const accessKey = env.R2_ACCESS_KEY_ID?.trim();
const secretKey = env.R2_SECRET_ACCESS_KEY?.trim();
const bucket = env.R2_BUCKET_NAME?.trim();

if (!accountId || !accessKey || !secretKey || !bucket) {
  console.error(
    "Mancano i parametri R2 in .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME."
  );
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const entries = await fsp.readdir(AUDIO_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && CONTENT_TYPES[path.extname(e.name).toLowerCase()])
    .map((e) => path.join(AUDIO_DIR, e.name));

  if (files.length === 0) {
    console.log("Nessun file audio in public/audio.");
    return;
  }

  let uploaded = 0;
  let skipped = 0;

  for (const full of files) {
    const key = `audio/${path.basename(full)}`;
    const contentType = CONTENT_TYPES[path.extname(full).toLowerCase()];

    if (DRY_RUN) {
      console.log(`[dry-run] ${key} (${contentType})`);
      continue;
    }

    if (await exists(key)) {
      skipped += 1;
      continue;
    }

    const body = await fsp.readFile(full);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
    uploaded += 1;
    console.log(`Caricato: ${key} (${(body.length / 1024).toFixed(0)} KB)`);
  }

  console.log(
    DRY_RUN
      ? `Dry-run: ${files.length} tracce trovate.`
      : `Fatto: ${uploaded} caricate, ${skipped} già presenti.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
