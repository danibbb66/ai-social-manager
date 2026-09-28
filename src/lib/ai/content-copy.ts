/**
 * Helper di copy per i tool AI.
 *
 * Nessuna chiamata al modello: sono funzioni pure e deterministiche, così il
 * contenuto creato non dipende dalla disponibilità di Ollama e non può
 * "scivolare" verso un argomento diverso da quello richiesto. Quando il
 * modello fornisce già caption e hashtag (caso normale) questi helper non
 * vengono usati.
 */

/** Normalizza gli hashtag: solo token validi, univoci, prefissati con #. */
export function cleanHashtags(raw: string): string {
  const words = raw
    .split(/[\s,;]+/)
    .map((w) => w.trim().replace(/^#+/, ""))
    .filter((w) => /^[a-zA-Zà-ÿ0-9_]+$/.test(w))
    .map((w) => `#${w.toLowerCase()}`);
  return Array.from(new Set(words)).join(" ").trim();
}

/** Parole da scartare quando si ricavano gli hashtag dal topic. */
const STOP_WORDS = new Set([
  "proposta",
  "proposta_di",
  "viaggio",
  "viaggi",
  "destinazione",
  "per",
  "una",
  "uno",
  "il",
  "la",
  "del",
  "della",
  "con",
  "su",
  "in",
  "a",
  "di",
  "e",
]);

/**
 * Hashtag derivati dal topic richiesto.
 * Il topic è la fonte: nessun'altra destinazione può entrare.
 */
export function hashtagsFromTopic(topic: string, limit = 8): string {
  const words = topic
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
  const unique = Array.from(new Set(words)).slice(0, limit);
  return unique.map((w) => `#${w}`).join(" ");
}

export type CopyFallback = {
  caption: string | null;
  hashtags: string | null;
  title: string | null;
};

/** Maiuscola iniziale, senza toccare il resto del testo. */
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Etichetta breve del topic, tagliata su un confine di parola. */
function topicLabel(topic: string, max = 52): string {
  const text = topic.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > max / 2 ? cut.slice(0, boundary) : cut).trim();
}

/** Suffissi del titolo: solo tono editoriale, nessun fatto commerciale. */
const TITLE_SUFFIXES = [
  "la nostra proposta",
  "proposta di viaggio",
  "da vivere con calma",
];

/**
 * Impianti di caption alternativi, per non produrre a ogni contenuto la stessa
 * cadenza. Sono deliberatamente agnostici: non nominano località, prezzi,
 * date, strutture o servizi, quindi non possono inventare informazioni che
 * l'utente non ha fornito.
 */
const CAPTION_TEMPLATES = [
  (label: string) =>
    `${label}: da vivere con calma, tra dettagli e atmosfera, senza fretta. ✨`,
  (label: string) =>
    `${label}: un itinerario costruito con cura, dove ogni tappa ha il suo tempo. ✨`,
  (label: string) =>
    `${label}: da scoprire passo dopo passo, con il tempo giusto per godersi il viaggio. ✨`,
];

/** Scelta stabile: stesso topic, stesso testo, sempre. */
function variantIndex(topic: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < topic.length; i += 1) hash = (hash + topic.charCodeAt(i)) % size;
  return hash;
}

/**
 * Completa i campi mancanti a partire dal topic vincolante.
 *
 * Non riscrive mai un campo già valorizzato: restituisce null per quelli
 * lasciati intatti. Titolo e caption restano distinti e il testo non è una
 * ripetizione del topic, ma resta comunque una bozza da rifinire a mano.
 */
export function fallbackCopyFromTopic(input: {
  topic: string;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
}): CopyFallback {
  const topic = input.topic.trim();
  const label = topic ? sentenceCase(topicLabel(topic)) : "";
  const variant = label ? variantIndex(topic, CAPTION_TEMPLATES.length) : 0;

  return {
    title:
      input.title && input.title.trim()
        ? null
        : label
          ? `${label} — ${TITLE_SUFFIXES[variant]}`
          : null,
    caption:
      input.caption && input.caption.trim()
        ? null
        : label
          ? CAPTION_TEMPLATES[variant](label)
          : null,
    hashtags:
      input.hashtags && input.hashtags.trim() ? null : hashtagsFromTopic(topic),
  };
}
