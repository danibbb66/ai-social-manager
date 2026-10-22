/**
 * Genera la colonna sonora di default dei video (royalty-free, composta in
 * casa, nessuna fonte esterna né copyright).
 *
 * Produce un WAV PCM 16-bit stereo a 44.1 kHz: una base VIVACE e luminosa
 * (pad brillante + basso ritmico in ottavi + arpeggio alto "sparkle") costruita
 * con oscillatori sinusoidali e inviluppi morbidi, senza campioni né file di
 * terze parti. Progressione pop C → G → Am → F, ripetuta.
 *
 * Uso:
 *   node scripts/generate-default-soundtrack.mjs [percorso-output]
 * Default output: public/audio/default-soundtrack.wav
 *
 * Il file viene poi codificato in AAC (.m4a) con ffmpeg per ridurne il peso.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const BAR_SEC = 2.0; // durata di un accordo: tempo più vivace del precedente

// Accordi: triade (pad luminoso) e note alte per l'arpeggio "sparkle".
const CHORD_LIB = {
  C: { bass: 65.41, triad: [261.63, 329.63, 392.0], sparkle: [523.25, 659.25, 783.99, 1046.5] },
  G: { bass: 49.0, triad: [246.94, 293.66, 392.0], sparkle: [493.88, 587.33, 783.99, 987.77] },
  Am: { bass: 55.0, triad: [220.0, 261.63, 329.63], sparkle: [440.0, 523.25, 659.25, 880.0] },
  F: { bass: 43.65, triad: [174.61, 220.0, 261.63], sparkle: [349.23, 440.0, 523.25, 698.46] },
};

// Progressione "pop" brillante C → G → Am → F, ripetuta (16 accordi = 32s).
const LOOP = ["C", "G", "Am", "F"];
const PROGRESSION = [...LOOP, ...LOOP, ...LOOP, ...LOOP];

const TOTAL = PROGRESSION.length * BAR_SEC;

// --- inviluppo per evitare click (attack/decay lineare) ---
function envelope(t, attack, release, total) {
  let a = 1;
  if (t < attack) a = t / attack;
  const remaining = total - t;
  if (remaining < release) a = Math.min(a, remaining / release);
  return a;
}

function synth() {
  const left = new Float64Array(Math.floor(TOTAL * SR));
  const right = new Float64Array(Math.floor(TOTAL * SR));

  PROGRESSION.forEach((name, barIndex) => {
    const chord = CHORD_LIB[name];
    const barStart = barIndex * BAR_SEC;

    // Pad luminoso: la triade con attacco più rapido (più "presente" e
    // allegro, meno sognante), leggermente panoramizzato tra L/R.
    for (const [j, f] of chord.triad.entries()) {
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

    // Basso ritmico in ottavi (radice + quinta): dà la pulsazione "allegra".
    const bassNotes = [chord.bass, chord.bass * 1.5];
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
        const v = Math.sin(w) * env * 0.15;
        left[i] += v;
        right[i] += v;
      }
    }

    // Arpeggio alto "sparkle" in sedicesimi: brillantezza e movimento.
    for (let k = 0; k < 16; k++) {
      const f = chord.sparkle[k % chord.sparkle.length];
      const noteStart = barStart + k * (BAR_SEC / 16);
      const noteDur = (BAR_SEC / 16) * 0.8;
      const start = Math.floor(noteStart * SR);
      const end = Math.min(Math.floor((noteStart + noteDur) * SR), left.length);
      const pan = k % 2 === 0 ? 0.07 : -0.07; // alternanza stereo
      for (let i = start; i < end; i++) {
        const tSec = i / SR - noteStart;
        const env = envelope(tSec, 0.005, 0.25, noteDur);
        const w = 2 * Math.PI * f * (i / SR);
        const v = Math.sin(w) * env * 0.08;
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

  return { left, right };
}

function writeWav(outPath) {
  const { left, right } = synth();
  const n = left.length;
  const buffer = Buffer.alloc(44 + n * 4);

  // Header RIFF/WAVE (PCM 16-bit stereo)
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(2, 22); // canali
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * 4, 28); // byte rate
  buffer.writeUInt16LE(4, 32); // block align
  buffer.writeUInt16LE(16, 34); // bit depth
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
  console.log(`[soundtrack] scritto ${outPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MiB, ${TOTAL.toFixed(0)}s)`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultOut = path.join(here, "..", "public", "audio", "default-soundtrack.wav");
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(defaultOut);
writeWav(out);
