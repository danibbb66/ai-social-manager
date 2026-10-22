// Carica public/curated/** su Cloudflare R2 con le stesse chiavi relative a
// public/ (es. "curated/photos/bali/x.jpg"). Idempotente: salta i file già
// presenti nel bucket (stessa chiave), così può essere rilanciato in sicurezza.
//
// Uso:
//   node scripts/upload-curated-to-r2.mjs
//   node scripts/upload-curated-to-r2.mjs --dry-run
//
// Legge i parametri R2 da .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME). Non usa USE_CLOUD_STORAGE: questo
// script carica SEMPRE su R2, indipendentemente dalla modalità dell'app.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const ROOT = process.cwd();
const CURATED_DIR = path.join(ROOT, "public", "curated");
const DRY_RUN = process.argv.includes("--dry-run");

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
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

async function walk(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const files = await walk(CURATED_DIR);
  let uploaded = 0;
  let skipped = 0;
  let bytes = 0;

  for (const full of files) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/"); // es. public/curated/...
    const key = rel.replace(/^public\//, ""); // es. curated/photos/bali/x.jpg
    const ext = path.extname(full).toLowerCase();
    const contentType = CONTENT_TYPES[ext];

    if (DRY_RUN) {
      console.log(`[dry-run] ${key} (${contentType ?? "skip: estensione ignota"})`);
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
    bytes += body.length;
    uploaded += 1;
    console.log(`[ok] ${key}`);
  }

  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log(
    `\nFatto. Caricati ${uploaded}, saltati (già presenti) ${skipped}, totale ${files.length} file.${
      DRY_RUN ? " (dry-run, nessun upload)" : ` Dimensione caricata ~${mb} MB.`
    }`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
