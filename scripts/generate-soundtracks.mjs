/**
 * Genera più colonne sonore royalty-free (composte in casa: nessuna fonte
 * esterna né copyright) in stile "vivace e luminoso", ognuna con chiave,
 * progressione armonica e tempo diversi, così il video non usa sempre la
 * stessa traccia.
 *
 * Produce WAV PCM 16-bit stereo a 44.1 kHz: una base costruita con
 * oscillatori sinusoidali (pad brillante + basso ritmico in ottavi + arpeggio
 * alto "sparkle") e inviluppi morbidi, senza campioni né file di terze parti.
 *
 * Uso:
 *   node scripts/generate-soundtracks.mjs
 * Output: public/audio/soundtrack-<nome>.wav
 *
 * I WAV vengono poi codificati in AAC (.m4a) con ffmpeg per ridurne il peso.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Gradi della scala (offset in semitoni dal tonico) e qualità della triade.
const DEGREES = {
  I: { off: 0, thirds: [0, 4, 7] },
  ii: { off: 2, thirds: [0, 3, 7] },
  iii: { off: 4, thirds: [0, 3, 7] },
  IV: { off: 5, thirds: [0, 4, 7] },
  V: { off: 7, thirds: [0, 4, 7] },
  vi: { off: 9, thirds: [0, 3, 7] },
};

function chord(tonicMidi, symbol) {
  const d = DEGREES[symbol];
  const root = tonicMidi + d.off;
  const triad = d.thirds.map((s) => midi(root + s));
  return {
    bass: midi(root - 24),
    triad,
    sparkle: [triad[0] * 2, triad[1] * 2, triad[2] * 2, triad[0] * 4],
  };
}

// Preset: chiave (tonico MIDI), progressione, durata accordo (s), ripetizioni
// della progressione, energia (scala la brillantezza dell'arpeggio/basso).
const PRESETS = [
  { name: "uplifting", tonic: 62, loop: ["I", "V", "vi", "IV"], bar: 1.7, loops: 5, energy: 1.15 },
  { name: "sunny", tonic: 55, loop: ["I", "V", "vi", "IV"], bar: 2.0, loops: 4, energy: 1.0 },
  { name: "breeze", tonic: 53, loop: ["vi", "IV", "I", "V"], bar: 2.3, loops: 4, energy: 0.8 },
  { name: "wonder", tonic: 57, loop: ["I", "vi", "IV", "V"], bar: 1.9, loops: 4, energy: 1.0 },
  // Preset aggiuntivi: più varietà di chiave/tempo, leggermente più vivaci.
  { name: "vibrant", tonic: 64, loop: ["I", "vi", "IV", "V"], bar: 1.6, loops: 5, energy: 1.3 },
  { name: "spark", tonic: 59, loop: ["I", "IV", "vi", "V"], bar: 1.5, loops: 5, energy: 1.35 },
  { name: "horizon", tonic: 54, loop: ["vi", "I", "IV", "V"], bar: 1.8, loops: 4, energy: 1.12 },
  { name: "pulse", tonic: 51, loop: ["I", "V", "vi", "IV"], bar: 1.4, loops: 5, energy: 1.28 },
  // Nuovi preset più euforici e ritmici per i video social travel: maggiore,
  // accordi più brevi e tonica più alta = sound luminoso e "spinto".
  { name: "sunrise", tonic: 62, loop: ["I", "V", "vi", "IV"], bar: 1.3, loops: 6, energy: 1.4 },
  { name: "island", tonic: 60, loop: ["I", "IV", "I", "V"], bar: 1.4, loops: 5, energy: 1.35 },
  { name: "roadtrip", tonic: 57, loop: ["I", "vi", "IV", "V"], bar: 1.3, loops: 6, energy: 1.45 },
  { name: "celebration", tonic: 64, loop: ["I", "V", "IV", "V"], bar: 1.2, loops: 6, energy: 1.5 },
  { name: "goldenhour", tonic: 59, loop: ["I", "IV", "vi", "V"], bar: 1.5, loops: 5, energy: 1.3 },
];

// --- inviluppo per evitare click (attack/decay lineare) ---
function envelope(t, attack, release, total) {
  let a = 1;
  if (t < attack) a = t / attack;
  const remaining = total - t;
  if (remaining < release) a = Math.min(a, remaining / release);
  return a;
}

function synth(preset) {
  const BAR_SEC = preset.bar;
  const progression = [];
  for (let r = 0; r < preset.loops; r++) {
    progression.push(...preset.loop);
  }
  const TOTAL = progression.length * BAR_SEC;
  const left = new Float64Array(Math.floor(TOTAL * SR));
  const right = new Float64Array(Math.floor(TOTAL * SR));

  progression.forEach((symbol, barIndex) => {
    const c = chord(preset.tonic, symbol);
    const barStart = barIndex * BAR_SEC;

    // Pad luminoso: triade con panorama leggero.
    for (const [j, f] of c.triad.entries()) {
      const start = barStart * SR;
      const end = (barStart + BAR_SEC) * SR;
      const pan = j % 2 === 0 ? 0.06 : -0.06;
      for (let i = start; i < end; i++) {
        const tSec = i / SR - barStart;
        const env = envelope(tSec, 0.3, 0.6, BAR_SEC);
        const wl = 2 * Math.PI * f * (i / SR);
        const wr = 2 * Math.PI * f * 1.002 * (i / SR);
        left[i] += Math.sin(wl) * env * 0.09 * (1 + pan);
        right[i] += Math.sin(wr) * env * 0.09 * (1 - pan);
      }
    }

    // Basso ritmico in ottavi (radice + quinta).
    const bassNotes = [c.bass, c.bass * 1.5];
    for (let k = 0; k < 8; k++) {
      const f = bassNotes[k % 2];
      const noteStart = barStart + k * (BAR_SEC / 8);
      const noteDur = (BAR_SEC / 8) * 0.7;
      const start = Math.floor(noteStart * SR);
      const end = Math.min(Math.floor((noteStart + noteDur) * SR), left.length);
      for (let i = start; i < end; i++) {
        const tSec = i / SR - noteStart;
        const env = envelope(tSec, 0.01, 0.12, noteDur);
        const w = 2 * Math.PI * f * (i / SR);
        const v = Math.sin(w) * env * 0.15 * preset.energy;
        left[i] += v;
        right[i] += v;
      }
    }

    // Arpeggio alto "sparkle" in sedicesimi.
    for (let k = 0; k < 16; k++) {
      const f = c.sparkle[k % c.sparkle.length];
      const noteStart = barStart + k * (BAR_SEC / 16);
      const noteDur = (BAR_SEC / 16) * 0.8;
      const start = Math.floor(noteStart * SR);
      const end = Math.min(Math.floor((noteStart + noteDur) * SR), left.length);
      const pan = k % 2 === 0 ? 0.07 : -0.07;
      for (let i = start; i < end; i++) {
        const tSec = i / SR - noteStart;
        const env = envelope(tSec, 0.005, 0.25, noteDur);
        const w = 2 * Math.PI * f * (i / SR);
        const v = Math.sin(w) * env * 0.08 * preset.energy;
        left[i] += v * (1 + pan);
        right[i] += v * (1 - pan);
      }
    }
  });

  // Dissolvenza globale in ingresso/uscita (loop pulito, nessun click).
  const fade = Math.floor(1.0 * SR);
  for (let i = 0; i < fade && i < left.length; i++) {
    const g = i / fade;
    left[i] *= g;
    right[i] *= g;
  }
  for (let i = 0; i < fade; i++) {
    const idx = left.length - 1 - i;
    if (idx < 0) break;
    const g = i / fade;
    left[idx] *= g;
    right[idx] *= g;
  }

  return { left, right, totalSec: TOTAL };
}

function writeWav(outPath, preset) {
  const { left, right, totalSec } = synth(preset);
  const n = left.length;
  const buffer = Buffer.alloc(44 + n * 4);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(n * 4, 40);

  let off = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buffer.writeInt16LE(Math.round(l * 32767), off);
    buffer.writeInt16LE(Math.round(r * 32767), off + 2);
    off += 4;
  }

  writeFileSync(outPath, buffer);
  console.log(`[soundtrack] scritto ${outPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MiB, ${totalSec.toFixed(0)}s)`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
for (const p of PRESETS) {
  const out = path.resolve(here, "..", "public", "audio", `soundtrack-${p.name}.wav`);
  writeWav(out, p);
}
