const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const brandCount = await prisma.brand.count();
  if (brandCount === 0) {
    await prisma.brand.create({
      data: {
        name: "La Mia Agenzia di Viaggi",
        description:
          "Agenzia di viaggi specializzata in vacanze mare, isole e itinerari in Italia e Grecia. Sosteniamo viaggi autentici e sostenibili.",
        website: "https://example-travel.travel",
        instagram: "@lamiaagenzia viaggi",
        facebook: "lamiaagenziaviaggi",
        tiktok: "@lamiaagenziaviaggi",
        tone: "Caldo, entusiasta e informativo. Esposizione in italiano con tono amichevole.",
        audience: "Coppie e famiglie tra i 25 e i 55 anni che cercano vacanze al mare e isole.",
        style: "Fotografie vibranti, testi brevi, use emoji con moderazione.",
        preferredTopics: ["Sardegna", "Grecia", "isole", "spiagge", "itinerari di una settimana"],
        forbiddenTopics: ["Promesse di sconti non verificabili", "contenuti politici"],
        forbiddenWords: ["regalo", "vinci subito", "sfondo gratis"],
        preferredCtas: ["Prenota ora", "Scopri di più", "Contattaci via DM", "Chiedi un preventivo gratuito"],
        colors: { primary: "#0ea5e9", secondary: "#0284c7", accent: "#f97316" },
        fonts: { heading: "Inter", body: "Inter" },
      },
    });
    console.log("Brand di default creato.");
  } else {
    console.log("Brand già presente, salto la creazione.");
  }

  const accounts = [
    { platform: "INSTAGRAM", name: "Instagram aziendale", handle: "@lamiaagenziaviaggi", note: "Richiede Instagram Graph API (token + Business Account ID)" },
    { platform: "FACEBOOK", name: "Pagina aziendale", handle: "lamiaagenziaviaggi", note: "Richiede Facebook Graph API (Page Access Token + Page ID)" },
    { platform: "TIKTOK", name: "Profilo TikTok", handle: "@lamiaagenziaviaggi", note: "Richiede TikTok Content Posting API (Access Token + Open ID)" },
  ];

  for (const a of accounts) {
    const exists = await prisma.socialAccount.findUnique({
      where: { platform_name: { platform: a.platform, name: a.name } },
    });
    if (!exists) {
      await prisma.socialAccount.create({ data: a });
      console.log(`Account ${a.name} creato (non configurato).`);
    }
  }

  const convCount = await prisma.chatConversation.count();
  if (convCount === 0) {
    await prisma.chatConversation.create({
      data: {
        title: "Prima conversazione",
        messages: {
          create: {
            role: "ASSISTANT",
            content:
              "Ciao! Sono l'assistente AI della tua agenzia. Posso preparare post, carousel, hashtag, immagini e gestire il calendario social. Scrivi ad esempio: \"Preparami tre post sulle vacanze in Grecia\".",
          },
        },
      },
    });
    console.log("Conversazione iniziale creata.");
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });