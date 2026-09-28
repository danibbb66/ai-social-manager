/**
 * Download sicuro di immagini remote.
 *
 * Serve a una cosa sola: portare in locale l'immagine ufficiale di una
 * proposta del Catalogo, che oggi vive solo come URL remoto dentro
 * `CatalogImage`. Nulla di più: questo modulo non crea `Content`, non crea
 * `ContentAsset`, non chiama il provider immagini e non scrive nel database.
 *
 * Il pericolo di questo codice è uno solo, ed è la SSRF: l'URL non arriva
 * dall'utente ma dal catalogo, e il catalogo è stato costruito da una
 * scansione di un sito esterno. Un URL può quindi essere stato riscritto, può
 * puntare a `169.254.169.254`, può reindirizzare altrove o può servire HTML
 * travestito da immagine. Ogni difesa qui sotto esiste per uno di questi casi.
 *
 * Le regole, in ordine di applicazione:
 *
 *  1. solo `http`/`https`, senza credenziali embedded e senza host che siano
 *     un indirizzo IP (basta questo per chiudere loopback, link-local e
 *     `169.254.169.254` in un colpo);
 *  2. l'host deve stare nella allowlist passata dal chiamante, che per
 *     contratto contiene il dominio della fonte del Catalogo già in database
 *     (`CatalogSource.domain`) e nulla altro: nessun dominio è scritto qui;
 *  3. i redirect non vengono seguiti da `fetch`: ogni hop viene validato come
 *     se fosse una richiesta nuova, quindi non si può partire da un host
 *     consentito e arrivare su uno che non lo è;
 *  4. la risposta è limitata in byte mentre viene letta, non dopo: un
 *     `Content-Length` che mente non deve permettere un download illimitato;
 *  5. il MIME reale viene dai magic bytes e non dall'header: è l'unico modo
 *     per rifiutare HTML e SVG serviti come immagine.
 *
 * Sul salvataggio: si riusa `saveUploadedFile`, la stessa infrastruttura degli
 * upload manuali, così il file finisce dove la Media Library lo cerca già. Il
 * nome che questo modulo propone è deterministico (nome del catalogo + hash
 * dell'URL + estensione dal MIME reale) ma l'helper gli aggiunge il suo
 * suffisso di unicità: il nome finale resta quindi unico, come per ogni altro
 * upload. Determinismo e unicità hanno due compiti diversi e non si sostituiscono.
 *
 * Nulla viene scritto su disco prima che il download sia completo e validato:
 * un timeout o un errore di rete non lascia file orfani, perché non è mai
 * esistito un file da lasciare.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { saveUploadedFile, sniffMediaMime, type SavedFile } from "@/lib/uploads";
import { imageExtensionForMime, isImageMime, slugify } from "@/lib/utils";

/** Tempo massimo per l'intera operazione, redirect inclusi. */
export const REMOTE_IMAGE_TIMEOUT_MS = 20_000;
/** Dimensione massima accettata: un volantino del catalogo non occupa 10 MB. */
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Redirect consentiti in sequenza, tutti validati. */
export const MAX_REMOTE_REDIRECTS = 3;

/**
 * Perché il download è fallito.
 *
 * Sono codici distinti perché il chiamante deve poter reagire in modo
 * diverso: un host non autorizzato è un problema di configurazione del
 * catalogo, un timeout è un problema di rete, un MIME non immagine è un
 * problema della fonte. Nessuno di questi è un errore da mascherare con un
 * fallback silenzioso.
 */
export type RemoteImageErrorCode =
  | "invalid_url"
  | "host_not_allowed"
  | "redirect_not_allowed"
  | "timeout"
  | "network_error"
  | "http_error"
  | "not_an_image"
  | "too_large"
  | "save_failed";

/** Base di tutti gli errori del downloader: espone il codice per il chiamante. */
export class RemoteImageError extends Error {
  readonly code: RemoteImageErrorCode;

  constructor(code: RemoteImageErrorCode, message: string) {
    super(message);
    this.name = "RemoteImageError";
    this.code = code;
  }
}

/** URL non utilizzabile: sintassi, protocollo, credenziali o host IP. */
export class InvalidRemoteImageUrlError extends RemoteImageError {
  constructor(message: string) {
    super("invalid_url", message);
    this.name = "InvalidRemoteImageUrlError";
  }
}

/** L'host non è nella allowlist del catalogo: nessuna richiesta viene fatta. */
export class RemoteHostNotAllowedError extends RemoteImageError {
  readonly host: string;
  constructor(host: string) {
    super("host_not_allowed", `Host non autorizzato per il download dal Catalogo: ${host}.`);
    this.name = "RemoteHostNotAllowedError";
    this.host = host;
  }
}

