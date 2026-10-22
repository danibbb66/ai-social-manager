export interface VideoSlide {
  imagePath: string;
  durationSec?: number;
  title?: string;
}

export interface GeneratedVideo {
  url: string;
  provider: string;
  pathname: string;
  durationSec: number;
}

export interface VideoOptions {
  width?: number;
  height?: number;
  fps?: number;
  /**
   * Percorso (assoluto o `/uploads/...`) di una traccia audio da miscelare
   * come musica di sottofondo. `null`/assente = video senza audio, e la
   * generazione degrada in modo sicuro senza errori.
   */
  audioPath?: string | null;
  /**
   * Volume della musica di sottofondo (0..1). Default del provider: 0.2.
   */
  audioVolume?: number;
}

export class VideoGenerationUnavailableError extends Error {
  constructor(message = "Generazione video non disponibile") {
    super(message);
    this.name = "VideoGenerationUnavailableError";
  }
}

/**
 * Una clip del montaggio: un VERO file video (estratto/tagliato) o, come
 * ripiego dichiarato, un'immagine animata (Ken Burns) quando di video veri
 * non ce ne sono abbastanza.
 */
export interface MontageClip {
  /** Percorso assoluto del file sorgente su disco. */
  path: string;
  type: "video" | "image";
  /** Solo clip video: punto di partenza del taglio in secondi (default 0). */
  trimStartSec?: number;
  /** Durata della scena montata, in secondi. */
  sceneSeconds: number;
  /**
   * Sovrapposizione titolo+logo: SOLO sulla clip copertina. Le clip
   * successive arrivano senza overlay, qualunque cosa contengano.
   */
  overlay?: {
    title: string;
    logoPath?: string | null;
  } | null;
}

/**
 * Astrazione del provider video.
 * Oggi: montaggio locale via ffmpeg (clip video reali + scene di fallback).
 */
export interface VideoProvider {
  readonly name: string;
  readonly canGenerate: boolean;
  /**
   * Disponibilità reale sul sistema (binario presente e avviabile). Opzionale:
   * i provider che non possono saperlo a priori la lasciano non definita.
   */
  readonly isAvailable?: () => Promise<boolean>;
  /** Fallback a immagini: slideshow con Ken Burns. */
  generateSlideshow(
    slides: VideoSlide[],
    options?: VideoOptions
  ): Promise<GeneratedVideo>;
  /**
   * Vero montaggio: clip video reali tagliate (-ss/-t), normalizzate e
   * concatenate, con overlay solo sulla clip copertina. Opzionale: i
   * doppioni di test e i provider che non lo supportano possono ometterlo,
   * e il servizio ricade sullo slideshow a immagini.
   */
  generateMontage?(
    clips: MontageClip[],
    options?: VideoOptions
  ): Promise<GeneratedVideo>;
}