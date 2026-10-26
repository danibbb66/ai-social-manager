import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { uniqueFilename } from "@/lib/utils";
import {
  GeneratedVideo,
  MontageClip,
  VideoGenerationUnavailableError,
  VideoOptions,
  VideoProvider,
  VideoSlide,
} from "@/lib/video/provider";
import { logAIError } from "@/lib/logger";
import sharp from "sharp";
import { accentForTitle } from "@/lib/images/social-creative";
import ffmpegStatic from "ffmpeg-static";
import { path as ffprobeStaticPath } from "ffprobe-static";
import { materialize, outputDirFor, publishOutput } from "@/lib/storage";
import { APP_FONT_STACK } from "@/lib/fonts";

/**
 * Percorsi candidati espliciti, oltre al comando di sistema.
 *
 * Solo `FFMPEG_PATH`: un override esplicito dell'ambiente vince sempre. Niente
 * percorsi hardcoded legati a una macchina o a un profilo utente (WinGet,
 * C:\ffmpeg, /usr/bin): su Windows e POSIX il comando "ffmpeg" viene già
 * risolto dal PATH di sistema, che è la fonte configurata e verificata
 * dall'amministratore della macchina.
 */
const KNOWN_PATHS: string[] = [process.env.FFMPEG_PATH ?? ""].filter(Boolean);

/**
 * Percorso ffmpeg risolto l'ultima volta.
 *
 * La risoluzione costa un giro di `fs.access` per ogni candidato: si fa una
 * volta per processo e il risultato vale per tutte le generazioni successive.
 */
let resolvedFfmpegPath: string | null = null;

async function executableExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Risolve l'eseguibile ffmpeg.
 *
 * 1. `FFMPEG_PATH` esplicito, se il file esiste davvero;
 * 2. altrimenti il comando di sistema "ffmpeg": è lo spawn a risolverlo nel
 *    PATH di sistema (Windows incluso), che è la configurazione ufficiale.
 *    Un percorso hardcodato che smette di esistere (aggiornamento WinGet,
 *    altro profilo utente) non deve potere rompere la generazione quando il
 *    PATH funziona.
 */
export async function resolveFfmpegPath(): Promise<string> {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  for (const p of KNOWN_PATHS) {
    if (await executableExists(p)) {
      resolvedFfmpegPath = p;
      console.log(`[ffmpeg] eseguibile risolto da FFMPEG_PATH: ${p}`);
      return p;
    }
  }
  // Binario statico incluso via `ffmpeg-static`: disponibile anche dove ffmpeg
  // non è installato nel sistema (es. serverless Vercel).
  if (ffmpegStatic && (await executableExists(ffmpegStatic))) {
    resolvedFfmpegPath = ffmpegStatic;
    console.log(`[ffmpeg] eseguibile risolto dal binario statico incluso: ${ffmpegStatic}`);
    return ffmpegStatic;
  }
  resolvedFfmpegPath = "ffmpeg";
  console.log("[ffmpeg] uso il comando di sistema \"ffmpeg\" (risolto dal PATH)");
  return resolvedFfmpegPath;
}

/**
 * Converte un percorso di media in un percorso assoluto sul disco.
 *
 * ffmpeg non deve dipendere dalla working directory del processo server: un
 * URL dell'app ("/uploads/images/x.jpg") diventa un percorso assoluto sotto
 * `<root>/public`, un percorso già assoluto resta tale, un percorso relativo
 * viene ancorato alla root del progetto.
 *
 * L'URL dell'app va riconosciuto PRIMA di `path.isAbsolute`: su Windows
 * "/uploads/x" è tecnicamente un percorso radicato (risolto sulla radice del
 * drive, cioè C:\uploads\x — dove non c'è niente) e il check restituirebbe
 * il percorso così com'è, con ffmpeg che non trova il file.
 */
export function toAbsoluteMediaPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  if (normalized.startsWith("/uploads/")) {
    return path.join(process.cwd(), "public", normalized);
  }
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

/**
 * Risolve ffprobe: sibling della directory di ffmpeg risolta, altrimenti il
 * comando di sistema (stessa logica del PATH che risolve ffmpeg).
 */
export async function resolveFfprobePath(): Promise<string> {
  const ffmpeg = await resolveFfmpegPath();
  if (ffmpeg !== "ffmpeg") {
    const ext = path.extname(ffmpeg);
    const probe = path.join(path.dirname(ffmpeg), `ffprobe${ext}`);
    if (await executableExists(probe)) return probe;
  }
  // Binario statico ffprobe incluso (`ffprobe-static`): stesso contesto del
  // fallback ffmpeg-static, per gli ambienti senza ffprobe di sistema.
  if (await executableExists(ffprobeStaticPath)) return ffprobeStaticPath;
  return "ffprobe";
}

