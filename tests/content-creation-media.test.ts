import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/lib/prisma";
import { createJobOwnership } from "./helpers/aijob-ownership";
import {
  FakeStockProvider,
  createLocalStockAsset,
  createSupplierFlyerAsset,
  installFakeStock,
} from "./helpers/stock";
import { createContentTool } from "../src/lib/ai/tools/content";
import { generateImageTool } from "../src/lib/ai/tools/generation";
import { getContent, deleteContent } from "../src/lib/services/content";
import { setImageProvider, setStockProvider } from "../src/lib/images/factory";
import {
  buildFallbackPhotoPrompt,
  placeNameFrom,
  stockQueryFrom,
} from "../src/lib/ai/content-stock";
import { getBrandOrCreate, resetBrandLogoCache } from "../src/lib/services/brand";
import { ImageProvider, GeneratedImage } from "../src/lib/images/provider";
import { buildVisualPrompt } from "../src/lib/ai/content-visual";
import { saveUploadedFile, deleteUploadedFile } from "../src/lib/uploads";
import sharp from "sharp";

const REPO_ROOT = join(__dirname, "..");

/**
 * createContent cerca il visual, e solo come ripiego lo genera.
 *
 * Regressione sul test reale del 26/09: una semplice richiesta "crea un post"
 * chiamava Magnific immagini e produceva un'immagine AI al primo tentativo. Oggi
 * il visual di un post nasce dalla ricerca nella libreria stock (destinazione →
 * foto → layout/template); se la libreria e la Media Library non hanno nulla per
 * quella destinazione, il visual viene generato con il provider immagini invece
 * di bloccare il post, e il fatto che sia generato viene dichiarato. Qui il
 * provider stock è un doppione che restituisce una foto decodificabile, e
 * `generateImage` resta disponibile per la richiesta esplicita.
 */

/** Provider finto: registra le chiamate e restituisce un file già "scaricato". */
class FakeImageProvider implements ImageProvider {
  readonly name = "fake";
  calls: { prompt: string; contentId?: string; aspectRatio?: string }[] = [];
  failWith: Error | null = null;

  constructor(readonly canGenerate = true) {}

  async generateImage(
    prompt: string,
    options?: { contentId?: string; aspectRatio?: string }
  ): Promise<GeneratedImage> {
    this.calls.push({
      prompt,
      contentId: options?.contentId,
      aspectRatio: options?.aspectRatio,
    });
    if (this.failWith) throw this.failWith;
    return {
      url: "/uploads/images/test-visual.png",
      provider: this.name,
      pathname: "C:/tmp/test-visual.png",
      mimeType: "image/png",
      size: 1234,
    };
  }

  async saveUploadedFile(): Promise<GeneratedImage> {
    throw new Error("non usato");
  }
}

/**
 * Provider che genera per davvero: scrive il file in Media Library con
 * `saveUploadedFile`, perché il fallback alla generazione scarta una risposta
 * che dichiara un file non a terra. È il percorso che il ramo stock non esercita.
 */
class GeneratingImageProvider implements ImageProvider {
  readonly name = "fake-generating";
  readonly canGenerate = true;
  calls: { prompt: string; aspectRatio?: string }[] = [];
  files: string[] = [];

  async generateImage(
    prompt: string,
    options?: { contentId?: string; aspectRatio?: string }
  ): Promise<GeneratedImage> {
    this.calls.push({ prompt, aspectRatio: options?.aspectRatio });
    const saved = await saveUploadedFile({
      buffer: await sharp({
        create: { width: 1024, height: 1024, channels: 3, background: "#1d7a8c" },
      })
        .jpeg({ quality: 80 })
        .toBuffer(),
      originalName: "generata.jpg",
      mimeType: "image/jpeg",
    });
    this.files.push(saved.url);
    return {
      url: saved.url,
      provider: this.name,
      pathname: saved.pathname,
      mimeType: saved.mimeType,
      size: saved.size,
    };
  }

  async saveUploadedFile(): Promise<GeneratedImage> {
    throw new Error("non usato");
  }
}

/** Destinazioni che non devono mai comparire se l'argomento è "Calabria". */
const OTHER_DESTINATIONS = [
  "amalfi",
  "costiera amalfitana",
  "puglia",
  "sardegna",
  "sicilia",
  "roma",
  "parigi",
  "tokyo",
  "giappone",
  "barcellona",
  "santorini",
];

