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

  const hotelRows = parsed.hotels
    .map((h, i) => {
      const y = 470 + i * 150;
      return `
        <rect x="60" y="${y}" width="960" height="128" rx="14" fill="rgba(255,255,255,0.92)"/>
        <text x="84" y="${y + 54}" font-size="40" font-weight="700" fill="#0b2545" font-family="${APP_FONT_STACK}">${esc(h.name)} ${starsMark(h.stars)}</text>
        <text x="84" y="${y + 96}" font-size="26" fill="#5a6572" font-family="${APP_FONT_STACK}">${esc(parsed.board ?? "")}${parsed.nights ? ` · ${parsed.nights} notti` : ""}</text>
        <text x="996" y="${y + 88}" text-anchor="end" font-size="46" font-weight="700" fill="${accent}" font-family="${APP_FONT_STACK}">${esc(String(h.price))} €</text>`;
    })
    .join("\n");

  const footerY = 470 + Math.max(parsed.hotels.length, 1) * 150 + 20;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect x="0" y="0" width="${W}" height="360" fill="rgba(0,0,0,0.45)"/>
    <text x="72" y="150" font-size="88" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(input.title)}</text>
    ${parsed.departure ? `<text x="72" y="205" font-size="34" fill="#ffffff" font-family="${APP_FONT_STACK}">Voli diretti da ${esc(parsed.departure)}</text>` : ""}
    <rect x="72" y="245" width="460" height="64" rx="32" fill="${accent}"/>
    <text x="302" y="288" text-anchor="middle" font-size="34" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(parsed.board ?? "Offerta speciale")}</text>
    ${hotelRows}
    <rect x="0" y="${footerY}" width="${W}" height="${H - footerY}" fill="rgba(0,0,0,0.45)"/>
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
      .resize({ height: 84, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    overlays.push({ input: logo, top: 40, left: 72 });
  } else if (input.brandName) {
    const wordmark = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <text x="72" y="92" font-size="48" font-weight="700" fill="#ffffff" font-family="${APP_FONT_STACK}">${esc(input.brandName)}</text>
    </svg>`;
    overlays.push({ input: await svgToBuffer(wordmark), top: 0, left: 0 });
  }

  return sharp(base).composite(overlays).png().toBuffer();
}
