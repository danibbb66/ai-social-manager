import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma";
import {
  anomaliesForProposals,
  deleteCatalogSource,
  getCatalogStats,
  listCatalogProposals,
  listCatalogSources,
  offertaContentHash,
  syncOfferteCatalog,
} from "../src/lib/services/catalog";
import {
  decodeEntities,
  deriveDestination,
  detectCardAnomalies,
  isPlaceholderTitle,
  parseLocandineCards,
  resolveUrl,
  titleMatchesImage,
  type OfferteCard,
} from "../src/lib/catalog/offerte";

/**
 * Catalogo Agenzia — import del livello di presentazione.
 *
 * I test non dipendono dalla rete: l'HTML viene iniettato. Le invarianti
 * verificate sono quelle che tengono insieme la promessa del catalogo:
 * nessun dato commerciale inventato, nessuna correzione automatica delle
 * incoerenze del sito, import idempotente e mai distruttivo.
 */

const sourceIds: string[] = [];

function uniqPage(): string {
  return `https://www.mrhromaboccea.it/catalog-test-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}/offerte/`;
}

/**
 * Fixture che riproduce i casi reali trovati sul sito, inclusi quelli
 * sbagliati: il parser deve importarli così come sono, senza correggerli.
 */
function fixture(base: string): string {
  return `<!DOCTYPE html><html><head><style>
.locandina-grid { display: flex; }
.locandina-link { display: block; }
</style></head><body>
<nav><a href="/servizi/" class="menu-link">Servizi</a></nav>
<div class="locandina-grid">
  <a href="${base}wp-content/uploads/2026/09/locandina_mainstream-CIPRO_page-0001.webp"
     class="locandina-link" data-title="Cipro" style="max-width: 32%;">
  </a>
  <a href="${base}wp-content/uploads/2026/06/RODI-MIL-E-ROM-05-DEC.webp"
     class="locandina-link" data-title="Rodi da Milano e Roma">
  </a>
  <a href="${base}wp-content/uploads/2026/06/NEW-YORK-MIL-E-ROM-30-DEC.webp"
     class="locandina-link" data-title="Mauritius da Milano e Roma">
  </a>
  <a href="${base}wp-content/uploads/2026/06/NEW-YORK-MIL-E-ROM-30-DEC.webp"
     class="locandina-link" data-title="New York Capodanno">
  </a>
  <a href="${base}wp-content/uploads/2026/09/locandina_mainstream-SPORADI_page-0001.jpg"
     class="locandina-link" data-title="Sporadi">
  </a>
  <a href="${base}wp-content/uploads/2026/07/photo_5956343122809785891_y.webp"
     class="locandina-link" data-title="Nuova Locandina 1">
  </a>
  <a href="${base}wp-content/uploads/2026/07/photo_5956343122809785894_y.webp"
     class="locandina-link" data-title="Nuova Locandina 2">
  </a>
  <a href="wp-content/uploads/2026/06/THAI-LIBERTA-MIL-ROM-NAP-29-DEC.webp"
     class="locandina-link" data-title="Thailandia Libert&agrave; Capodanno">
  </a>
  <a href="${base}wp-content/uploads/2026/06/MALDIVE-MIL-E-ROM-19-DEC.jpg"
     class="locandina-link">
  </a>
  <a href="${base}pagina-non-immagine/" class="locandina-link" data-title="Link testuale">
  </a>
</div>
<footer><a href="https://www.mrhromaboccea.it/contatti/">Contatti</a></footer>
</body></html>`;
}

async function importFixture(html: string) {
  const report = await syncOfferteCatalog({ html, pageUrl: uniqPage() });
  sourceIds.push(report.sourceId);
  const proposals = await prisma.catalogProposal.findMany({
    where: { sourceId: report.sourceId },
    include: { images: true, source: true },
    orderBy: { sourceOrder: "asc" },
  });
  return { report, proposals };
}

before(async () => {
  // Nessuna pulizia preventiva: gli ID sono unici per esecuzione.
});

after(async () => {
  for (const id of sourceIds.splice(0)) {
    try {
      await deleteCatalogSource(id);
    } catch {
      /* già rimossa */
    }
  }
  await prisma.$disconnect();
});

describe("Parsing delle card della pagina /offerte/", () => {
  const base = "https://www.mrhromaboccea.it/";
  const cards = parseLocandineCards(fixture(base), base);

  test("estrae le card del grid delle locandine", () => {
    // 9 card: il link di menu, il link testuale e il contatto del footer
    // non sono locandine e devono essere ignorati.
    assert.equal(cards.length, 9);
  });

  test("estrae data-title come nome della proposta", () => {
    const cipro = cards.find((c) => c.name === "Cipro");
    assert.ok(cipro, "la card Cipro deve essere presente");
    assert.equal(cipro.destination, "Cipro");
    assert.equal(cipro.filename, "locandina_mainstream-CIPRO_page-0001.webp");
  });

  test("risolve gli URL relativi rispetto alla pagina sorgente", () => {
    const thai = cards.find((c) => /Thailandia/.test(c.name));
    assert.ok(thai, "la card thailandese deve essere presente");
    assert.equal(
      thai.imageUrl,
      "https://www.mrhromaboccea.it/wp-content/uploads/2026/06/THAI-LIBERTA-MIL-ROM-NAP-29-DEC.webp"
    );
  });

  test("decodifica le entità HTML nel titolo", () => {
    const thai = cards.find((c) => /Thailandia/.test(c.name));
    assert.equal(thai?.name, "Thailandia Libertà Capodanno");
  });

  test("senza data-title il nome cade sul nome file e resta segnalato", () => {
    const orphan = cards.find((c) => c.filename === "MALDIVE-MIL-E-ROM-19-DEC.jpg");
    assert.ok(orphan, "la card senza titolo deve essere importata");
    assert.equal(orphan.rawTitle, null);
    assert.equal(orphan.name, "MALDIVE-MIL-E-ROM-19-DEC");
  });

  test("ignora ancore che non puntano a un'immagine", () => {
    assert.equal(
      cards.some((c) => c.name === "Link testuale"),
      false
    );
  });

  test("senza il marker del grid non estrae nulla (layout cambiato)", () => {
    const senzaGrid = '<div class=" altro"><a class="locandina-link" data-title="X" href="https://x/y.webp"></a></div>';
    assert.deepEqual(parseLocandineCards(senzaGrid), []);
  });

  test("accetta anche la grafia alternativa locandine-", () => {
    const legacy = `<div class="locandine-grid">
      <a class="locandine-link" data-title="Cipro" href="https://x/CIPRO.webp"></a>
    </div>`;
    const parsed = parseLocandineCards(legacy);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "Cipro");
  });

  test("l'ordine delle card è preservato", () => {
    assert.deepEqual(
      cards.map((c) => c.order),
      cards.map((_, i) => i)
    );
    assert.equal(cards[0].name, "Cipro");
  });
});

describe("Derivazione della destinazione (regola conservativa)", () => {
  test("la parte dopo 'da' è la città di partenza, non la destinazione", () => {
    assert.equal(deriveDestination("Rodi da Milano e Roma"), "Rodi");
    assert.equal(deriveDestination("Maldive da Milano e Roma"), "Maldive");
  });

  test("un titolo senza qualificatori è il luogo", () => {
    assert.equal(deriveDestination("Cipro"), "Cipro");
    assert.equal(deriveDestination("Repubblica Dominicana"), "Repubblica Dominicana");
  });

  test("un titolo con tipologia o occasione non viene trattato come luogo", () => {
    assert.equal(deriveDestination("Thailandia Libertà Capodanno"), null);
    assert.equal(deriveDestination("City Break Lisbona Parigi"), null);
    assert.equal(deriveDestination("New York Dicembre"), null);
  });

  test("il titolo segnaposto resta riconosciuto e il marchio non diventa luogo", () => {
    // Il titolo così come l'agenzia lo pubblica resta riconosciuto come
    // segnaposto: la funzione non cambia, cambia che cosa il parser ne fa.
    assert.equal(isPlaceholderTitle("Nuova Locandina 1"), true);

    // Il marchio non intasa il luogo: tolto dal titolo, il resto è la
    // destinazione, perché è il resto ad arrivare sul fotogramma del post.
    assert.equal(deriveDestination("Veratour - Rodi"), "Rodi");
    assert.equal(deriveDestination("Alpitour Cipro da Milano e Roma"), "Cipro");

    // Un titolo fatto solo di marchio o di materiale promozionale non lascia
    // nulla: la destinazione resta `null` invece di diventare il nome del
    // distributore, che su un post dell'agenzia non ci deve essere.
    assert.equal(deriveDestination("Veratour"), null);
    assert.equal(deriveDestination("Brochure Bravifondo"), null);
    assert.equal(deriveDestination("Veratour - Locandina"), null);
  });
});

describe("Rilevamento anomalie", () => {
  const base = "https://www.mrhromaboccea.it/";
  const cards = parseLocandineCards(fixture(base), base);
  const map = detectCardAnomalies(cards);

  const codes = (order: number) => (map.get(order) ?? []).map((a) => a.code);

  test("segnala il titolo che non combacia con il nome file", () => {
    const mauritius = cards.findIndex((c) => /Mauritius/.test(c.name));
    assert.ok(codes(mauritius).includes("TITLE_IMAGE_MISMATCH"));
    assert.equal(
      titleMatchesImage("Mauritius", "NEW-YORK-MIL-E-ROM-30-DEC.webp"),
      false
    );
    assert.equal(titleMatchesImage("Cipro", "locandina_mainstream-CIPRO_page-0001.webp"), true);
  });

  test("segnala l'immagine usata da più card", () => {
    const newYork = cards.findIndex(
      (c) => c.filename === "NEW-YORK-MIL-E-ROM-30-DEC.webp"
    );
    assert.ok(codes(newYork).includes("SHARED_IMAGE"));
  });

  test("segnala il marchio tolto dal titolo invece di importarlo", () => {
    // "locandina" è materiale promozionale, non un luogo: la proposta entra
    // col titolo ripulito e la rimozione resta dichiarata, così chi rivede
    // il catalogo non crede che l'agenzia abbia scritto così.
    const ph = cards.findIndex((c) => c.name === "Nuova 1");
    assert.ok(ph >= 0, "la card deve essere importata col titolo ripulito dal marchio");
    assert.equal(
      cards[ph].rawTitle,
      "Nuova Locandina 1",
      "il titolo pubblicato resta tracciato accanto al nome ripulito"
    );
    assert.equal(cards[ph].brandingRemoved, true);
    assert.ok(codes(ph).includes("DISTRIBUTOR_BRAND"));

    // La parola che dichiara il segnaposto va verificata sul titolo pubblicato,
    // prima che il marchio venga tolto: ripulito, "Nuova Locandina 1" diventa
    // "Nuova 1" e da solo non dice più che la locandina non è identificata.
    assert.ok(
      codes(ph).includes("PLACEHOLDER_TITLE"),
      "il titolo segnaposto resta riconosciuto anche dopo la rimozione del marchio"
    );

    // E il titolo di una card che non contiene marchi resta identico: la
    // rimozione è conservativa, non una normalizzazione.
    const cipro = cards.findIndex((c) => c.name === "Cipro");
    assert.equal(cards[cipro].brandingRemoved, false);
    assert.ok(!codes(cipro).includes("DISTRIBUTOR_BRAND"));
  });

  test("segnala il titolo assente e la destinazione mancante", () => {
    const orphan = cards.findIndex((c) => c.rawTitle === null);
    assert.ok(codes(orphan).includes("MISSING_TITLE"));
    assert.ok(codes(orphan).includes("DESTINATION_MISSING"));
  });
});

