import { Platform } from "@prisma/client";
import { config, hasFacebook, publicBaseUrl } from "@/lib/env";
import { redactSecrets } from "@/lib/security";
import { PublishPayload, PublishResult, SocialProvider } from "@/lib/social/provider";
import { formatGraphError } from "@/lib/social/graph-error";

const GRAPH_URL = "https://graph.facebook.com/v26.0";

const NO_PUBLIC_URL =
  "Per pubblicare su Facebook il media deve essere raggiungibile da Internet tramite una URL HTTPS pubblica. Imposta PUBLIC_APP_URL nel file .env con l'URL pubblico dell'app (es. https://tunnel.example.com) e riavvia il server.";

type ThumbFile = { data: Blob; filename: string };

/**
 * Scarica la copertina del video per allegarla come file alla chiamata
 * /videos. Meta rifiuta la copertina passata come URL con l'errore
 * "(#100) Invalid image format. It should be an image file data": il
 * parametro `thumb` accetta solo dati binari (multipart). Se il download
 * fallisce si pubblica senza copertina e Facebook sceglie un frame del video.
 */
async function downloadThumb(url: string | null): Promise<ThumbFile | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return { data: new Blob([buf], { type }), filename: `copertina.${ext}` };
  } catch {
    return null;
  }
}

/**
 * Converte l'URL di un media in una URL HTTPS pubblicamente raggiungibile dai
 * server di Meta. Gli URL già assoluti vengono restituiti invariati; i
 * percorsi relativi locali (/uploads/...) vengono risolti tramite
 * PUBLIC_APP_URL, che è l'unico modo perché Meta possa scaricarli.
 *
 * Restituisce null quando non è possibile ottenere una URL pubblica: in quel
 * caso la pubblicazione DEVE fallire esplicitamente, perché un fallback a
 * post testuale pubblicherebbe un contenuto diverso da quello approvato.
 */
function publicMediaUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (!u.startsWith("/")) return null;
  const base = publicBaseUrl();
  if (!base) return null;
  return `${base}${u}`;
}

/**
 * Provider Facebook basato sulla Meta Graph API ufficiale.
 * Foto: POST /{page-id}/photos; post di testo: POST /{page-id}/feed; video: /{page-id}/videos.
 * I messaggi di errore vengono sempre ripuliti dai token prima di tornare al chiamante.
 */
export class FacebookProvider implements SocialProvider {
  readonly platform: Platform = "FACEBOOK";

  get isConfigured() {
    return hasFacebook();
  }

  missingConfig(): string[] {
    const missing: string[] = [];
    if (!config.facebook.token) missing.push("FACEBOOK_PAGE_ACCESS_TOKEN");
    if (!config.facebook.pageId) missing.push("FACEBOOK_PAGE_ID");
    return missing;
  }

  /**
   * POST multipart/form-data: usato per /videos, dove la copertina va
   * allegata come file (`thumb`) invece che come URL. Gli altri parametri
   * diventano campi del form.
   */
  private async graphForm(
    path: string,
    fields: Record<string, string>,
    thumb: ThumbFile | null
  ) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (thumb) form.append("thumb", thumb.data, thumb.filename);

    const res = await fetch(`${GRAPH_URL}${path}`, { method: "POST", body: form });
    const json = (await res.json()) as {
      id?: string;
      error?: {
        message?: string;
        code?: number;
        type?: string;
        error_subcode?: number;
        error_user_msg?: string;
      };
    };
    if (!res.ok || json.error) {
      throw new Error(
        redactSecrets(`Facebook Graph API ${res.status}: ${formatGraphError(json.error)}`)
      );
    }
    return json;
  }

  private async graph(path: string, params: Record<string, string>) {
    const url = `${GRAPH_URL}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { method: "POST" });
    const json = (await res.json()) as {
      id?: string;
      error?: {
        message?: string;
        code?: number;
        type?: string;
        error_subcode?: number;
        error_user_msg?: string;
      };
    };
    if (!res.ok || json.error) {
      throw new Error(
        redactSecrets(`Facebook Graph API ${res.status}: ${formatGraphError(json.error)}`)
      );
    }
    return json;
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    if (!this.isConfigured) {
      return {
        ok: false,
        message: `Account Facebook non configurato. Aggiungi al file .env: ${this.missingConfig().join(", ")}`,
      };
    }
    const pageId = config.facebook.pageId!;
    const token = config.facebook.token!;
    const message = [payload.caption, payload.hashtags].filter(Boolean).join(" ");

    try {
      if (payload.contentType === "VIDEO") {
        const source = payload.videoUrl ?? payload.mediaUrls[0];
        if (!source) return { ok: false, message: "Nessun video da pubblicare." };
        const videoUrl = publicMediaUrl(source);
        if (!videoUrl) return { ok: false, message: NO_PUBLIC_URL };
        // Copertina esplicita (frame titolo+logo): allegata come FILE perché
        // Meta non accetta il thumb come URL (errore #100 Invalid image format).
        const thumb = await downloadThumb(publicMediaUrl(payload.mediaUrls[0]));
        const res = await this.graphForm(
          `/${pageId}/videos`,
          { file_url: videoUrl, description: message, access_token: token },
          thumb
        );
        return { ok: true, message: "Video pubblicato su Facebook.", externalId: res.id };
      }

      // Con un media presente la pubblicazione deve includerlo: non è ammesso
      // degradare silenziosamente il post a solo testo.
      const [firstMedia] = payload.mediaUrls;
      if (firstMedia) {
        const imageUrl = publicMediaUrl(firstMedia);
        if (!imageUrl) return { ok: false, message: NO_PUBLIC_URL };
        const res = await this.graph(`/${pageId}/photos`, {
          url: imageUrl,
          caption: message,
          access_token: token,
        });
        return { ok: true, message: "Foto pubblicata su Facebook.", externalId: res.id };
      }

      // Nessun media: post puramente testuale, comportamento invariato.
      const res = await this.graph(`/${pageId}/feed`, {
        message,
        access_token: token,
      });
      return { ok: true, message: "Post pubblicato su Facebook.", externalId: res.id };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}