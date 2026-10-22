import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Readable } from "node:stream";

/**
 * Livello di archiviazione dei media.
 *
 * Opera in due modalità:
 *  - locale (default): i file vivono in `public/` come sempre, sul disco;
 *  - cloud (R2): i file vivono nel bucket Cloudflare R2, attivo quando
 *    `USE_CLOUD_STORAGE=true` (impostato in produzione su Vercel).
 *
 * Le "chiavi" sono percorsi relativi alla radice `public/`, es.:
 *   - `uploads/images/logo.png`
 *   - `curated/photos/bali/x.jpg`
 *   - `audio/soundtrack.m4a`
 *
 * Questa convenzione rende la migrazione 1:1: la stessa chiave in locale punta
 * a `<root>/public/<key>`, in cloud punta all'oggetto `<key>` nel bucket.
 */

const r2AccountId = process.env.R2_ACCOUNT_ID?.trim();
const r2AccessKey = process.env.R2_ACCESS_KEY_ID?.trim();
const r2Secret = process.env.R2_SECRET_ACCESS_KEY?.trim();
const r2Bucket = process.env.R2_BUCKET_NAME?.trim();
const r2PublicUrl = (process.env.R2_PUBLIC_URL?.trim() ?? "").replace(/\/+$/, "");

const useCloud = process.env.USE_CLOUD_STORAGE === "true";

/** La radice locale di `public/` (usata solo in modalità locale). */
const PUBLIC_DIR = path.join(process.cwd(), "public");

export function isCloudStorage(): boolean {
  return (
    useCloud &&
    Boolean(r2AccountId && r2AccessKey && r2Secret && r2Bucket && r2PublicUrl)
  );
}

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2AccessKey!, secretAccessKey: r2Secret! },
    });
  }
  return client;
}

/**
 * Converte un riferimento (URL pubblico R2, URL locale `/...` o percorso
 * assoluto locale) nella chiave di archiviazione relativa a `public/`.
 */
export function toKey(ref: string): string {
  const n = ref.replace(/\\/g, "/");
  if (r2PublicUrl && n.startsWith(r2PublicUrl + "/")) {
    return n.slice(r2PublicUrl.length + 1);
  }
  if (n.startsWith("/")) {
    return n.replace(/^\/+/, "");
  }
  const pub = PUBLIC_DIR.replace(/\\/g, "/");
  if (n.toLowerCase().startsWith(pub.toLowerCase() + "/")) {
    return n.slice(pub.length + 1);
  }
  return n;
}

/** URL pubblico per un riferimento (pubblico R2, oppure `/key` in locale). */
export function publicUrlFor(ref: string): string {
  const key = toKey(ref);
  if (isCloudStorage()) return `${r2PublicUrl}/${key}`;
  return `/${key}`;
}

/** Percorso locale assoluto per una chiave (solo modalità locale). */
function localPathForKey(key: string): string {
  return path.join(PUBLIC_DIR, key);
}

/** Scrive un buffer e restituisce l'URL pubblico risultante. */
export async function writeFile(
  key: string,
  body: Buffer,
  contentType?: string
): Promise<string> {
  const k = toKey(key);
  if (isCloudStorage()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: r2Bucket!,
        Key: k,
        Body: body,
        ContentType: contentType,
      })
    );
    return `${r2PublicUrl}/${k}`;
  }
  const abs = localPathForKey(k);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return `/${k}`;
}

/** Legge il contenuto di un file (da R2 o dal disco locale). */
export async function readFileBuffer(ref: string): Promise<Buffer> {
  const k = toKey(ref);
  if (isCloudStorage()) {
    const res = await s3().send(new GetObjectCommand({ Bucket: r2Bucket!, Key: k }));
    return streamToBuffer(res.Body as Readable);
  }
  return fs.readFile(localPathForKey(k));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Elimina un file; true se ha avuto effetto, false se non esisteva. */
export async function deleteFile(ref: string): Promise<boolean> {
  const k = toKey(ref);
  if (isCloudStorage()) {
    await s3().send(new DeleteObjectCommand({ Bucket: r2Bucket!, Key: k }));
    return true;
  }
  try {
    await fs.unlink(localPathForKey(k));
    return true;
  } catch {
    return false;
  }
}

/** Il file esiste? */
export async function fileExists(ref: string): Promise<boolean> {
  const k = toKey(ref);
  if (isCloudStorage()) {
    try {
      await s3().send(new HeadObjectCommand({ Bucket: r2Bucket!, Key: k }));
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(localPathForKey(k));
    return true;
  } catch {
    return false;
  }
}

/** Elenca le chiavi (non le directory) sotto un prefisso, in ordine. */
export async function listKeys(prefix: string): Promise<string[]> {
  const p = toKey(prefix).replace(/\/+$/, "");
  if (isCloudStorage()) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await s3().send(
        new ListObjectsV2Command({
          Bucket: r2Bucket!,
          Prefix: p ? p + "/" : undefined,
          ContinuationToken: token,
        })
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) keys.push(o.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }
  const dir = localPathForKey(p);
  return (await listLocalFiles(dir)).map((abs) => toKey(abs)).sort();
}

async function listLocalFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await listLocalFiles(full)));
      else out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Rende un file disponibile sul filesystem locale (scaricandolo da R2 se
 * serve) e restituisce un percorso assoluto locale. Necessario per ffmpeg,
 * che opera su file reali, non su buffer/URL.
 */
export async function materialize(ref: string): Promise<string> {
  // Un percorso già assoluto che esiste su disco (es. file committati in
  // `public/audio/` presenti anche sul filesystem di Vercel) si usa così com'è:
  // non va tradotto in chiave né ri-scaricato da R2.
  if (path.isAbsolute(ref)) {
    try {
      await fs.access(ref);
      return ref;
    } catch {
      // il riferimento non è un file locale leggibile: si prosegue come ref
    }
  }
  const k = toKey(ref);
  if (isCloudStorage()) {
    const tmp = path.join(
      os.tmpdir(),
      "asm-media",
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(k)}`
    );
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    await fs.writeFile(tmp, await readFileBuffer(k));
    return tmp;
  }
  return localPathForKey(k);
}

/**
 * Directory di output per i file generati (montaggi video, titoli, ecc.).
 *
 * In locale è `<root>/public/<sub>`; in cloud è una cartella temporanea
 * (`/tmp/asm-output/<sub>`), perché il filesystem di Vercel (`/var/task`) è
 * in sola lettura e non è condiviso tra le invocations.
 */
export function outputDirFor(sub: string): string {
  if (isCloudStorage()) {
    return path.join(os.tmpdir(), "asm-output", sub);
  }
  return path.join(PUBLIC_DIR, sub);
}

/**
 * Pubblica un file appena generato nello storage (R2 o `public/`) e ne
 * restituisce l'URL pubblico. In cloud il file viene caricato su R2 e poi
 * rimosso dal disco temporaneo; in locale resta dov'è e si restituisce `/key`.
 */
export async function publishOutput(
  localPath: string,
  key: string,
  contentType?: string
): Promise<string> {
  if (!isCloudStorage()) {
    return `/${toKey(key)}`;
  }
  const body = await fs.readFile(localPath);
  const url = await writeFile(key, body, contentType);
  await fs.unlink(localPath).catch(() => undefined);
  return url;
}
