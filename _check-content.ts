import { prisma } from "./src/lib/prisma";

async function main() {
  const c = await prisma.content.findUnique({
    where: { id: "cmumw93gd0002kia4drboassl" },
    include: {
      assets: true,
      platforms: true,
      approvals: true,
    },
  });

  console.log(JSON.stringify(c, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
