// Test: genera un URL pre-firmato come fa l'app e prova un PUT reale su R2.
import fs from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ROOT = process.cwd();
const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const env = { ...process.env };
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
});

const key = `uploads/images/_test-presign-${Date.now()}.txt`;
const uploadUrl = await getSignedUrl(
  client,
  new PutObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key, ContentType: "text/plain" }),
  { expiresIn: 600 }
);
console.log("URL firmato (primi 120 char):", uploadUrl.slice(0, 120));

// PUT come farebbe il browser (senza header extra)
const put = await fetch(uploadUrl, {
  method: "PUT",
  body: Buffer.from("test presign ok"),
  headers: { "Content-Type": "text/plain" },
});
console.log("PUT status:", put.status, put.statusText);
if (!put.ok) console.log("PUT body:", (await put.text()).slice(0, 500));

// Verifica + pulizia
if (put.ok) {
  const head = await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  console.log("HEAD ok, size:", head.ContentLength);
  await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  console.log("Pulizia fatta. TUTTO OK");
}