describe("Import del catalogo", () => {
  test("crea la fonte, le proposte e le immagini", async () => {
    const { report, proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));

    assert.equal(report.cards, 9);
    assert.equal(report.created, 9);
    assert.equal(report.imagesCreated, 9);
    assert.equal(proposals.length, 9);
    assert.equal(
      proposals.reduce((sum, p) => sum + p.images.length, 0),
      9
    );

    const sources = await listCatalogSources();
    const source = sources.find((s) => s.id === report.sourceId);
    assert.ok(source, "la fonte deve esistere");
    assert.equal(source.domain, "www.mrhromaboccea.it");
    assert.equal(source.kind, "SITE_WORDPRESS");
    assert.equal(source.authority, "PRESENTATION");
    assert.ok(source.lastCrawledAt, "lastCrawledAt deve essere valorizzato");
  });

  test("ogni proposta nasce FLYER / HTML / UNVERIFIED / ACTIVE", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    for (const proposal of proposals) {
      assert.equal(proposal.sourceType, "FLYER");
      assert.equal(proposal.extraction, "HTML");
      assert.equal(proposal.confidence, "UNVERIFIED");
      assert.equal(proposal.status, "ACTIVE");
      assert.equal(proposal.sourceUpdatedAt, null, "lastmod non disponibile resta null");
    }
  });

  test("nessun campo commerciale viene inventato", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    for (const proposal of proposals) {
      assert.equal(proposal.priceFrom, null);
      assert.equal(proposal.priceTo, null);
      assert.equal(proposal.currency, null);
      assert.equal(proposal.priceNote, null);
      assert.equal(proposal.periodStart, null);
      assert.equal(proposal.periodEnd, null);
      assert.equal(proposal.departureCities, null);
      assert.equal(proposal.durationNights, null);
      assert.equal(proposal.included, null);
      assert.equal(proposal.excluded, null);
    }
  });

  test("conserva l'URL sorgente e la provenienza", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    for (const proposal of proposals) {
      assert.ok(proposal.sourceUrl.includes("catalog-test-"));
      assert.ok(proposal.contentHash.length === 64);
      assert.ok(proposal.acquiredAt instanceof Date);
      assert.ok(proposal.lastSeenAt instanceof Date);
      assert.equal(proposal.source?.authority, "PRESENTATION");
    }
  });

  test("l'immagine punta all'originale remoto, nessun file locale", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const image = proposals[0].images[0];
    assert.ok(image.url.startsWith("https://www.mrhromaboccea.it/wp-content/uploads/"));
    assert.equal(image.isOfficial, true);
    assert.equal(image.role, "FLYER");
    assert.equal(image.width, null);
    assert.equal(image.height, null);
  });

  test("l'import non duplica nulla alla seconda esecuzione", async () => {
    const pageUrl = uniqPage();
    const first = await syncOfferteCatalog({
      html: fixture("https://www.mrhromaboccea.it/"),
      pageUrl,
    });
    sourceIds.push(first.sourceId);

    const second = await syncOfferteCatalog({
      html: fixture("https://www.mrhromaboccea.it/"),
      pageUrl,
    });

    assert.equal(second.created, 0, "nessuna nuova proposta");
    assert.equal(second.updated, 0, "nessuna modifica necessaria");
    assert.equal(second.unchanged, first.cards);
    assert.equal(second.imagesCreated, 0, "nessuna nuova immagine");
    assert.equal(second.imagesExisting, first.cards);

    const count = await prisma.catalogProposal.count({
      where: { sourceId: first.sourceId },
    });
    assert.equal(count, first.cards);
  });

  test("l'hash distingue la stessa immagine con titoli diversi", () => {
    const a = offertaContentHash("Mauritius da Milano e Roma", "https://x/NY.webp");
    const b = offertaContentHash("New York Capodanno", "https://x/NY.webp");
    assert.notEqual(a, b, "titoli diversi = proposte diverse");
    assert.equal(a, offertaContentHash("Mauritius da Milano e Roma", "https://x/NY.webp"));
  });

  test("l'import non tocca confidence e status già impostati a mano", async () => {
    const { report, proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const target = proposals[0];
    await prisma.catalogProposal.update({
      where: { id: target.id },
      data: { confidence: "VERIFIED", status: "WITHDRAWN", priceFrom: 1234, currency: "EUR" },
    });

    const again = await syncOfferteCatalog({
      html: fixture("https://www.mrhromaboccea.it/"),
      pageUrl: (await prisma.catalogSource.findUniqueOrThrow({ where: { id: report.sourceId } })).pageUrl,
    });
    assert.equal(again.created, 0);

    const reloaded = await prisma.catalogProposal.findUniqueOrThrow({
      where: { id: target.id },
    });
    assert.equal(reloaded.confidence, "VERIFIED", "la verifica umana non va perduta");
    assert.equal(reloaded.status, "WITHDRAWN");
    assert.equal(reloaded.priceFrom, 1234, "i dati inseriti a mano non vengono azzerati");
  });

  test("non corregge il mismatch Mauritius / New York", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const mauritius = proposals.find((p) => /Mauritius/.test(p.name));
    assert.ok(mauritius, "la proposta Mauritius deve esistere");
    // Il sito abbina quel titolo all'immagine New York: l'import lo registra
    // com'è e non "indovina" quale dei due sia sbagliato.
    assert.equal(mauritius.name, "Mauritius da Milano e Roma");
    assert.equal(mauritius.destination, "Mauritius");
    assert.equal(mauritius.images[0].filename, "NEW-YORK-MIL-E-ROM-30-DEC.webp");
    assert.equal(mauritius.confidence, "UNVERIFIED");
  });

  test("le card che condividono l'immagine restano proposte distinte", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const condivise = proposals.filter(
      (p) => p.images[0]?.filename === "NEW-YORK-MIL-E-ROM-30-DEC.webp"
    );
    assert.equal(condivise.length, 2, "due card, due proposte");
    assert.notEqual(condivise[0].id, condivise[1].id);
    assert.equal(condivise[0].images[0].url, condivise[1].images[0].url);
  });

  test("i titoli non identificati restano visibili e non vengono scartati", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    // Le due card senza un titolo riconoscibile entrano col titolo ripulito
    // dal materiale promozionale ("Nuova Locandina 1" → "Nuova 1") e non
    // vengono scartate: restano ACTIVE e segnalate per la revisione umana.
    const ph = proposals.filter((p) => /^Nuova \d+$/.test(p.name));
    assert.equal(ph.length, 2);
    for (const proposal of ph) {
      assert.equal(proposal.status, "ACTIVE");
    }

    // Non promotabili: il titolo non combacia con l'immagine, che è uno dei
    // codici che bloccano l'uso di una proposta da parte dell'AI.
    const anomalies = anomaliesForProposals(proposals);
    for (const proposal of ph) {
      const codes = (anomalies.get(proposal.id) ?? []).map((a) => a.code);
      assert.ok(
        codes.includes("TITLE_IMAGE_MISMATCH"),
        `${proposal.name}: una locandina non identificata non è usabile`
      );
    }
  });

  test("una card sparita viene marcata, mai cancellata", async () => {
    const pageUrl = uniqPage();
    const first = await syncOfferteCatalog({
      html: fixture("https://www.mrhromaboccea.it/"),
      pageUrl,
    });
    sourceIds.push(first.sourceId);

    // Seconda lettura senza le due card non identificate e senza quella senza titolo.
    const ridotta = `<div class="locandina-grid">
      <a class="locandina-link" data-title="Cipro"
         href="https://www.mrhromaboccea.it/wp-content/uploads/2026/09/locandina_mainstream-CIPRO_page-0001.webp"></a>
    </div>`;
    const second = await syncOfferteCatalog({ html: ridotta, pageUrl });

    assert.equal(second.cards, 1);
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(second.missing, first.cards - 1);

    const total = await prisma.catalogProposal.count({
      where: { sourceId: first.sourceId },
    });
    assert.equal(total, first.cards, "nessuna cancellazione");

    const mancanti = await prisma.catalogProposal.findMany({
      where: { sourceId: first.sourceId, missingSince: { not: null } },
      include: { images: true },
    });
    assert.equal(mancanti.length, first.cards - 1);
    assert.ok(mancanti.some((p) => p.name === "Nuova 1"));
    assert.equal(mancanti[0].images.length, 1, "le immagini restano agganciate");

    // La card che c'è ancora non deve essere marcata come mancante.
    const cipro = await prisma.catalogProposal.findFirstOrThrow({
      where: { sourceId: first.sourceId, name: "Cipro" },
    });
    assert.equal(cipro.missingSince, null);
  });

  test("un import senza card fallisce invece di svuotare il catalogo", async () => {
    const vuoto = '<html><body><p>Nessuna locandina</p></body></html>';
    await assert.rejects(
      syncOfferteCatalog({ html: vuoto, pageUrl: uniqPage() }),
      /layout|card/i
    );
  });

  test("non crea Asset nella Media Library", async () => {
    const prima = await prisma.contentAsset.count();
    await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const dopo = await prisma.contentAsset.count();
    assert.equal(dopo, prima, "il catalogo non deve toccare la Media Library");
  });
});

