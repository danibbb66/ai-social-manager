import { NextRequest } from "next/server";
import {
  createDirectUploadUrl,
  fileExists,
  isCloudStorage,
  writeFile,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Limite per singolo file: le clip video curate arrivano anche a ~140 MB. */
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

/** Estensioni accettate per categoria. */
const EXTENSIONS: Record<"photos" | "videos" | "audio", RegExp> = {
  photos: /\.(jpe?g|png|webp|avif|gif)$/i,
  videos: /\.(mp4|mov|webm|m4v|mkv|avi)$/i,
  audio: /\.(m4a|mp3|wav|aac|ogg)$/i,
};

/** MIME derivato dall'estensione (per il PUT diretto su R2). */
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

/** Slug sicuro: solo lettere minuscole, cifre e underscore. */
function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9_]+$/.test(slug);
}

/** Slug per una nuova destinazione dalla stringa libera dell'utente. */
function slugifyDestination(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug;
}

/**
 * Nome file sicuro: rimuove il percorso, gli spazi/accapo e i caratteri
 * pericolosi (spazi → `-`), mantiene leggibile il nome originale e
 * normalizza l'estensione in minuscolo.
 */
function sanitizeFilename(name: string): string {
  const raw = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = raw.lastIndexOf(".");
  const ext = dot >= 0 ? raw.slice(dot).toLowerCase() : "";
  const base = dot >= 0 ? raw.slice(0, dot) : raw;
  const clean =
    base
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "media";
  return `${clean}${ext}`;
}

const CATEGORY_RULE: Record<
  string,
  { kind: "photos" | "videos" | "audio"; needsSlug: boolean }
> = {
  photos: { kind: "photos", needsSlug: true },
  videos: { kind: "videos", needsSlug: true },
  audio: { kind: "audio", needsSlug: false },
};

type Kind = "photos" | "videos" | "audio";

/** Costruisce la chiave di storage, evitando di sovrascrivere file esistenti. */
async function resolveKey(
  kind: Kind,
  slug: string,
  name: string
): Promise<string> {
  const safeName = sanitizeFilename(name);
  const prefix = kind === "audio" ? "audio" : `curated/${kind}/${slug}`;
  let key = `${prefix}/${safeName}`;

  // Se esiste già, numera con -2, -3… per non perdere il file precedente.
  if (await fileExists(key)) {
    const dot = safeName.lastIndexOf(".");
    const base = dot >= 0 ? safeName.slice(0, dot) : safeName;
    const ext = dot >= 0 ? safeName.slice(dot) : "";
    for (let n = 2; n <= 999; n += 1) {
      const candidate = `${prefix}/${base}-${n}${ext}`;
      if (!(await fileExists(candidate))) {
        key = candidate;
        break;
      }
    }
  }
  return key;
}

/**
 * Convalida la richiesta di firma e restituisce un errore (stringa) oppure
 * l'oggetto `{ kind, slug, name, type, size }` normalizzato.
 */
function parseAndValidate(body: {
  kind?: unknown;
  slug?: unknown;
  name?: unknown;
  type?: unknown;
  size?: unknown;
}):
  | { error: string }
  | { kind: Kind; slug: string; name: string; type: string; size: number } {
  const kindRaw = typeof body.kind === "string" ? body.kind : "";
  const rule = CATEGORY_RULE[kindRaw];
  if (!rule) {
    return { error: "Categoria non valida (scegli Foto, Video o Audio)." };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return { error: "Nome file mancante." };
  }
  if (!EXTENSIONS[rule.kind].test(name)) {
    return {
      error: `Estensione non supportata per questa categoria: "${name}".`,
    };
  }

  let slug = "";
  if (rule.needsSlug) {
    const slugRaw = typeof body.slug === "string" ? body.slug.trim() : "";
    slug = slugifyDestination(slugRaw);
    if (!isSafeSlug(slug)) {
      return {
        error:
          "Nome destinazione non valido: usa solo lettere, numeri o underscore.",
      };
    }
  }

  const type = typeof body.type === "string" ? body.type.trim() : "";
  const size = typeof body.size === "number" ? body.size : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    return { error: `Il file "${name}" è vuoto.` };
  }
  if (size > MAX_FILE_SIZE) {
    return { error: `File "${name}" troppo grande (max 500 MB).` };
  }

  return { kind: rule.kind, slug, name, type, size };
}

function contentTypeFor(name: string, declared?: string): string {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[ext] ?? declared ?? "application/octet-stream";
}

/** Firma (JSON): restituisce un URL pre-firmato R2 o la modalità proxy locale. */
async function handleSign(req: NextRequest): Promise<Response> {
  let body: {
    kind?: unknown;
    slug?: unknown;
    name?: unknown;
    type?: unknown;
    size?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Richiesta non valida." }, { status: 400 });
  }

  // Supporta anche la creazione di una nuova destinazione: il client invia
  // `slug` già "slugificato" e `newDestination` come segnalazione.
  const parsed = parseAndValidate(body);
  if ("error" in parsed) {
    return Response.json({ ok: false, message: parsed.error }, { status: 400 });
  }

  const { kind, slug, name, type } = parsed;
  const key = await resolveKey(kind, slug, name);
  const contentType = contentTypeFor(name, type);

  if (!isCloudStorage()) {
    return Response.json({ ok: true, mode: "proxy", key });
  }

  try {
    const direct = await createDirectUploadUrl(key, contentType);
    if (!direct) {
      return Response.json({ ok: true, mode: "proxy", key });
    }
    return Response.json({ ok: true, mode: "direct", key, contentType, ...direct });
  } catch (e) {
    console.error("Curated/upload: creazione URL pre-firmato fallita", e);
    return Response.json(
      { ok: false, message: "Impossibile preparare il caricamento. Riprova." },
      { status: 500 }
    );
  }
}

/** Caricamento proxy (locale): scrive il file sul disco con `writeFile`. */
async function handleMultipart(req: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, message: "Richiesta non valida." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ ok: false, message: "File mancante." }, { status: 400 });
  }
  const kind = String(form.get("kind") ?? "");
  const slug = String(form.get("slug") ?? "");
  const keyFromClient = String(form.get("key") ?? "");

  const parsed = parseAndValidate({
    kind,
    slug,
    name: file.name,
    type: file.type,
    size: file.size,
  });
  if ("error" in parsed) {
    return Response.json({ ok: false, message: parsed.error }, { status: 400 });
  }

  // Ricalcola la chiave in modo deterministico (stessa logica della firma).
  const clientKeyValid =
    keyFromClient.startsWith("curated/") || keyFromClient.startsWith("audio/");
  const key = clientKeyValid
    ? keyFromClient
    : await resolveKey(parsed.kind, parsed.slug, file.name);

  const bodyBuf = Buffer.from(await file.arrayBuffer());
  const url = await writeFile(key, bodyBuf, contentTypeFor(file.name, file.type));
  return Response.json({ ok: true, key, publicUrl: url });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    return handleMultipart(req);
  }
  return handleSign(req);
}
