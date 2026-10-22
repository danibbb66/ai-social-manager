#!/usr/bin/env node
/**
 * Anteprima curation foto Pixabay: genera una griglia numerata delle candidate
 * per una destinazione, da far approvare all'utente.
 *
 * Uso:
 *   node scripts/curate-preview.mjs <dest> [query] [perPage] [outFile]
 *
 * - <dest>      nome destinazione (per il nome file e i log)
 * - [query]     query Pixabay (default = <dest>); passala in inglese
 * - [perPage]   quante foto (default 15, max 20)
 * - [outFile]   dove salvare la griglia JPG (default curated-preview/<dest>.jpg)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const dest = (process.argv[2] || "").trim();
const query = (process.argv[3] || dest).trim();
const perPage = Math.max(1, Math.min(parseInt(process.argv[4] || "15", 10) || 15, 20));
const outFile =
  process.argv[5] ||
  path.join(root, "curated-preview", `${dest.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.jpg`);

if (!dest || !query) {
  console.error("uso: node scripts/curate-preview.mjs <dest> [query] [perPage] [outFile]");
  process.exit(1);
}

const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const key = (env.match(/^PIXABAY_API_KEY=(.+)$/m) || [])[1]?.replace(/["']/g, "").trim();
if (!key) {
  console.error("nessuna PIXABAY_API_KEY in .env");
  process.exit(1);
}

const params = new URLSearchParams({
  key,
  q: query,
  image_type: "photo",
  orientation: "vertical",
  order: "popular",
  safesearch: "true",
  per_page: String(perPage),
});
const res = await fetch(`https://pixabay.com/api/?${params.toString()}`);
if (!res.ok) {
  console.error("pixabay", res.status);
  process.exit(1);
}
const json = await res.json();
const hits = (json.hits || []).filter((h) => h.webformatURL);

console.log(`# destinazione: ${dest} | query: ${query} | risultati: ${hits.length}/${json.total}`);

const cols = 3;
const cellW = 360;
const gap = 12;
const pad = 18;

const items = [];
for (let i = 0; i < hits.length; i++) {
  const h = hits[i];
  const buf = Buffer.from(await (await fetch(h.webformatURL)).arrayBuffer());
  const resized = await sharp(buf).resize({ width: cellW, withoutEnlargement: true }).toBuffer();
  const meta = await sharp(resized).metadata();
  items.push({ n: i + 1, id: h.id, buf: resized, w: meta.width, h: meta.height, tags: h.tags });
  console.log(`${i + 1}. id=${h.id} [${h.tags}]`);
}

if (items.length === 0) {
  console.error("nessuna foto trovata");
  process.exit(1);
}

const cellH = Math.max(...items.map((it) => it.h));
const rows = Math.ceil(items.length / cols);
const W = cols * (cellW + gap) - gap + pad * 2;
const H = rows * (cellH + gap) - gap + pad * 2;

const overlays = [];
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const col = i % cols;
  const row = Math.floor(i / cols);
  const left = pad + col * (cellW + gap);
  const top = pad + row * (cellH + gap);
  overlays.push({ input: it.buf, left, top });
  const numSvg = Buffer.from(
    `<svg width="64" height="64"><rect width="64" height="64" rx="8" fill="rgba(0,0,0,0.72)"/><text x="32" y="44" font-size="40" font-family="Arial" font-weight="bold" fill="#ffffff" text-anchor="middle">${it.n}</text></svg>`
  );
  overlays.push({ input: numSvg, left: left + 6, top: top + 6 });
}

await sharp({ create: { width: W, height: H, channels: 3, background: "#111111" } })
  .composite(overlays)
  .jpeg({ quality: 88 })
  .toFile(outFile);

console.log(`# griglia: ${outFile} (${W}x${H})`);
