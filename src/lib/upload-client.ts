/**
 * Upload di file dal browser verso la Media Library.
 *
 * In produzione (cloud) il file va DIRETTAMENTE su Cloudflare R2 con un URL
 * pre-firmato: il body non passa da Vercel, che rifiuterebbe tutto ciò che
 * supera 4,5 MB (era la causa degli upload che "sparivano" senza messaggio).
 * In locale il server risponde mode "proxy" e si usa il classico POST
 * multipart su /api/upload.
 *
 * Restituisce un esito per ogni file, così la UI può dire con precisione
 * quale file è andato e quale no (e perché).
 */

export interface UploadOutcome {
  fileName: string;
  ok: boolean;
  message?: string;
  /** URL pubblico del file caricato (presente solo se ok). */
  url?: string;
  /** Bozza creata automaticamente (upload dalla pagina Media). */
  contentId?: string | null;
}

async function uploadOne(
  file: File,
  contentId?: string | null,
  createContent = false
): Promise<UploadOutcome> {
  // 1) Preparazione: il server decide il percorso (direct R2 / proxy locale).
  let sign: {
    ok?: boolean;
    mode?: "direct" | "proxy";
    uploadUrl?: string;
    publicUrl?: string;
    key?: string;
    message?: string;
  };
  try {
    const res = await fetch("/api/upload/sign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        type: file.type,
        size: file.size,
        contentId: contentId ?? undefined,
        createContent,
      }),
    });
    sign = await res.json();
    if (!res.ok || !sign.ok) {
      return { fileName: file.name, ok: false, message: sign.message ?? "Preparazione upload fallita." };
    }
  } catch {
    return { fileName: file.name, ok: false, message: "Errore di rete durante la preparazione." };
  }

  // 2a) Percorso classico (locale): multipart verso il server.
  if (sign.mode !== "direct") {
    const form = new FormData();
    form.append("file", file);
    if (contentId) form.append("contentId", contentId);
    if (createContent) form.append("createContent", "1");
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        return { fileName: file.name, ok: false, message: body?.message ?? "Upload fallito." };
      }
      return { fileName: file.name, ok: true, url: body.assets?.[0]?.url, contentId: body.contentId ?? null };
    } catch {
      return { fileName: file.name, ok: false, message: "Errore di rete durante l'upload." };
    }
  }

  // 2b) Percorso diretto: PUT del file su R2 con l'URL pre-firmato.
  try {
    const res = await fetch(sign.uploadUrl!, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!res.ok) {
      return { fileName: file.name, ok: false, message: `Caricamento su cloud fallito (HTTP ${res.status}).` };
    }
  } catch {
    return { fileName: file.name, ok: false, message: "Errore di rete durante il caricamento su cloud." };
  }

  // 3) Registrazione: il server verifica il file e crea l'asset.
  try {
    const res = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: sign.key,
        publicUrl: sign.publicUrl,
        name: file.name,
        type: file.type,
        size: file.size,
        contentId: contentId ?? undefined,
        createContent,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      return { fileName: file.name, ok: false, message: body?.message ?? "Registrazione del file fallita." };
    }
    return { fileName: file.name, ok: true, url: body.assets?.[0]?.url, contentId: body.contentId ?? null };
  } catch {
    return { fileName: file.name, ok: false, message: "Errore di rete durante la registrazione." };
  }
}

/**
 * Carica più file in sequenza e restituisce l'esito di ciascuno.
 * `createContent` (pagina Media): ogni file diventa anche una bozza in
 * Pianificazione con il media già collegato.
 */
export async function uploadFiles(
  files: File[],
  contentId?: string | null,
  createContent = false
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  for (const file of files) {
    outcomes.push(await uploadOne(file, contentId, createContent));
  }
  return outcomes;
}

/** Messaggio riassuntivo per la UI (null se è andato tutto bene). */
export function uploadErrorSummary(outcomes: UploadOutcome[]): string | null {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return null;
  return failed.map((f) => `${f.fileName}: ${f.message ?? "errore"}`).join("\n");
}