/** Un redirect porta fuori dagli host consentiti, o se ne sono accumulati troppi. */
export class RemoteRedirectNotAllowedError extends RemoteImageError {
  readonly target: string;
  constructor(message: string, target = "") {
    super("redirect_not_allowed", message);
    this.name = "RemoteRedirectNotAllowedError";
    this.target = target;
  }
}

/** Tempo scaduto: nessuna risposta entro `REMOTE_IMAGE_TIMEOUT_MS`. */
export class RemoteImageTimeoutError extends RemoteImageError {
  constructor(message: string) {
    super("timeout", message);
    this.name = "RemoteImageTimeoutError";
  }
}

/** Rete irraggiungibile: DNS, connessione interrotta, TLS non valido. */
export class RemoteImageNetworkError extends RemoteImageError {
  constructor(message: string) {
    super("network_error", message);
    this.name = "RemoteImageNetworkError";
  }
}

/** Risposta HTTP non utilizzabile come immagine (status, redirect senza Location, corpo vuoto). */
export class RemoteImageHttpError extends RemoteImageError {
  readonly status: number;
  constructor(message: string, status = 0) {
    super("http_error", message);
    this.name = "RemoteImageHttpError";
    this.status = status;
  }
}

/** Il contenuto scaricato non è un'immagine: HTML, SVG, testo o formato ignoto. */
export class RemoteImageNotAnImageError extends RemoteImageError {
  constructor(message: string) {
    super("not_an_image", message);
    this.name = "RemoteImageNotAnImageError";
  }
}

/** Oltre il limite di byte consentito. */
export class RemoteImageTooLargeError extends RemoteImageError {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super("too_large", `Immagine troppo grande: il limite è ${maxBytes} byte.`);
    this.name = "RemoteImageTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/** Il file è stato scaricato e validato, ma non è stato possibile scriverlo. */
export class RemoteImageSaveError extends RemoteImageError {
  constructor(message: string) {
    super("save_failed", message);
    this.name = "RemoteImageSaveError";
  }
}

/**
 * Immagine ufficiale materializzata in locale.
 *
 * Estende `SavedFile` (l'oggetto che restituisce `saveUploadedFile`) invece di
 * ripeterne i campi: `url` e `pathname` sono già quelli che `ContentAsset`
 * aspetta, quindi non serve nessuna traduzione.
 */
export interface RemoteImage extends SavedFile {
  /** URL remoto da cui è stata scaricata la copia. */
  sourceUrl: string;
  /** Nome del file effettivamente scritto su disco. */
  filename: string;
  /** Nome deterministico proposto dal modulo, prima del suffisso di unicità. */
  filenameHint: string;
}

export interface DownloadRemoteImageOptions {
  /** URL dell'immagine nel catalogo. */
  url: string;
  /**
   * Host ammessi. Per il catalogo questo è `CatalogSource.domain`, cioè il
   * dominio già scansionato e salvato: nessun dominio è scritto in questo
   * modulo, e un valore vuoto non è un caso permesso ma un errore.
   */
  allowedDomains: readonly string[];
  /** Nome originale del catalogo: serve solo a rendere leggibile il file. */
  originalName?: string | null;
  /** Limite di byte, sovrascrivibile per test. */
  maxBytes?: number;
  /** Timeout in ms, sovrascrivibile per test. */
  timeoutMs?: number;
}

/** MIME dichiarati che escludono il salvataggio anche se i byte fossero immagine. */
const DECLARED_MIME_DENY = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
  "text/plain",
  "image/svg+xml",
]);

/** MIME generici: non dicono nulla, quindi la decisione spetta ai magic bytes. */
const DECLARED_MIME_UNSPECIFIC = new Set(["application/octet-stream", "binary/octet-stream"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Un dominio in allowlist può arrivare come host nudo.
 *
 * Tolgono lo schema e il percorso se qualcuno passa `https://dominio/it/`
 * invece di `dominio`: la allowlist deve funzionare anche con un
 * `CatalogSource.domain` compilato a mano.
 */
function normalizeDomain(value: string): string {
  let out = value.trim().toLowerCase();
  const scheme = out.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) out = out.slice(scheme[0].length);
  out = out.split("/")[0].split("?")[0].split("#")[0];
  const at = out.lastIndexOf("@");
  if (at >= 0) out = out.slice(at + 1);
  return normalizeHost(out);
}

function parseUrl(raw: string): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new InvalidRemoteImageUrlError("URL vuoto: impossibile scaricare l'immagine.");

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new InvalidRemoteImageUrlError(`URL non valido: ${text}.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRemoteImageUrlError(
      `Protocollo non ammesso (${parsed.protocol}): solo http e https.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new InvalidRemoteImageUrlError("URL con credenziali: download rifiutato.");
  }
  return parsed;
}