/**
 * Durata reale di un file video, in secondi (ffprobe).
 *
 * Serve a pianificare i tagli senza mai chiedere a ffmpeg un segmento oltre
 * la fine del sorgente. Un probe fallito non è un errore: si assume una
 * durata minima (un solo taglio da 3s da 0) e si prosegue.
 */
export async function probeVideoDurationSec(filePath: string): Promise<number | null> {
  try {
    const stdout = await runCapturing(await resolveFfprobePath(), [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (e) {
    logAIError("ffprobe.duration", { filePath }, e);
    return null;
  }
}

/**
 * ffmpeg è utilizzabile adesso?
 *
 * Verifica economica se il percorso è già risolto; altrimenti prova il
 * binario nel PATH con `-version`, che non tocca nessun file.
 */
export async function isVideoGenerationAvailable(): Promise<boolean> {
  const resolved = await resolveFfmpegPath();
  if (resolved !== "ffmpeg") return true;
  try {
    await runFfmpeg(["-version"], "ffmpeg");
    return true;
  } catch {
    return false;
  }
}

/**
 * Runner generico con cattura dello stdout (per ffprobe) e la stessa
 * diagnostica di runFfmpeg: stderr intero nel terminale su qualsiasi
 * uscita non zero.
 */
function runCapturing(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      console.error(`[ffmpeg] errore di avvio di "${executable}":`, err);
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      console.error(`[ffmpeg] "${executable}" uscita ${code}: ${stderr.slice(-2000)}`);
      reject(new Error(`${executable} terminato con codice ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function runFfmpeg(args: string[], executable?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable ?? "ffmpeg", args, { windowsHide: true });
    // Tetto alto ma non infinito: lo stderr di ffmpeg su un input rotto può
    // essere lunghissimo. Serve intero nel terminale (chi diagnosticca legge
    // il log, non l'eccezione), non solo gli ultimi 500 caratteri.
    let stderr = "";
    child.stderr.on("data", (d) => {
      const chunk = String(d);
      if (stderr.length < 8000) stderr += chunk;
      else if (stderr.length < 8200) stderr += chunk.slice(0, 8200 - stderr.length);
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // Binario non trovato: è un problema di installazione, non di input.
        console.error(
          `[ffmpeg] eseguibile non trovato ("${executable ?? "ffmpeg"}"): ` +
            "installa ffmpeg oppure imposta FFMPEG_PATH."
        );
        reject(
          new VideoGenerationUnavailableError(
            `ffmpeg non trovato nel PATH. Installa ffmpeg oppure imposta FFMPEG_PATH.`
          )
        );
      } else {
        console.error(`[ffmpeg] errore di avvio del processo:`, err);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // stderr completo nel terminale: la coda va nell'eccezione per l'utente,
      // il log server-side conserva tutto per la diagnostica.
      console.error(`[ffmpeg] uscita con codice ${code}; args: ${args.slice(0, 10).join(" ")} …`);
      console.error(`[ffmpeg] stderr completo:\n${stderr}`);
      reject(
        new Error(
          `ffmpeg terminato con codice ${code}: ${stderr.slice(-500)}`
        )
      );
    });
  });
}

/** Volume predefinito della musica di sottofondo (0..1). */
const DEFAULT_AUDIO_VOLUME = 0.2;

/**
 * Verifica la traccia audio e la risolve in un percorso assoluto leggibile da
 * ffmpeg. Un file assente NON è un errore: si degrada a video senza audio.
 */
async function resolveAudioInput(
  audioPath: string | null | undefined
): Promise<string | null> {
  if (!audioPath) return null;
  try {
    // `materialize` gestisce sia i riferimenti (URL R2 / `/uploads/...`) sia i
    // percorsi assoluti già a terra (file committati come `public/audio/*`).
    const absolute = await materialize(audioPath);
    await fs.access(absolute);
    return absolute;
  } catch {
    console.warn(
      `[ffmpeg] traccia audio non trovata, il video sarà senza audio: ${audioPath}`
    );
    return null;
  }
}

/**
 * Argomenti di encoding dell'output.
 *
 * Con audio: si mappa anche `[aout]` (AAC 128k) e `-shortest` taglia
 * l'output alla durata video — la traccia è loop-ata all'infinito sull'input
 * (`-stream_loop -1`), quindi è il video a dettare la durata finale. Senza
 * audio: `-an`, comportamento precedente immutato.
 */
function buildEncodeArgs(hasAudio: boolean): string[] {
  const out: string[] = ["-map", "[vout]"];
  if (hasAudio) {
    out.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k", "-shortest");
  } else {
    out.push("-an");
  }
  out.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  return out;
}

/**
 * Provider video locale: crea un reel/slideshow con ffmpeg.
 * Ogni slide = immagine mostrata per una durata configurabile.
 */
export class FfmpegVideoProvider implements VideoProvider {
  readonly name = "ffmpeg";
  readonly canGenerate = true;

  /**
   * Disponibilità reale del binario: `canGenerate` dichiara la capacità del
   * provider, questa dice se sul sistema c'è davvero ffmpeg.
   */
  readonly isAvailable = isVideoGenerationAvailable;

  async generateSlideshow(
    slides: VideoSlide[],
    options?: VideoOptions
  ): Promise<GeneratedVideo> {
    if (slides.length === 0) {
      throw new Error("Nessuna slide fornita per il video.");
    }

    const width = options?.width ?? 1080;
    const height = options?.height ?? 1920;
    const fps = options?.fps ?? 25;

    const outDir = outputDirFor("uploads/videos");
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, uniqueFilename("reel.mp4"));

    // Percorsi ASSOLUTI per input e output: ffmpeg non deve dipendere dalla
    // working directory del processo server. L'input non viene mutato: le
    // slide sono oggetti del chiamante e non devono essere toccate.
    const inputPaths: string[] = [];
    for (const s of slides) {
      const absolute = await materialize(s.imagePath);
      try {
        await fs.access(absolute);
      } catch {
        throw new Error(`Immagine non trovata: ${absolute}`);
      }
      inputPaths.push(absolute);
    }

    const args: string[] = ["-y"];
    const filterParts: string[] = [];
    const total = slides.reduce(
      (acc, s) => acc + (s.durationSec ?? 3),
      0
    );

    // Ogni fotogramma diventa una clip MOSSA, non una foto immobile:
    // Ken Burns con zoompan (zoom lento dentro o fuori, alternato per indice).
    // L'immagine viene prima sovradimensionata (2x) e ritagliata sul formato
    // verticale, così zoompan scorre su un frame grande senza jitter, e ogni
    // input produce esattamente `frames` frame alla fps richiesta: la durata
    // del clip è deterministica e il concat trova stream omogenei.
    const preW = width * 2;
    const preH = height * 2;

    slides.forEach((slide, i) => {
      const dur = Math.max(1, slide.durationSec ?? 3);
      const frames = Math.round(dur * fps);
      // Niente -loop/-t: un input a frame singolo e zoompan con d=frames
      // genera la durata voluta. Con il loop, zoompan moltiplicherebbe i frame.
      args.push("-i", inputPaths[i]);
      const rate = (0.12 / frames).toFixed(6);
      const zoomExpr =
        i % 2 === 0
          ? `min(1.12,1+${rate}*on)` // zoom-in lento
          : `max(1.001,1.12-${rate}*on)`; // zoom-out lento, alternato
      const chain = [
        `scale=${preW}:${preH}:force_original_aspect_ratio=increase`,
        `crop=${preW}:${preH}`,
        `zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
        "setsar=1",
        "format=yuv420p",
      ].join(",");
      filterParts.push(`[${i}:v]${chain}[v${i}]`);
    });

    // Montaggio in sequenza (tagli multipli): ogni clip arriva già omogenea
    // (stessa size, fps, SAR, pixel format) dal blocco precedente.
    const concatInputs = slides.map((_, i) => `[v${i}]`).join("");
    filterParts.push(
      `${concatInputs}concat=n=${slides.length}:v=1:a=0[vout]`
    );

    // Musica di sottofondo: input audio loop-ato all'infinito, miscelato come
    // traccia AAC al volume configurato e tagliato alla durata video da
    // `-shortest`. Assente/illeggibile → `-an` (video muto), nessun errore.
    const audioPath = await resolveAudioInput(options?.audioPath);
    const audioVolume = Math.min(
      1,
      Math.max(0, options?.audioVolume ?? DEFAULT_AUDIO_VOLUME)
    );
    if (audioPath) {
      args.push("-stream_loop", "-1", "-i", audioPath);
      filterParts.push(`[${slides.length}:a]volume=${audioVolume}[aout]`);
    }

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      ...buildEncodeArgs(Boolean(audioPath)),
      outFile
    );

    const executable = await resolveFfmpegPath();
    console.log(
      `[ffmpeg] render: ${inputPaths.length} fotogramma/i → ${outFile} (eseguibile: ${executable})`
    );
    try {
      await runFfmpeg(args, executable);
    } catch (e) {
      // Il file parziale non deve restare: un reel incompleto in
      // /uploads/videos sembra un video pubblicabile e non lo è. L'errore
      // completo (con lo stderr già loggato da runFfmpeg) va anche nel log
      // strutturato con il contesto della richiesta.
      await fs.rm(outFile, { force: true }).catch(() => undefined);
      logAIError(
        "ffmpeg.render",
        { slides: slides.length, outFile, durationSec: total, width, height, fps },
        e
      );
      throw e;
    }

    // ffmpeg può uscire 0 senza aver scritto niente di utilizzabile (disco
    // pieno, permessi sulla cartella pubblica): il file va verificato prima
    // di scrivere qualunque riga in database.
    try {
      await fs.access(outFile);
    } catch {
      const detail = "ffmpeg ha segnalato successo ma il file di output non esiste (disco pieno o permessi di scrittura?)";
      logAIError("ffmpeg.verify", { outFile }, new Error(detail));
      throw new Error(detail);
    }

    return {
      url: await publishOutput(outFile, `uploads/videos/${path.basename(outFile)}`, "video/mp4"),
      provider: this.name,
      pathname: outFile,
      durationSec: total,
    };
  }

  /**
   * Vero montaggio: clip video reali tagliate, normalizzate e concatenate.
   *
   * Per ogni clip VIDEO il sorgente viene letto con un taglio secco
   * (`-ss` prima dell'input per il seek rapido, `-t` per la durata della
   * scena) e normalizzato alla risoluzione verticale, al framerate e al
   * pixel format comuni: il `concat` riceve stream omogenei. Le clip IMMAGINE
   * (fallback dichiarato quando di video veri non ce ne sono abbastanza)
   * restano scene animate Ken Burns.
   *
   * L'overlay (titolo + logo) esiste solo sulla clip che lo dichiara — la
   * copertina: le clip successive vengono montate pulite, qualunque sia il
   * loro contenuto.
   */
  async generateMontage(
    clips: MontageClip[],
    options?: VideoOptions
  ): Promise<GeneratedVideo> {
    if (clips.length === 0) {
      throw new Error("Nessuna clip fornita per il montaggio.");
    }

    const width = options?.width ?? 1080;
    const height = options?.height ?? 1920;
    const fps = options?.fps ?? 25;
    const total = clips.reduce((acc, c) => acc + c.sceneSeconds, 0);

    const outDir = outputDirFor("uploads/videos");
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, uniqueFilename("montage.mp4"));

    // Titolo della copertina: composto come PNG con gradiente (stesso stile del
    // titolo dei post) e sovrapposto SOLO alla prima clip. Se la composizione
    // non riesce, il montaggio prosegue senza testo: non è un fallimento.
    const coverClip = clips.find((c) => Boolean(c.overlay?.title?.trim()));
    let titlePngPath: string | null = null;
    if (coverClip?.overlay?.title) {
      try {
        titlePngPath = await renderTitlePng(
          coverClip.overlay.title.trim(),
          width,
          height
        );
      } catch (e) {
        logAIError("ffmpeg.title", { title: coverClip.overlay.title.trim() }, e);
        console.error(
          "[ffmpeg] composizione titolo non riuscita: montaggio senza testo."
        );
      }
    }

    // Passata 1a: input delle clip, nell'ordine delle scene.
    // Le clip video portano il taglio prima dell'input (seek rapido) e la
    // durata della scena; le immagini un solo frame (zoompan le anima).
    //
    // IMPORTANTE: i `-i` dei LOGO NON vanno mai inseriti qui, in mezzo alle
    // clip. L'indice di un input è dato dall'ORDINE dei flag `-i` sulla riga
    // di comando: se il logo venisse aggiunto subito dopo la clip 0, finirebbe
    // all'indice 1 e sposterebbe tutte le clip successive (+1). Il filter
    // graph, che riferisce le clip con `[i:v]`, leggerebbe allora il logo al
    // posto della clip e una clip dietro il nome del logo: è esattamente lo
    // scambio "logo ↔ clip" visto nei video. I logo vanno in una passata
    // separata, DOPO tutte le clip.
    const args: string[] = ["-y"];
    for (const [i, clip] of clips.entries()) {
      if (clip.type === "video") {
        const start = clip.trimStartSec ?? 0;
        if (start > 0) args.push("-ss", String(start));
        args.push("-t", String(clip.sceneSeconds));
      }
      args.push("-i", clip.path);
    }

    // Passata 1b: input dei logo, DOPO tutte le clip (indici N, N+1, …).
    // Così gli indici delle clip restano 0..N-1 e il filter graph li trova.
    const logoInputByClip = new Map<number, number>();
    let nextInput = clips.length;
    for (const [i, clip] of clips.entries()) {
      const logo = clip.overlay?.logoPath;
      if (clip.overlay && logo) {
        logoInputByClip.set(i, nextInput);
        // Il logo è un fermo immagine: `-loop 1` lo ripete ma va SEMPRE
        // accompagnato da `-t` (durata finita della scena). Senza `-t` il loop
        // è infinito e, insieme a `-stream_loop -1` dell'audio e a `-shortest`,
        // ffmpeg non riesce a capire quando fermarsi: il processo si impianta
        // e produce un file parziale. Con `-t` il logo dura esattamente quanto
        // la clip (né un solo frame, né all'infinito).
        args.push("-loop", "1", "-t", String(clip.sceneSeconds), "-i", logo);
        nextInput += 1;
      }
    }

    // Titolo come input immagine (PNG): dopo clip e logo, fermo che dura quanto
    // la copertina. L'indice è `nextInput` dopo i logo, così non sposta le clip.
    const titleInputIndex = coverClip && titlePngPath ? nextInput : null;
    if (coverClip && titlePngPath) {
      args.push("-loop", "1", "-t", String(coverClip.sceneSeconds), "-i", titlePngPath);
      nextInput += 1;
    }

    // Passata 2: filtri. Normalizzazione comune + Ken Burns per le immagini;
    // titolo (PNG con gradiente) e logo SOLO sulle clip che dichiarano l'overlay.
    const filterParts: string[] = [];
    for (const [i, clip] of clips.entries()) {
      const base =
        clip.type === "video"
          ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p`
          : kenBurnsChain(i, clip.sceneSeconds, width, height, fps);

      filterParts.push(`[${i}:v]${base}[bg${i}]`);

      const logoIndex = logoInputByClip.get(i);

      // Titolo (PNG con gradiente) SOLO sulla copertina, poi eventualmente il
      // logo. Il titolo è un'immagine trasparente già composta a piena
      // dimensione: si sovrappone a 0:0, quindi le clip successive restano
      // pulite perché l'overlay appartiene solo a questa clip.
      let staged = `bg${i}`;
      if (titleInputIndex !== null && clip.overlay?.title) {
        filterParts.push(
          `[${titleInputIndex}:v]scale=${width}:${height}[titlel${i}]`
        );
        filterParts.push(
          `[${staged}][titlel${i}]overlay=0:0:format=auto,setsar=1,format=yuv420p[s${i}]`
        );
        staged = `s${i}`;
      }

      if (clip.overlay && logoIndex !== undefined) {
        // Il logo va RIDIMENSIONATO a una misura da watermark: senza scale
        // verrebbe sovrapposto alla sua risoluzione originale (spesso enorme),
        // coprendo il frame. Target ~20% della larghezza, proporzioni salve.
        // Posizione: centrato in verticale, allineato a destra con un margine
        // (x = larghezza - largLogo - margine, y = (altezza - altLogo)/2).
        const logoWidth = Math.round(width * 0.2);
        filterParts.push(
          `[${logoIndex}:v]scale=${logoWidth}:-1:flags=lanczos,format=rgba[logol${i}]`
        );
        filterParts.push(
          `[${staged}][logol${i}]overlay=x=W-w-48:y=(H-h)/2:format=auto,setsar=1,format=yuv420p[v${i}]`
        );
      } else {
        filterParts.push(`[${staged}]null[v${i}]`);
      }
    }

    const concatInputs = clips.map((_, i) => `[v${i}]`).join("");
    filterParts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=0[vout]`);

    // Musica di sottofondo: `nextInput` è l'indice del primo input libero
    // dopo le clip e gli eventuali logo. Stessa strategia dello slideshow:
    // loop infinito + `-shortest`, degradazione silenziosa a `-an`.
    const audioPath = await resolveAudioInput(options?.audioPath);
    const audioVolume = Math.min(
      1,
      Math.max(0, options?.audioVolume ?? DEFAULT_AUDIO_VOLUME)
    );
    if (audioPath) {
      args.push("-stream_loop", "-1", "-i", audioPath);
      filterParts.push(`[${nextInput}:a]volume=${audioVolume}[aout]`);
    }

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      ...buildEncodeArgs(Boolean(audioPath)),
      outFile
    );

    const executable = await resolveFfmpegPath();
    console.log(
      `[ffmpeg] montaggio: ${clips.length} clip (${clips.filter((c) => c.type === "video").length} video) → ${outFile} (eseguibile: ${executable})`
    );
    try {
      await runFfmpeg(args, executable);
    } catch (e) {
      await fs.rm(outFile, { force: true }).catch(() => undefined);
      if (titlePngPath) await fs.rm(titlePngPath, { force: true }).catch(() => undefined);
      logAIError(
        "ffmpeg.montage",
        { clips: clips.length, outFile, durationSec: total, width, height, fps },
        e
      );
      throw e;
    }

    try {
      await fs.access(outFile);
    } catch {
      const detail = "ffmpeg ha segnalato successo ma il file di montaggio non esiste (disco pieno o permessi di scrittura?)";
      logAIError("ffmpeg.verify", { outFile }, new Error(detail));
      throw new Error(detail);
    }

    if (titlePngPath) await fs.rm(titlePngPath, { force: true }).catch(() => undefined);

    return {
      url: await publishOutput(outFile, `uploads/videos/${path.basename(outFile)}`, "video/mp4"),
      provider: this.name,
      pathname: outFile,
      durationSec: Math.round(total),
    };
  }
}

/**
 * Compone il titolo della copertina come PNG trasparente con sfumatura,
 * riusando lo stesso stile del titolo dei post (gradiente bianco → accento
 * caldo + alone scuro). Viene sovrapposto via ffmpeg SOLO alla prima clip.
 */
async function renderTitlePng(
  title: string,
  width: number,
  height: number
): Promise<string> {
  const accent = accentForTitle(title);

  // Corpo grande ma che rientra nella larghezza: parte da ~7.5% dell'altezza
  // e si riduce per i nomi lunghi, come fa il titolo dei post.
  const maxFontSize = Math.round(height * 0.075);
  const minFontSize = Math.round(height * 0.04);
  const perChar = 0.6;
  let fontSize = Math.floor((width * 0.9) / (Math.max(1, title.length) * perChar));
  fontSize = Math.max(minFontSize, Math.min(maxFontSize, fontSize));

  const cx = Math.round(width / 2);
  const baseline = Math.round(height * 0.08) + fontSize;
  const haloWidth = Math.max(5, Math.round(fontSize * 0.08));
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#ffffff"/>` +
    `<stop offset="50%" stop-color="${accent.mid}"/>` +
    `<stop offset="100%" stop-color="${accent.bottom}"/>` +
    `</linearGradient></defs>` +
    `<text x="${cx}" y="${baseline}" text-anchor="middle" font-size="${fontSize}" font-weight="700" font-family="${APP_FONT_STACK}" fill="#0b0f14" fill-opacity="0.55" stroke="#0b0f14" stroke-opacity="0.55" stroke-width="${haloWidth}" stroke-linejoin="round">${esc(title)}</text>` +
    `<text x="${cx}" y="${baseline}" text-anchor="middle" font-size="${fontSize}" font-weight="700" font-family="${APP_FONT_STACK}" fill="url(#g)">${esc(title)}</text>` +
    `</svg>`;

  const buffer = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  const outDir = outputDirFor("uploads/videos");
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, uniqueFilename("title.png"));
  await fs.writeFile(file, buffer);
  return file;
}

/**
 * La catena Ken Burns per le clip-immagine di fallback: stessa costruzione
 * dello slideshow, così un montaggio misto (video + immagini) arriva al
 * concat con stream omogenei.
 */
function kenBurnsChain(
  index: number,
  sceneSeconds: number,
  width: number,
  height: number,
  fps: number
): string {
  const frames = Math.max(1, Math.round(sceneSeconds * fps));
  const preW = width * 2;
  const preH = height * 2;
  const rate = (0.12 / frames).toFixed(6);
  const zoomExpr =
    index % 2 === 0
      ? `min(1.12,1+${rate}*on)`
      : `max(1.001,1.12-${rate}*on)`;
  return [
    `scale=${preW}:${preH}:force_original_aspect_ratio=increase`,
    `crop=${preW}:${preH}`,
    `zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
}