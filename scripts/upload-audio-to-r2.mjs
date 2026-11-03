// Carica public/audio/** su Cloudflare R2 con chiave "audio/<nomefile>".
// Idempotente: salta i file già presenti nel bucket, così quando aggiungi
// nuove canzoni in public/audio basta rilanciare questo script.
// Con --sync elimina dal bucket le tracce audio/ non più presenti in locale.
//
// Uso:
//   node scripts/upload-audio-to-r2.mjs          (carica solo le nuove)
//   node scripts/upload-audio-to-r2.mjs --sync   (carica + elimina le rimosse)
//   node scripts/upload-audio-to-r2.mjs --dry-run [--sync]
//
// Legge i parametri R2 da .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const ROOT = process.cwd();
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const DRY_RUN = process.argv.includes("--dry-run");
const SYNC = process.argv.includes("--sync");

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

/** Elenca tutte le chiavi audio/ attualmente nel bucket. */
async function listRemoteKeys() {
  const keys = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "audio/",
        ContinuationToken: token,
      })
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
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

  let removed = 0;
  if (SYNC) {
    const localKeys = new Set(files.map((f) => `audio/${path.basename(f)}`));
    const remote = await listRemoteKeys();
    for (const key of remote) {
      if (localKeys.has(key)) continue;
      if (DRY_RUN) {
        console.log(`[dry-run] eliminerei: ${key}`);
        continue;
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      removed += 1;
      console.log(`Eliminato dal bucket: ${key}`);
    }
  }

  console.log(
    DRY_RUN
      ? `Dry-run: ${files.length} tracce trovate.`
      : `Fatto: ${uploaded} caricate, ${skipped} già presenti${SYNC ? `, ${removed} eliminate` : ""}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