const createdIds: string[] = [];
const createdAssetIds: string[] = [];
/** Asset creati apposta per esercitare il fallback della Media Library. */
const localStockAssetIds: string[] = [];
/** File scritti dal provider generativo, rimossi a fine suite. */
const generatedFiles: string[] = [];
/** Idee create per esercitare il legame relazionale. */
const ideaIds: string[] = [];

/** Provider stock finto: una foto per ogni ricerca, nessuna rete. */
let stock = new FakeStockProvider();

function textOf(c: { title: string | null; caption: string | null; hashtags: string | null }) {
  return `${c.title ?? ""} ${c.caption ?? ""} ${c.hashtags ?? ""}`.toLowerCase();
}

async function foreignDestinations(text: string): Promise<string[]> {
  return OTHER_DESTINATIONS.filter((d) =>
    new RegExp(`\\b${d}\\b`, "i").test(text)
  );
}

async function createTool(args: Record<string, unknown>) {
  const res = await createContentTool.execute(args);
  const data = (res.data ?? {}) as { id?: string };
  if (res.ok && typeof data.id === "string") createdIds.push(data.id);
  return { res, data: data as { id: string } & Record<string, unknown> };
}

beforeEach(() => {
  setImageProvider(new FakeImageProvider());
  stock = installFakeStock();
});

/**
 * Gli AIJob delle pipeline nascono senza `Content.contentId`: `recordJob` li
 * crea col solo `input`, e quando la pipeline genera la caption del contenuto
 * che sta per nascere quell'id non esiste ancora. La proprietà e il criterio
 * di pulizia sono nel helper condiviso: mai una finestra temporale.
 */
const jobOwnership = createJobOwnership(["CAPTION", "HASHTAGS", "IMAGE"]);

before(async () => {
  await jobOwnership.capture();
});