/**
 * L'host è nella allowlist?
 *
 * Vale l'host esatto e ogni suo sottodominio, che è la regola che il progetto
 * usa già per i CDN (`isAllowedCdnUrl` in `magnific.ts`): il catalogo può
 * servire le immagini da `www.dominio.it` pur essendo configurato come
 * `dominio.it`, ma non viceversa.
 */
export function isAllowedCatalogHost(hostname: string, allowedDomains: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return allowedDomains.some((raw) => {
    const domain = normalizeDomain(raw);
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/**
 * Valida un URL contro la allowlist, senza effettuare alcuna richiesta.
 *
 * È esposta perché le guardie di sicurezza si verificano anche da sole: il
 * test può dimostrare che un host arbitrario viene rifiutato prima di qualsiasi
 * contatto di rete, senza dipendere da come risponde il server.
 */
export function assertAllowedCatalogUrl(raw: string, allowedDomains: readonly string[]): URL {
  const parsed = parseUrl(raw);
  const host = normalizeHost(parsed.hostname);

  // `URL` tiene le parentesi negli IPv6 (`[::1]`), `net.isIP` le vuole fuori.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // Un host che è un indirizzo IP non è un dominio del catalogo: dietro un
  // nome si nasconderebbero loopback, link-local e metadata endpoint.
  if (isIP(bareHost) !== 0) {
    throw new InvalidRemoteImageUrlError(
      `Host non ammesso: ${host} è un indirizzo IP, non un dominio.`
    );
  }
  if (!isAllowedCatalogHost(host, allowedDomains)) {
    throw new RemoteHostNotAllowedError(host);
  }
  return parsed;
}

/** MIME reale dai magic bytes, con l'header usato solo per escludere. */
function resolveImageMime(buffer: Buffer, declared: string): string {
  const declaredType = declared.split(";")[0].trim().toLowerCase();
  if (declaredType && DECLARED_MIME_DENY.has(declaredType)) {
    throw new RemoteImageNotAnImageError(
      `Tipo di contenuto dichiarato non ammesso (${declaredType}): download rifiutato.`
    );
  }

  // Qui la differenza rispetto al download del provider Magnific è voluta: quel
  // CDN è un servizio fidato e in assenza di firma nota il suo header fa da
  // ripiego. Qui la fonte è un sito terzo, quindi l'header non basta e non
  // viene usato come prova: se i magic bytes non dicono "immagine", è respinto.
  const sniffed = sniffMediaMime(buffer);
  if (!sniffed || !isImageMime(sniffed)) {
    throw new RemoteImageNotAnImageError(
      "Il contenuto scaricato non è un'immagine riconoscibile (HTML, SVG o altro contenuto non immagine)."
    );
  }
  if (declaredType && !isImageMime(declaredType) && !DECLARED_MIME_UNSPECIFIC.has(declaredType)) {
    throw new RemoteImageNotAnImageError(
      `Tipo di contenuto dichiarato non ammesso (${declaredType}): download rifiutato.`
    );
  }
  return sniffed;
}

/**
 * Nome deterministico del file locale.
 *
 * Composto solo da elementi derivati dall'URL e dal MIME reale, mai dal nome
 * originale grezzo: `slugify` toglie slash, due punti e sequenze di puntini, e
 * l'estensione viene dai magic bytes, non dall'estensione dichiarata dal sito.
 *
 * La parte leggibile è tenuta corta per una ragione precisa: `uniqueFilename`
 * tronca il nome base a 40 caratteri prima di aggiungere il suo suffisso di
 * unicità. Con il nome tutto in coda, un hash potrebbe essere tagliato a metà e
 * due immagini diverse finirebbero con lo stesso nome. Qui l'hash sta
 * nell'ordine di grandezza dei 30 caratteri: nessun taglio lo può toccare.
 *
 * Il controllo finale è una rete di sicurezza: se il nome non rispetta la
 * forma attesa non si scrive nulla.
 */
export function officialImageFilename(sourceUrl: string, mimeType: string, originalName?: string | null): string {
  const ext = imageExtensionForMime(mimeType);
  const fromCatalog = slugify(String(originalName ?? "").replace(/\.[^.]+$/, "")).slice(0, 18);
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 10);
  const base = `${fromCatalog || "immagine"}-${hash}`;
  const name = `${base}.${ext}`;

  if (!/^[a-z0-9-]{1,32}\.[a-z0-9]{1,5}$/.test(name)) {
    throw new RemoteImageSaveError(`Nome file non sicuro: ${name}.`);
  }
  return name;
}

/** Legge il corpo a byte, interrompendo appena si supera il limite. */
async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new RemoteImageTooLargeError(maxBytes);
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Il limite si controlla durante la lettura: fidarsi del solo
      // Content-Length lascerebbe aperta la porta a un download illimitato.
      if (total > maxBytes) throw new RemoteImageTooLargeError(maxBytes);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/** Valida la destinazione di un redirect con gli stessi criteri della richiesta iniziale. */
function assertAllowedRedirect(location: string, from: URL, allowedDomains: readonly string[]): URL {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new RemoteRedirectNotAllowedError(`Redirect non valido da ${from.hostname}.`, location);
  }
  try {
    return assertAllowedCatalogUrl(target.toString(), allowedDomains);
  } catch (e) {
    // Il motivo (protocollo, credenziali, IP, host fuori allowlist) è già
    // preciso: qui cambia solo la natura dell'errore, perché la richiesta
    // originaria era legittima ed è il salto a non esserlo.
    if (e instanceof RemoteImageError) {
      throw new RemoteRedirectNotAllowedError(
        `Redirect non autorizzato da ${from.hostname} a ${target.hostname}: ${e.message}`,
        target.toString()
      );
    }
    throw e;
  }
}

/**
 * Scarica l'immagine ufficiale del catalogo e la salva negli upload.
 *
 * Fallisce sempre in modo esplicito: nessun fallback, nessun file parziale,
 * nessuna scrittura a database.
 */
export async function downloadRemoteImage(
  options: DownloadRemoteImageOptions
): Promise<RemoteImage> {
  const maxBytes = options.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS;
  const allowedDomains = options.allowedDomains ?? [];

  // Prima difesa, prima di qualsiasi I/O: URL e allowlist si validano da soli.
  let current = assertAllowedCatalogUrl(options.url, allowedDomains);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    for (let hop = 0; ; hop += 1) {
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/*" },
        });
      } catch (e) {
        if (controller.signal.aborted) {
          throw new RemoteImageTimeoutError(
            `Timeout dopo ${timeoutMs} ms durante il download da ${current.hostname}.`
          );
        }
        throw new RemoteImageNetworkError(
          `Impossibile contattare ${current.hostname}: ${e instanceof Error ? e.message : "errore di rete"}.`
        );
      }

      if (!REDIRECT_STATUSES.has(res.status)) break;

      const location = res.headers.get("location");
      if (!location) {
        throw new RemoteImageHttpError(
          `Redirect da ${current.hostname} senza Location (HTTP ${res.status}).`,
          res.status
        );
      }
      if (hop >= MAX_REMOTE_REDIRECTS) {
        throw new RemoteRedirectNotAllowedError(
          `Troppi redirect da ${current.hostname}: il limite è ${MAX_REMOTE_REDIRECTS}.`,
          location
        );
      }
      // Ogni hop è una nuova richiesta e viene validata come la prima: da qui
      // non si può uscire dagli host consentiti.
      current = assertAllowedRedirect(location, current, allowedDomains);
    }

    if (res.status !== 200) {
      throw new RemoteImageHttpError(
        `Risposta HTTP non valida da ${current.hostname}: ${res.status}.`,
        res.status
      );
    }

    const declared = res.headers.get("content-type") ?? "";
    const declaredLength = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new RemoteImageTooLargeError(maxBytes);
    }

    const buffer = await readBounded(res, maxBytes);
    if (buffer.length === 0) {
      throw new RemoteImageHttpError(`Risposta vuota da ${current.hostname}.`, res.status);
    }

    const mimeType = resolveImageMime(buffer, declared);
    const filenameHint = officialImageFilename(current.toString(), mimeType, options.originalName);

    // Solo qui, dopo download completo e validazione, nasce un file: prima di
    // questo punto un errore non lascia nulla da ripulire.
    const saved = await saveUploadedFile({ buffer, originalName: filenameHint, mimeType });

    return {
      url: saved.url,
      pathname: saved.pathname,
      mimeType,
      size: saved.size,
      sourceUrl: current.toString(),
      filename: saved.pathname.split(/[\\/]/).pop() ?? filenameHint,
      filenameHint,
    };
  } catch (e) {
    if (e instanceof RemoteImageError) throw e;
    if (controller.signal.aborted) {
      throw new RemoteImageTimeoutError(
        `Timeout dopo ${timeoutMs} ms durante il download da ${current.hostname}.`
      );
    }
    if (e instanceof Error && /ENOENT|EACCES|EPERM|EISDIR|ENOSPC/i.test(e.message)) {
      throw new RemoteImageSaveError(`Salvataggio non riuscito: ${e.message}`);
    }
    throw new RemoteImageNetworkError(
      `Download non riuscito da ${current.hostname}: ${e instanceof Error ? e.message : "errore sconosciuto"}.`
    );
  } finally {
    clearTimeout(timer);
  }
}
