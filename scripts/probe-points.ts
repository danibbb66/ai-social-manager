import { knowledgeFor, curatedDestinations, MAX_TRAVEL_POINTS } from "../src/lib/ai/travel-knowledge";
import { editorialPoints } from "../src/lib/ai/editorial-matrix";

const places = curatedDestinations();
console.log("destinazioni:", places.length, "MAX:", MAX_TRAVEL_POINTS);
for (const place of places) {
  const k = knowledgeFor(place)!;
  const tips = editorialPoints("TRAVEL_TIPS", place);
  const stops = editorialPoints("ITINERARY", place);
  const flag = tips.length !== 3 || stops.length !== 3 ? "  <<< NON 3" : "";
  const maxTip = Math.max(...tips.map((t) => t.length));
  const maxStop = Math.max(...stops.map((t) => t.length));
  console.log(
    `${place.padEnd(22)} tips=${k.tips.length} stops=${k.stops.length} | TRAVEL_TIPS=${tips.length} (max ${maxTip} ch) ITINERARY=${stops.length} (max ${maxStop} ch)${flag}`
  );
  for (const t of tips) if (t.length > 165) console.log(`    TIP LUNGO (${t.length}): ${t}`);
  for (const s of stops) if (s.length > 165) console.log(`    STOP LUNGO (${s.length}): ${s}`);
}

for (const alias of ["Rodi Grecia", "rodi grecia", "Rodi", "rodi", "RHODES", "Isola d'Elba", "Elba"]) {
  const k = knowledgeFor(alias);
  console.log(`alias "${alias}" -> ${k ? (k.tips[0] ?? "?").slice(0, 40) : "NULL"}`);
}