after(async () => {
  setImageProvider(null);
  setStockProvider(null);
  // Prima dei contenuti: `deleteContent` azzera `contentId` (SetNull) e da quel
  // momento non si saprebbe più di quale contenuto erano.
  await jobOwnership.deleteOwned(createdIds);
  for (const id of [...createdAssetIds.splice(0), ...localStockAssetIds.splice(0)]) {
    await prisma.contentAsset.delete({ where: { id } }).catch(() => {});
  }
  // Gli asset stock nati con i DRAFT di questo test.
  for (const id of createdIds) {
    await prisma.contentAsset.deleteMany({ where: { contentId: id } }).catch(() => {});
  }
  for (const id of createdIds.splice(0)) {
    await deleteContent(id).catch(() => {});
  }
  for (const url of generatedFiles.splice(0)) {
    await deleteUploadedFile(url).catch(() => {});
  }
  // Dopo i contenuti: l'idea è referenziata finché il DRAFT esiste.
  for (const id of ideaIds.splice(0)) {
    await prisma.contentIdea.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("argomenti astratti diventano parole che si possono cercare", () => {
  // Il tema è un'intenzione, non una scena: la libreria e il generatore
  // rispondono a un soggetto. La traduzione è il motivo per cui questi post non
  // falliscono al primo tentativo.
  test("un tema noto diventa una query con un soggetto, non una parola astratta", () => {
    const capitali = stockQueryFrom(null, "capitali europee", null);
    assert.match(capitali, /skyline|architecture/i, `query ottenuta: ${capitali}`);
    assert.doesNotMatch(capitali, /europee/, "il tema non viene mandato com'è");

    for (const tema of ["tropical islands", "città d'arte", "viaggio in montagna", "safari"]) {
      const query = stockQueryFrom(null, tema, null);
      assert.notEqual(query, tema, `il tema "${tema}" deve essere tradotto`);
      assert.ok(query.length > 10, `la query per "${tema}" deve descrivere qualcosa`);
    }
  });

  test("una destinazione nota viene cercata col suo landmark inglese", () => {
    // Nei provider indicizzati in inglese (Pixabay) il nome italiano (Rodi,
    // Creta, Atene) trova risultati sbagliati: la destinazione nota viene
    // quindi cercata col landmark più iconico in inglese, che è la parola che
    // identifica davvero il posto.
    assert.equal(
      stockQueryFrom("Rodi", "capitali europee", null),
      "rhodes old town",
      "la destinazione è cercata col landmark inglese, non col nome italiano"
    );
    // Anche un luogo passato come topic (senza destinazione esplicita) viene
    // cercato col landmark inglese: è lo stesso posto, non può cercarsi in due
    // modi diversi a seconda di come il modello lo inoltra.
    assert.equal(stockQueryFrom(null, "Maldive", null), "maldives beach");
    // Un luogo non curato resta sul nome ripulito, senza traduzione inventata.
    assert.match(stockQueryFrom(null, "Isola d'Elba", null), /Isola/, "il nome del luogo resta");
  });

  test("il prompt di generazione riceve la scena, non il tema", () => {
    const dalTema = buildFallbackPhotoPrompt("european capital city skyline", "capitali europee");
    assert.match(dalTema, /skyline/i, "il prompt usa la scena tradotta");

    // Su un luogo la traduzione non parte, e il prompt resta sul nome vero.
    const dalLuogo = buildFallbackPhotoPrompt("Maldive", "Maldive");
    assert.match(dalLuogo, /Maldive/, "il prompt sul luogo non inventa altro soggetto");
    assert.match(dalLuogo, /no text, no logos/, "il divieto di grafica resta");
  });
});

describe("createContent crea il DRAFT con il visual recuperato dallo stock", () => {
  test("1. con topic Calabria crea un DRAFT con i campi richiesti e il visual collegato", async () => {
    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria: spiagge, borghi e cucina tipica.",
      hashtags: "#calabria #viaggi #suditalia",
      platforms: ["INSTAGRAM", "FACEBOOK"],
    });

    assert.equal(res.ok, true, res.message);
    const content = await getContent(data.id);
    assert.ok(content, "il contenuto deve esistere");
    assert.equal(content!.status, "DRAFT", "createContent crea sempre in DRAFT");
    assert.equal(content!.type, "POST");
    assert.deepEqual(
      content!.platforms.map((p) => p.platform).sort(),
      ["FACEBOOK", "INSTAGRAM"]
    );
    assert.ok((content!.caption ?? "").length > 0, "la caption c'è");

    // Il visual è obbligatorio: con lo stock che risponde il DRAFT nasce già
    // completo, e la ricerca parte dalla destinazione richiesta.
    assert.equal(data.withMedia, true, "il DRAFT nasce con il suo visual");
    assert.equal(typeof data.assetId, "string", "l'asset deve essere dichiarato");
    assert.equal(data.visualSource, "fake-stock");
    assert.equal(data.stockQuery, "Calabria", "si cerca per destinazione");
    assert.equal(data.templateApplied, true, "il layout social viene applicato");
    assert.equal(content!.assets.length, 1, "il DRAFT non resta mai senza visual");

    const asset = await prisma.contentAsset.findUnique({
      where: { id: String(data.assetId) },
    });
    assert.ok(asset, "l'asset deve esistere in Media Library");
    const metadata = asset!.metadata as Record<string, unknown>;
    assert.equal(metadata.origin, "stock-visual", "provenienza dichiarata");
    assert.equal(metadata.template, "social-creative-v1");
  });

  test("2. nessuna chiamata al provider immagini, nemmeno con withMedia:true", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      hashtags: "#calabria",
      platforms: ["INSTAGRAM"],
      withMedia: true,
    });

    assert.equal(images.calls.length, 0, "il generatore immagini non deve essere chiamato");
    assert.equal(
      await prisma.contentAsset.count({ where: { contentId: data.id } }),
      1,
      "il visual arriva dallo stock, non dalla generazione"
    );
    assert.ok(
      stock.searches.some((s) => s.query === "Calabria"),
      "la ricerca stock per destinazione deve essere partita"
    );
  });

  test("3. il messaggio all'utente è pulito: i dettagli restano nei dati", async () => {
    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });

    // Cosa l'utente deve leggere: che il post c'è e dove trovarlo.
    assert.match(res.message, /creato con successo/i);
    assert.match(res.message, /DRAFT/);
    assert.match(res.message, /Contenuti/);

    // Cosa non deve leggere mai: log di esecuzione. Sono rumore per chi ha solo
    // chiesto di creare un post, e nessuno di questi dati gli serve per agire.
    for (const tecnico of [
      /fake-stock|fake-generating|provider|Magnific|Media Library|libreria stock/,
      /social-creative-v1|layout|template/i,
      /assetId|asset |id [a-z0-9]{6,}/i,
      /Attenzione:|warning/i,
      /query|ricerca "/i,
    ]) {
      assert.doesNotMatch(res.message, tecnico, `il messaggio non deve contenere: ${tecnico}`);
    }

    // I dettagli non sono persi: sono nei dati, dove il modello li legge se
    // l'utente chiede o un follow-up su come è stato fatto il post.
    assert.equal(data.visualSource, "fake-stock");
    assert.equal(data.stockQuery, "Calabria");
    assert.equal(data.template, "social-creative-v1");
  });

  test("4. il contenuto mantiene la destinazione richiesta", async () => {
    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria: spiagge, borghi e cucina tipica.",
      hashtags: "#calabria #viaggi",
      platforms: ["INSTAGRAM"],
    });

    const content = await getContent(data.id);
    const text = textOf(content!);
    assert.match(text, /calabria/, "la destinazione richiesta deve essere presente");
    assert.deepEqual(
      await foreignDestinations(text),
      [],
      "non deve comparire una destinazione estranea"
    );
  });

  test("5. senza nessuna immagine non viene creato alcun DRAFT", async () => {
    const before = await prisma.content.count();
    stock.returnImage = false;

    // La catena del visual ha tre gradini e qui devono dire tutti no: lo stock
    // non ha nulla, la Media Library non ha nulla per questa destinazione e il
    // provider immagini non sa generare. La destinazione è scelta perché in
    // Media Library non può esserci nulla che la nomini: con una destinazione
    // usata da un altro test, il secondo gradino dipendeva da un asset libero
    // creato altrove e il test poteva passare o fallire per lo stato del DB.
    const nowhere = "Zermatt";
    const { res, data } = await createTool({
      topic: `proposta ${nowhere}`,
      title: `${nowhere}, il silenzio delle cime`,
      caption: `Scopriamo ${nowhere}.`,
      hashtags: `#${nowhere.toLowerCase()}`,
      platforms: ["INSTAGRAM"],
    });

    // Precondizione dichiarata, non sperata: nessun asset libero nomina questa
    // destinazione, quindi il fallimento è quello del visual e non un immagine
    // rimasta in libreria.
    const free = await prisma.contentAsset.findMany({
      where: { contentId: null, kind: "IMAGE" },
      select: { filename: true, metadata: true },
    });
    assert.equal(
      free.filter((a) => /zermatt/i.test(JSON.stringify(a))).length,
      0,
      "la Media Library deve essere vuota per questa destinazione"
    );

    assert.equal(res.ok, false, "un post senza visual non esiste");
    assert.match(res.message, /nessuna immagine trovata nella libreria stock/);
    assert.match(res.message, /nessun post deve restare senza visual/);
    assert.equal(data.createdContentId, null, "nessun contenuto lasciato a metà");
    assert.equal(
      await prisma.content.count(),
      before,
      "la creazione viene annullata, non lasciata in DRAFT"
    );
  });

  test("5b. la libreria è vuota: il visual viene generato e il DRAFT non viene bloccato", async () => {
    const before = await prisma.content.count();
    stock.returnImage = false;

    // Provider che scrive davvero il file: la generazione è dichiarata solo se
    // il file è a terra, altrimenti non ci sarebbe nulla da collegare.
    const images = new GeneratingImageProvider();
    setImageProvider(images);

    const { res, data } = await createTool({
      topic: "Maldive",
      title: "Maldive, acqua cristallina",
      caption: "Un'isola lontanissima.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    assert.equal(images.calls.length, 1, "il provider immagini viene usato come ripiego");
    assert.equal(images.calls[0].prompt.includes("Maldive"), true, "il prompt parte dal topic");
    assert.match(images.calls[0].prompt, /realistic photo/);
    assert.match(images.calls[0].prompt, /no text, no logos/);

    // La generazione va dichiarata, non camuffata da foto di libreria. La
    // dichiarazione sta nei dati e nei warning: il messaggio all'utente resta
    // la conferma che il post è stato creato.
    assert.equal(data.visualGenerated, true);
    assert.equal(data.visualSource, "fake-generating");
    assert.match(res.message, /creato con successo/i);
    assert.doesNotMatch(res.message, /generat|fake|provider/i);
    assert.ok(
      (data.warnings as string[]).some((w) => /non è una foto reale del luogo/.test(w)),
      "il modello deve poter dire che il visuale non è una foto reale"
    );

    assert.equal(await prisma.content.count(), before + 1, "il DRAFT c'è");
    const content = await getContent(data.id);
    assert.equal(content!.status, "DRAFT");
    assert.equal(content!.assets.length, 1, "il DRAFT non resta senza visual");

    // L'asset porta la provenienza della generazione.
    const asset = content!.assets[0] as { metadata: Record<string, unknown> };
    assert.equal(asset.metadata.origin, "generated-visual");
    assert.equal(asset.metadata.generated, true);
    assert.equal(typeof asset.metadata.generatedPrompt, "string");

    generatedFiles.push(...images.files.splice(0));
  });

  test("5c. un ideaId inesistente non fa fallire la creazione (P2003)", async () => {
    // Regressione sul bug reale: il modello si inventa un ideaId plausibile,
    // `prisma.content.create` lo scriveva e il database rispondeva "Foreign key
    // constraint violated", facendo esplodere il tool invece di creare il post.
    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
      ideaId: "cm-idea-inventata-0000000000",
    });

    assert.equal(res.ok, true, res.message);
    const content = await getContent(data.id);
    assert.ok(content, "il DRAFT deve esistere");
    assert.equal(content!.ideaId, null, "il legame inesistente non viene scritto");
    // Non silenzioso: il modello deve sapere che l'id non esisteva.
    assert.match(
      (data.warnings as string[]).join(" "),
      /l'idea "cm-idea-inventata-0000000000" non esiste/,
      "l'anomalia va dichiarata, non nascosta"
    );
  });

  test("5d. un ideaId valido viene collegato e non produce warning", async () => {
    const idea = await prisma.contentIdea.create({
      data: { title: "idea collegata" },
      select: { id: true },
    });
    ideaIds.push(idea.id);

    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
      ideaId: idea.id,
    });

    assert.equal(res.ok, true, res.message);
    const content = await getContent(data.id);
    assert.equal(content!.ideaId, idea.id, "il legame valido viene scritto");
    assert.doesNotMatch(
      (data.warnings as string[]).join(" "),
      /non esiste/,
      "un id valido non deve generare avvisi"
    );
  });

  test("5e. il titolo sul template è il nome del luogo, senza frasi generiche", async () => {
    // Il titolo del DRAFT porta con sé il suffisso editoriale
    // ("proposta di viaggio"): sul fotogramma deve sparire e restare il luogo.
    assert.equal(placeNameFrom(null, "proposta Maldive", "Maldive — proposta di viaggio"), "Maldive");
    assert.equal(placeNameFrom(null, null, "Grecia - da vivere con calma"), "Grecia");
    assert.equal(placeNameFrom(null, "crea un post su Maldive", null), "Maldive");
    assert.equal(placeNameFrom("Isola d'Elba", null, "qualsiasi titolo"), "Isola d'Elba");
    // Se non resta un nome, non si stampa un titolo inventato.
    assert.equal(placeNameFrom(null, "proposta di viaggio", "proposta di viaggio"), "");

    const { res, data } = await createTool({
      topic: "proposta Maldive",
      caption: "Un'isola lontanissima.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(res.ok, true, res.message);

    const asset = await prisma.contentAsset.findUnique({
      where: { id: String(data.assetId) },
      select: { filename: true, metadata: true },
    });
    const filename = asset!.filename;
    assert.doesNotMatch(filename, /viaggio/i, "il nome del file non porta la formula generica");
    assert.match(filename, /maldive/i, "il nome del file deriva dal luogo");
    // Il topic è la richiesta ("proposta Maldive"), non il nome del luogo: se
    // finisse nel titolo, il fotogramma porterebbe la formula dell'utente. Il
    // nome del file deriva dal titolo stampato, quindi ne è la prova.
    assert.doesNotMatch(filename, /proposta/i, "la formula del topic non arriva sul template");
  });

  test("5f. senza logo caricato il marchio stampato è il wordmark dell'agenzia", async () => {
    const brand = await getBrandOrCreate();
    const previousLogo = brand.logoUrl;
    await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl: null } });
    resetBrandLogoCache();

    try {
      const { res, data } = await createTool({
        topic: "proposta Calabria",
        title: "Calabria, il Sud che fa sognare",
        caption: "Scopriamo la Calabria.",
        platforms: ["INSTAGRAM"],
      });
      assert.equal(res.ok, true, res.message);

      const asset = await prisma.contentAsset.findUnique({
        where: { id: String(data.assetId) },
        select: { metadata: true },
      });
      const metadata = asset!.metadata as Record<string, unknown>;

      // Ogni post esce con il marchio. Senza un logo file il marchio è il
      // wordmark: il nome dell'agenzia, cioè dati reali di chi produce il post
      // e non un segno grafico inventato al posto del logo.
      assert.equal(
        metadata.hasBrandLogo,
        true,
        "senza logo file l'overlay porta comunque il marchio dell'agenzia"
      );
      assert.equal(
        metadata.brandMark,
        "wordmark",
        "l'asset dichiara quale marchio è finito sul fotogramma"
      );
      assert.equal(data.brandMark, "wordmark", "il modello riceve la stessa dichiarazione");
    } finally {
      await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl: previousLogo } });
      resetBrandLogoCache();
    }
  });

  test("5g. con Brand.logoUrl valorizzato il marchio viene realmente stampato", async () => {
    // Logo finto ma reale sul disco: la catena deve arrivare fino a sharp.
    const logo = await saveUploadedFile({
      buffer: await sharp({
        create: { width: 400, height: 120, channels: 4, background: "#ffffff" },
      })
        .png()
        .toBuffer(),
      originalName: "brand-logo.png",
      mimeType: "image/png",
    });
    generatedFiles.push(logo.url);

    const brand = await getBrandOrCreate();
    const previous = brand.logoUrl;
    await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl: logo.url } });
    resetBrandLogoCache();

    try {
      const { res, data } = await createTool({
        topic: "proposta Calabria",
        title: "Calabria, il Sud che fa sognare",
        caption: "Scopriamo la Calabria.",
        platforms: ["INSTAGRAM"],
      });
      assert.equal(res.ok, true, res.message);

      const asset = await prisma.contentAsset.findUnique({
        where: { id: String(data.assetId) },
        select: { metadata: true, size: true },
      });
      const metadata = asset!.metadata as Record<string, unknown>;
      assert.equal(
        metadata.hasBrandLogo,
        true,
        "il marchio configurato deve risultare stampato"
      );
      assert.equal(
        metadata.brandMark,
        "logo",
        "con Brand.logoUrl valorizzato vince il file, non il wordmark"
      );
    } finally {
      await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl: previous } });
      resetBrandLogoCache();
    }
  });

  test("6. se lo stock non ha nulla il visual arriva dalla Media Library", async () => {
    const before = await prisma.content.count();
    stock.returnImage = false;
    const local = await createLocalStockAsset("calabria");
    localStockAssetIds.push(local.id);

    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    assert.equal(data.visualSource, "media-library", "secondo gradino della catena");
    assert.equal(await prisma.content.count(), before + 1, "il DRAFT c'è");
    const content = await getContent(data.id);
    assert.equal(content!.assets.length, 1, "anche così il post non resta senza visual");
  });

  test("6b. la locandina di un fornitore non diventa mai il visuale di un post", async () => {
    // È la protezione più importante di questa suite: il file del fornitore
    // contiene il suo logo e la sua grafica promozionale, e la catena del
    // visual lo cerca per nome in Media Library. Il suo nome contiene la
    // destinazione, quindi la sola difesa è escluderlo esplicitamente.
    stock.returnImage = false;
    const supplier = await createSupplierFlyerAsset("Sardegna");
    localStockAssetIds.push(supplier.id);
    // Un asset neutro sulla stessa destinazione: senza di esso il post
    // cadrebbe sul terzo gradino (generazione) e il test non dimostrerebbe
    // che è la locandina a essere esclusa.
    const neutral = await createLocalStockAsset("Sardegna");
    localStockAssetIds.push(neutral.id);

    const { res, data } = await createTool({
      topic: "proposta Sardegna",
      title: "Sardegna, il Nord più selvaggio",
      caption: "Scopriamo la Sardegna.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    assert.equal(data.visualSource, "media-library", "il visual arriva dalla libreria");
    const asset = await prisma.contentAsset.findUnique({
      where: { id: String(data.assetId) },
      select: { url: true, metadata: true },
    });
    assert.notEqual(
      asset!.url,
      supplier.url,
      "il post non può avere la locandina del fornitore come immagine"
    );
    const meta = asset!.metadata as Record<string, unknown>;
    assert.equal(meta.origin, "stock-visual", "è una foto, non un materiale promozionale");
    assert.equal(meta.templateApplied, true, "il template dell'agenzia ci passa sopra");

    // Il file del fornitore resta dov'è: è escluso come sorgente, non cancellato.
    assert.ok(await prisma.contentAsset.findUnique({ where: { id: supplier.id } }));
  });

  test("6c. senza nessuna foto la locandina non viene usata al posto della generazione", async () => {
    // Il caso estremo: in libreria c'è solo la locandina. Il visual deve
    // arrivare dalla generazione, perché usare il file del fornitore sarebbe
    // peggio che generare. Serve il provider che scrive davvero il file: il
    // fallback scarta una risposta che dichiara un file non a terra.
    stock.returnImage = false;
    const supplier = await createSupplierFlyerAsset("Liguria");
    localStockAssetIds.push(supplier.id);
    const generator = new GeneratingImageProvider();
    setImageProvider(generator);

    const { res, data } = await createTool({
      topic: "proposta Liguria",
      title: "Liguria, tra borghi e mare",
      caption: "Scopriamo la Liguria.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    assert.equal(generator.calls.length, 1, "il visual è stato generato");
    assert.equal(data.visualGenerated, true);
    const asset = await prisma.contentAsset.findUnique({
      where: { id: String(data.assetId) },
      select: { url: true },
    });
    assert.notEqual(
      asset!.url,
      supplier.url,
      "la locandina non è il ripiego quando manca tutto il resto"
    );
  });

  test("6d. TRAVEL_TIPS stampa la rubrica: il post non è solo il nome del luogo", async () => {
    // Lo stesso posto, due formati, due fotogrammi: senza la rubrica un post di
    // consigli sarebbe visivamente identico a un hero e il lettore non saprebbe
    // di che cosa si tratta.
    const hero = await createTool({
      topic: "proposta Calabria",
      format: "HERO_DESTINATION",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });
    const tips = await createTool({
      topic: "proposta Calabria",
      format: "TRAVEL_TIPS",
      title: "Calabria, il Sud che fa sognare",
      caption: "Tre cose da sapere prima di partire.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(hero.res.ok, true, hero.res.message);
    assert.equal(tips.res.ok, true, tips.res.message);

    const heroMeta = (
      await prisma.contentAsset.findUniqueOrThrow({
        where: { id: String(hero.data.assetId) },
        select: { metadata: true },
      })
    ).metadata as Record<string, unknown>;
    const tipsMeta = (
      await prisma.contentAsset.findUniqueOrThrow({
        where: { id: String(tips.data.assetId) },
        select: { metadata: true },
      })
    ).metadata as Record<string, unknown>;

    // Ogni formato dichiara che cosa promette: due post sulla stessa destinazione
    // devono essere distinguibili dal fotogramma senza leggere la caption. L'hero
    // è la vetrina e mostra solo il nome del luogo, senza rubrica.
    assert.equal(heroMeta.kicker, null, "l'hero mostra solo il nome del luogo, senza rubrica");
    assert.equal(tipsMeta.kicker, "Consigli di viaggio", "il formato promette informazione e la dichiara");
    assert.equal(tips.data.kicker, "Consigli di viaggio", "il modello riceve la stessa dichiarazione");
    assert.notEqual(
      heroMeta.kicker,
      tipsMeta.kicker,
      "un hero e un post di consigli non possono avere la stessa rubrica"
    );

    // Il titolo resta il luogo, che è l'unico dato verificabile: la rubrica
    // dichiara a che cosa serve il post, non sostituisce il contenuto.
    assert.match(String(tipsMeta.destination), /Calabria/);
  });

  test("6e. un argomento astratto diventa una query fotografabile al primo tentativo", async () => {
    // "Capitali europee" è un'intenzione, non una scena: cercata così com'è non
    // torna niente e il post si fermerebbe al primo tentativo.
    stock.returnImage = true;
    const { res, data } = await createTool({
      topic: "capitali europee",
      caption: "Le capitali europee da vedere.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    const searched = stock.searches[stock.searches.length - 1];
    assert.notEqual(
      searched.query,
      "capitali europee",
      "il tema non viene mandato com'è alla libreria"
    );
    assert.match(
      searched.query,
      /skyline|architecture/i,
      `la query deve descrivere un soggetto, trovato: ${searched.query}`
    );
    assert.equal(data.stockQuery, searched.query, "la query dichiarata è quella cercata");
  });

  test("6f. un luogo passato come topic viene cercato col landmark inglese", async () => {
    // Anche senza "destination" esplicito, un luogo noto va cercato col suo
    // landmark in inglese: "Maldive" da solo troverebbe immagini generiche,
    // "maldives beach" trova la spiaggia che l'utente si aspetta.
    stock.returnImage = true;
    const { res, data } = await createTool({
      topic: "Maldive",
      caption: "Un'isola lontanissima.",
      platforms: ["INSTAGRAM"],
    });

    assert.equal(res.ok, true, res.message);
    assert.equal(data.stockQuery, "maldives beach", "il luogo è cercato col landmark inglese");
    assert.equal(stock.searches[stock.searches.length - 1].query, "maldives beach");
  });

  test("7. un provider immagini rotto o assente non cambia nulla", async () => {
    // 7a. provider che fallisce: non viene nemmeno coinvolto
    const failing = new FakeImageProvider();
    failing.failWith = new Error("Magnific non raggiungibile");
    setImageProvider(failing);

    const { res, data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(failing.calls.length, 0, "il provider non viene coinvolto");
    const content = await getContent(data.id);
    assert.ok(content && content.status === "DRAFT", "il DRAFT resta valido");
    assert.equal(content.assets.length, 1, "il visual arriva dallo stock");
    assert.doesNotMatch(res.message, /Magnific non raggiungibile/);

    // 7b. provider non configurato: stesso risultato, nessun errore
    setImageProvider(new FakeImageProvider(false));
    const { res: res2, data: data2 } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, senza provider",
      caption: "Un post sulla Calabria.",
      platforms: ["INSTAGRAM"],
    });
    assert.equal(res2.ok, true, res2.message);
    const content2 = await getContent(data2.id);
    assert.equal(content2!.status, "DRAFT");
    assert.equal(content2!.assets.length, 1);
    assert.equal(data2.withMedia, true);
  });
});

describe("il flusso esplicito di Magnific resta disponibile", () => {
  test("7. generateImage con contentId genera e collega l'asset", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const { data } = await createTool({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Scopriamo la Calabria.",
      platforms: ["INSTAGRAM"],
    });

    const gen = await generateImageTool.execute({
      prompt: "Borghi della Calabria sul mare, luce dorata",
      contentId: data.id,
    });
    assert.equal(gen.ok, true, gen.message);
    assert.equal(images.calls.length, 1, "qui il provider viene chiamato");
    assert.equal(images.calls[0].contentId, data.id);

    const assetId = (gen.data as { assetId: string }).assetId;
    createdAssetIds.push(assetId);
    const asset = await prisma.contentAsset.findUnique({ where: { id: assetId } });
    assert.ok(asset, "l'asset deve esistere in Media Library");
    assert.equal(asset!.contentId, data.id);
    assert.equal(asset!.kind, "IMAGE");
    assert.match((asset!.metadata as { prompt?: string }).prompt ?? "", /calabria/i);
  });

  test("8. generateImage senza contentId resta utilizzabile", async () => {
    const images = new FakeImageProvider();
    setImageProvider(images);

    const gen = await generateImageTool.execute({ prompt: "Tramonto sulla costa" });
    assert.equal(gen.ok, true, gen.message);
    const assetId = (gen.data as { assetId: string }).assetId;
    createdAssetIds.push(assetId);
    const asset = await prisma.contentAsset.findUnique({ where: { id: assetId } });
    assert.ok(asset, "l'asset resta in Media Library");
    assert.equal(asset!.contentId, null, "nessun contenuto collegato");
  });
});

describe("Il prompt del visual è ancorato al topic", () => {
  test("ripete il topic e vieta altre destinazioni", () => {
    const prompt = buildVisualPrompt({
      topic: "proposta Calabria",
      title: "Calabria, il Sud che fa sognare",
      caption: "Spiagge e borghi.",
      hashtags: "#calabria",
    });
    assert.match(prompt, /proposta Calabria/);
    assert.match(prompt, /ESCLUSIVAMENTE/i);
    assert.match(prompt, /non introdurre altre destinazioni/i);
  });

  test("senza topic usa il titolo e resta comunque limitato", () => {
    const prompt = buildVisualPrompt({ title: "Vacanza in Toscana" });
    assert.match(prompt, /Toscana/);
    assert.ok(prompt.length <= 1000, "il prompt rispetta il limite del provider");
  });

  test("il system prompt dell'agente vieta le destinazioni estranee e le immagini automatiche", () => {
    // Regressione sul bug: "proposta Calabria" produceva una caption sull'Amalfi.
    const agent = readFileSync(join(REPO_ROOT, "src", "lib", "ai", "agent.ts"), "utf8");
    assert.match(agent, /topic: argomento esatto chiesto/);
    assert.match(agent, /parlano solo di quello, senza altre destinazioni/);
    assert.match(agent, /senza destinazioni o prodotti non richiesti/);
    // Il divieto di generazione automatica resta: il visual si recupera
    // cercandolo nella libreria stock per destinazione, e il prompt lo dice.
    assert.match(agent, /createContent NON genera immagini AI/);
    assert.match(agent, /nessun post resta senza visual/);
    assert.match(agent, /solo se l'utente la chiede esplicitamente/);
    // Il Catalogo non è più una condizione per creare: nessuna riga impone di
    // ancorare il contenuto a una proposta prima di generare il DRAFT.
    assert.doesNotMatch(agent, /Con "fromCatalog": true il visuale è già pronto/);
    assert.doesNotMatch(agent, /## CATALOGO/);
  });

  test("createContent non chiama più ensureContentVisual", () => {
    // La garanzia è sul codice: nessun percorso automatico verso il generatore.
    const tool = readFileSync(join(REPO_ROOT, "src", "lib", "ai", "tools", "content.ts"), "utf8");
    assert.doesNotMatch(tool, /ensureContentVisual/);
    assert.doesNotMatch(tool, /getImageProvider/);
  });
});
