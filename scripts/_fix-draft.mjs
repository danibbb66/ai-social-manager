import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();
const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const prisma = new PrismaClient();

const orphans = await prisma.contentAsset.findMany({
  where: { contentId: null, kind: "IMAGE" },
  orderBy: { createdAt: "desc" },
  take: 5,
});
console.log("Asset senza contenuto:", orphans.map((a) => a.filename));

for (const a of orphans) {
  // Salta i file "magnific"/loghi: crea bozza solo per i media caricati a mano.
  if (/magnific|logo/i.test(a.filename)) continue;
  const title = a.filename.replace(/\.[^.]+$/, "");
  const content = await prisma.content.create({
    data: {
      type: "POST",
      title,
      platforms: {
        create: [
          { platform: "INSTAGRAM", accountId: null },
          { platform: "FACEBOOK", accountId: null },
        ],
      },
    },
  });
  await prisma.contentAsset.update({
    where: { id: a.id },
    data: { contentId: content.id },
  });
  console.log(`Bozza creata: "${title}" (${content.id}) con asset ${a.filename}`);
}

await prisma.$disconnect();
