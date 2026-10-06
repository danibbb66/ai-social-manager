import sharp from "sharp";
import { renderSocialCreative } from "../src/lib/images/social-creative";
import { editorialPoints } from "../src/lib/ai/editorial-matrix";
import { curatedDestinations } from "../src/lib/ai/travel-knowledge";
import type { CommercialExtraction } from "../src/lib/catalog/commercial-extraction";

function extraction(over: Partial<CommercialExtraction> = {}): CommercialExtraction {
  return {
    proposalId: "proposta-prova-0001",
    destination: "Venezia",
    title: "Venezia",
    price: 890,
    priceTo: 1290,
    currency: "EUR",
    departureCity: "Milano",
    departureDate: "2026-09-12",
    returnDate: "2026-09-19",
    duration: "7 notti",
    accommodation: "hotel 4 stelle",
    board: "mezza pensione",
    transport: "volo incluso",
    sourceImageUrl: "https://example.test/locandina.jpg",
    sourceImageId: null,
    sourceImageFilename: "locandina.jpg",
    extractionMethod: "catalog-record",
    extractedFields: [],
    confidence: 0.3,
    warnings: [],
    ...over,
  };
}

async function main() {
  const photo = await sharp({
    create: { width: 1080, height: 1080, channels: 3, background: "#2b6a8f" },
  })
    .jpeg()
    .toBuffer();

  let failures = 0;
  for (const format of ["TRAVEL_TIPS", "ITINERARY"] as const) {
    for (const place of curatedDestinations()) {
      const points = editorialPoints(format, place);
      const rendered = await renderSocialCreative({
        photo,
        title: place,
        subtitle: null,
        kicker: format === "TRAVEL_TIPS" ? "Consigli di viaggio" : "Itinerario",
        points,
        extraction: extraction({ destination: place, title: place }),
        brandName: "Agenzia di Viaggi",
      });
      if (rendered.printedPoints.length !== points.length) {
        failures += 1;
        console.log(
          `${format} ${place}: richiesti ${points.length}, stampati ${rendered.printedPoints.length}, commerciali ${rendered.commercialLines.length}`
        );
      }
    }
  }

  const long = [
    "Le spiagge di Ses Salines e del Trocadero si raggiungono solo a piedi o in bici: nel parco naturale le auto non entrano e la pista attraversa le saline per quattro chilometri.",
    "Il faro di Capo de Creus si raggiunge con una strada sterrata di circa quattro chilometri, e gli ultimi due si fanno a piedi.",
    "In estate le escursioni vanno all'alba o al tramonto: le piste non hanno ombra e il sole sulle piste bianche è insostenibile.",
  ];
  const rendered = await renderSocialCreative({
    photo,
    title: "Formentera",
    subtitle: null,
    kicker: "Consigli di viaggio",
    points: long,
    extraction: extraction(),
    brandName: "Agenzia di Viaggi",
  });
  console.log(
    "caso estremo: richiesti", long.length, "stampati", rendered.printedPoints.length,
    "| commerciali", rendered.commercialLines.length
  );
  for (const p of rendered.printedPoints) console.log("   >", p);
  if (rendered.printedPoints.length !== long.length) failures += 1;

  console.log("fallimenti totali:", failures);
}

main();