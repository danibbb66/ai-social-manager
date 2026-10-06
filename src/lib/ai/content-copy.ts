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
import { placeNameFrom } from "@/lib/ai/place-name";
import {
  NO_FACTS,
  editorialCaption,
  editorialTitle,
  isGenericTitle,
  titleNamesPlace,
} from "@/lib/ai/editorial-matrix";

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

/**
 * Completa i campi mancanti a partire dal topic vincolante.
 *
 * Non riscrive mai un campo già valorizzato: restituisce null per quelli
 * lasciati intatti. Titolo e caption vengono dalla matrice editoriale, quindi
 * rispettano le stesse regole del flusso di catalogo: il titolo nomina sempre
 * il luogo e non contiene mai una formula generica, e la caption ha la
 * struttura del formato.
 *
 * Il topic è l'unica fonte: è il nome del luogo più qualche parola della
 * richiesta ("proposta Calabria"). Non c'è nessun dato commerciale, quindi la
 * matrice lavora con `NO_FACTS` e non può inventare prezzi, date o durate.
 * Resta una bozza da rifinire a mano.
 */
export function fallbackCopyFromTopic(input: {
  topic: string;
  /** Formato editoriale: decide la struttura di titolo e caption. */
  format?: string | null;
  /** Destinazione esplicita, se il modello l'ha passata. */
  destination?: string | null;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
}): CopyFallback {
  const topic = input.topic.trim();
  // Il luogo viene dalla destinazione esplicita quando c'è, altrimenti si
  // ricava dal topic tolcendone le formule di richiesta ("proposta Calabria" →
  // "Calabria"). Senza un nome di luogo non c'è un titolo possibile: restare
  // senza testo è preferibile a stampare "proposta di viaggio".
  const place = placeNameFrom(input.destination, topic, input.title);
  const format = (input.format ?? "").trim().toUpperCase() || "HERO_DESTINATION";

  let title = place ? editorialTitle(format, place, NO_FACTS) : null;
  // Difesa finale: un titolo che non nomina il luogo, o che è una delle formule
  // bandite, non è un titolo ammissibile. Il nome del luogo è l'unico titolo che
  // non può mai sbagliare, quindi si ripiega su quello.
  if (title && (!titleNamesPlace(title, place) || isGenericTitle(title))) title = place;

  return {
    title: input.title && input.title.trim() ? null : title,
    caption:
      input.caption && input.caption.trim()
        ? null
        : place
          ? editorialCaption(format, place, NO_FACTS)
          : null,
    hashtags:
      input.hashtags && input.hashtags.trim() ? null : hashtagsFromTopic(topic),
  };
}