describe("Statistiche e anomalie dal database", () => {
  test("le anomalie sono ricalcolate dai dati persistiti", async () => {
    const { proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const map = anomaliesForProposals(proposals);
    const codes = new Set(
      [...map.values()].flat().map((a) => a.code)
    );
    assert.ok(codes.has("SHARED_IMAGE"));
    assert.ok(codes.has("TITLE_IMAGE_MISMATCH"));
    assert.ok(codes.has("MISSING_TITLE"));
    assert.ok(codes.has("DESTINATION_MISSING"));
    assert.ok(
      codes.has("DISTRIBUTOR_BRAND"),
      "il marchio tolto deve essere visibile dove si legge il catalogo, non solo nell'import"
    );
  });

  test("il titolo segnaposto resta un dato, non una promessa", async () => {
    // L'import non produce più una riga con questo nome: la parola che lo
    // segnala ("locandina") è materiale promozionale e viene tolta dal titolo
    // prima che il nome diventi una proposta. La riga qui è creata come
    // arriva da una fonte che non ripulisce o da una correzione manuale, e le
    // anomalie la riconoscono lo stesso: PLACEHOLDER_TITLE si ricalcola dai
    // dati persistiti, quindi non dipende da come la riga è nata.
    const { report } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    await prisma.catalogProposal.create({
      data: {
        name: "Nuova Locandina 9",
        destination: null,
        sourceId: report.sourceId,
        sourceUrl: `${uniqPage()}#locandina-9`,
        sourceType: "FLYER",
        extraction: "HTML",
        confidence: "UNVERIFIED",
        contentHash: "hash-locandina-9",
        sourceOrder: 99,
        images: {
          create: {
            url: "https://www.mrhromaboccea.it/wp-content/uploads/2026/07/locandina-9.webp",
            filename: "locandina-9.webp",
          },
        },
      },
    });

    const solo = await prisma.catalogProposal.findFirstOrThrow({
      where: { sourceId: report.sourceId, name: "Nuova Locandina 9" },
      include: { images: true, source: true },
    });
    const codes = (anomaliesForProposals([solo]).get(solo.id) ?? []).map((a) => a.code);
    assert.ok(codes.includes("PLACEHOLDER_TITLE"));
    assert.ok(codes.includes("DESTINATION_MISSING"));
  });

  test("getCatalogStats conta proposte, immagini e fonti", async () => {
    const { report } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const stats = await getCatalogStats();
    assert.ok(stats.proposals >= report.cards);
    assert.ok(stats.images >= report.cards);
    assert.ok(stats.sources >= 1);
    assert.ok(stats.byAnomaly.length > 0);
  });

  test("listCatalogProposals filtra per stato e confidenza", async () => {
    const { report } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    const active = await listCatalogProposals({ status: "ACTIVE" });
    assert.ok(active.length > 0);
    const verified = await listCatalogProposals({ confidence: "VERIFIED" });
    const delTitolo = verified.filter(
      (p) => p.sourceId === report.sourceId
    );
    assert.equal(delTitolo.length, 0, "una fonte appena importata non ha proposte verificate");
  });

  test("il catalogo importato resta distinto per fonte", async () => {
    const { report, proposals } = await importFixture(fixture("https://www.mrhromaboccea.it/"));
    for (const proposal of proposals) {
      assert.equal(proposal.sourceId, report.sourceId);
    }
  });
});

describe("Helper di parsing esposti", () => {
  test("resolveUrl gestisce assoluti, relativi e protocol-relative", () => {
    const base = "https://esempio.it/a/b/";
    assert.equal(resolveUrl("https://x.it/y.webp", base), "https://x.it/y.webp");
    assert.equal(resolveUrl("/y.webp", base), "https://esempio.it/y.webp");
    assert.equal(resolveUrl("y.webp", base), "https://esempio.it/a/b/y.webp");
    assert.equal(resolveUrl("//x.it/y.webp", base), "https://x.it/y.webp");
    assert.equal(resolveUrl("   ", base), null);
  });

  test("decodeEntities gestisce entità nominate e numeriche", () => {
    assert.equal(decodeEntities("Libert&agrave;"), "Libertà");
    assert.equal(decodeEntities("a &amp; b"), "a & b");
    assert.equal(decodeEntities("&#65;&#x42;"), "AB");
    assert.equal(decodeEntities("&nonentity;"), "&nonentity;");
  });

  test("il tipo OfferteCard espone i campi derivati", () => {
    const card: OfferteCard = {
      name: "Cipro",
      rawTitle: "Cipro",
      imageUrl: "https://x.it/C.webp",
      filename: "C.webp",
      order: 0,
      destination: "Cipro",
    };
    assert.equal(card.destination, "Cipro");
  });
});
