import sharp from "sharp";
import { APP_FONT_STACK } from "@/lib/fonts";
import type { ParsedLocandina } from "@/lib/catalog/locandina-parse";

/**
 * Ricostruisce la locandina del fornitore come creatività dell'agenzia.
 *
 * La locandina originale (grafica + marca di terzi) non viene riusata, né
 * ritagliata, né usata come sfondo: si riparte da una foto curata della
 * destinazione e si ricompone una struttura "locandina" (titolo, banda date,
 * hotel con prezzo, footer con URL) con il marchio dell'agenzia.
 *
 * Come per i post, il testo è composto in SVG e rasterizzato da `sharp`.
 *
 * Il layout è DELIBERATAMENTE adattivo: ogni locandina del fornitore ha un
 * titolo e un numero di hotel diversi, quindi titolo e blocco hotel vengono
 * allargati/compressi in base ai dati, senza posizioni fisse che facciano
 * uscire il testo dai bordi.
 */

/** Formato ritratto 4:5, come i post immagine (feed IG/FB). */
export const LOCANDINA_WIDTH = 1080;
export const LOCANDINA_HEIGHT = 1350;

export interface LocandinaRenderInput {
  /** Fotografia curata della destinazione (sfondo a tutto campo). */
  photo: Buffer;
  /** Logo dell'agenzia, se caricato. */
  logo: { buffer: Buffer; mimeType: string } | null;
  /** Nome dell'agenzia (wordmark quando manca il logo file). */
  brandName: string | null;
  /** Sito da stampare in basso (es. "www.mrhromaboccea.it"). */
  website: string | null;
  /** Titolo in evidenza (nome della proposta). */
  title: string;
  /** Dati estratti dalla locandina (hotel, trattamento, notti, partenza…). */
  parsed: ParsedLocandina;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayUrl(website: string | null): string {
  if (!website) return "";
  const clean = website.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return clean.startsWith("www.") ? clean.toUpperCase() : `WWW.${clean.toUpperCase()}`;
}

/** Stelle come stringa (es. 3 → "★★★"). */
function starsMark(n: number): string {
  return "★".repeat(Math.max(0, Math.min(5, Math.round(n))));
}

async function svgToBuffer(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
}

/** Larghezza approssimata di una stringa a un dato corpo (stima per DejaVu Sans). */
function estimateWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

/**
 * Adatta il titolo alla larghezza disponibile: va a capo (max 2 righe) e
 * riduce il corpo se serve, così un titolo lungo come "Rodi da Milano e Roma"
 * non esce mai dal bordo destro.
 */
function fitTitle(
  title: string,
  maxWidth: number,
  maxFont: number
): { lines: string[]; fontSize: number } {
  const words = title.split(/\s+/).filter(Boolean);

  const build = (fs: number): string[] => {
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (estimateWidth(test, fs) <= maxWidth) cur = test;
      else if (!cur) cur = test; // parola singola lunghissima: la lascio intera
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  let fontSize = maxFont;
  let lines = build(fontSize);
  while (fontSize > 44) {
    if (lines.length <= 2 && lines.every((l) => estimateWidth(l, fontSize) <= maxWidth)) {
      break;
    }
    fontSize -= 4;
    lines = build(fontSize);
  }
  // Tronca a 2 righe: se proprio non ci sta, aggiunge i puntini di sospensione.
  let out = lines.slice(0, 2);
  if (out.length === 2 && lines.length > 2) {
    out[1] = out[1].slice(0, out[1].length - 1) + "…";
  }
  return { lines: out, fontSize };
}

export async function renderLocandina(input: LocandinaRenderInput): Promise<Buffer> {
  const W = LOCANDINA_WIDTH;
  const H = LOCANDINA_HEIGHT;
  const { parsed } = input;

  const url = displayUrl(input.website);

  const base = await sharp(input.photo)
    .resize(W, H, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();

  const accent = "#e5383b";
  const navy = "#0b2545";

  // --- Blocco titolo (adattivo, centrato) ---
  const titleFit = fitTitle(input.title, W - 120, 88);
  const titleFont = titleFit.fontSize;
  const lineH = titleFont + 8;
  const titleTop = titleFit.lines.length === 1 ? 150 : 134;
  const titleSvg = titleFit.lines
    .map(
      (line, i) =>
        `<text x="${W / 2}" y="${titleTop + i * lineH}" text-anchor="middle" font-size="${titleFont}" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(line)}</text>`
    )
    .join("\n");

  const subtitleY = titleTop + (titleFit.lines.length - 1) * lineH + 50;
  const pillY = subtitleY + 46;
  const pillH = 56;

  // --- Blocco hotel (adattivo al numero di righe) ---
  const maxHotels = 6;
  const hotels = parsed.hotels.slice(0, maxHotels);
  const n = Math.max(hotels.length, 1);
  const hotelsTop = pillY + pillH + 40;
  const availableH = H - 130 - hotelsTop; // spazio prima del footer
  const rowH = Math.min(128, Math.floor(availableH / n) - 16);
  const rowStep = rowH + 20;

  const hotelRows = hotels
    .map((h, i) => {
      const y = hotelsTop + i * rowStep;
      return `
        <rect x="60" y="${y}" width="960" height="${rowH}" rx="14" fill="rgba(255,255,255,0.92)"/>
        <text x="84" y="${y + 52}" font-size="40" font-weight="700" fill="#0b2545" font-family="${APP_FONT_STACK}">${esc(h.name)} ${starsMark(h.stars)}</text>
        <text x="84" y="${y + 92}" font-size="26" fill="#5a6572" font-family="${APP_FONT_STACK}">${esc(parsed.board ?? "")}${parsed.nights ? ` · ${parsed.nights} notti` : ""}</text>
        <text x="996" y="${y + 84}" text-anchor="end" font-size="46" font-weight="700" fill="${accent}" font-family="${APP_FONT_STACK}">${esc(String(h.price))} €</text>`;
    })
    .join("\n");

  const footerY = Math.min(hotelsTop + n * rowStep + 12, H - 120);

  // Scrim scuro sotto il blocco titolo/pill: altezza dinamica fino all'inizio
  // degli hotel, così il titolo resta sempre leggibile sulla foto.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="0" y="0" width="${W}" height="${hotelsTop - 10}" fill="rgba(0,0,0,0.5)"/>
    ${titleSvg}
    ${parsed.departure ? `<text x="${W / 2}" y="${subtitleY}" text-anchor="middle" font-size="32" fill="#e8eef5" font-family="${APP_FONT_STACK}">Voli diretti da ${esc(parsed.departure)}</text>` : ""}
    <rect x="${W / 2 - 230}" y="${pillY}" width="460" height="${pillH}" rx="${pillH / 2}" fill="${accent}"/>
    <text x="${W / 2}" y="${pillY + pillH / 2 + 11}" text-anchor="middle" font-size="32" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(parsed.board ?? "Offerta speciale")}</text>
    ${hotelRows}
    <rect x="0" y="${footerY}" width="${W}" height="${H - footerY}" fill="rgba(0,0,0,0.5)"/>
    <rect x="0" y="${H - 110}" width="${W}" height="110" fill="${navy}"/>
    <text x="${W / 2}" y="${H - 42}" text-anchor="middle" font-size="36" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(url)}</text>
  </svg>`;

  const svgBuf = await svgToBuffer(svg);

  // Tutti gli overlay vanno in un UNICO `.composite()`: catenare più chiamate
  // `.composite()` sullo stesso pipeline fa perdere gli strati precedenti
  // (libreria con base PNG + alpha), producendo un output foto+logo senza testo.
  const overlays: { input: Buffer; top: number; left: number }[] = [
    { input: svgBuf, top: 0, left: 0 },
  ];

  if (input.logo && input.logo.buffer.length > 0) {
    const logo = await sharp(input.logo.buffer)
      .resize({ height: 72, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    overlays.push({ input: logo, top: 48, left: 56 });
  } else if (input.brandName) {
    const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <text x="56" y="96" font-size="44" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(input.brandName)}</text>
    </svg>`;
    overlays.push({ input: await svgToBuffer(wordmark), top: 0, left: 0 });
  }

  return sharp(base).composite(overlays).png().toBuffer();
}
