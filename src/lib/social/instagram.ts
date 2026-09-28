import { Platform } from "@prisma/client";
import { config, hasInstagram, publicBaseUrl } from "@/lib/env";
import { redactSecrets } from "@/lib/security";
import { PublishPayload, PublishResult, SocialProvider } from "@/lib/social/provider";

/**
 * Host dell'Instagram API with Instagram Login.
 *
 * NON usare graph.facebook.com con i token IGAA…: quell'host rifiuta il token
 * con "Invalid OAuth access token - Cannot parse access token". I token rilasciati
 * da Instagram Login (prefisso IGAA/IGAB) sono accettati solo da graph.instagram.com.
 */
const GRAPH_URL = "https://graph.instagram.com/v23.0";

/**
 * Converte un URL di media in una URL HTTPS pubblicamente raggiungibile dai
 * server di Meta. Gli URL già assoluti vengono restituiti invariati; i
 * percorsi relativi locali (/uploads/...) vengono risolti tramite
 * PUBLIC_APP_URL, che è l'unico modo per cui Meta possa scaricarli.
 */
function mediaUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (!u.startsWith("/")) return null;
  const base = publicBaseUrl();
  if (!base) return null;
  return `${base}${u}`;
}

const NO_PUBLIC_URL =
  "Per pubblicare su Instagram il media deve essere raggiungibile da Internet tramite una URL HTTPS pubblica. Imposta PUBLIC_APP_URL nel file .env con l'URL pubblico dell'app (es. https://tunnel.example.com) e riavvia il server.";

/**
 * Meta scarica e processa il media in modo asincrono dopo la creazione del
 * container: lo status_code resta IN_PROGRESS per diversi secondi. Chiamare
 * /media_publish in quel momento fa fallire con
 * "Media ID is not available", quindi bisogna attendere FINISHED.
 *
 * Limite di 60s: nel caso reale il container è pronto in ~15s, il margine
 * copre rete lenta e video senza rendere la UI bloccata troppo a lungo.
 */
const CONTAINER_TIMEOUT_MS = 60_000;

/**
 * Intervalli crescenti fra un poll e il successivo: subito, poi 1s, 2s, 4s, 8s.
 * L'ultimo valore (8s, il massimo) viene riutilizzato per i tentativi successivi:
 * un ciclo completo dura 15s, quindi in 60s si arrivano a circa 20 interrogazioni.
 */
const CONTAINER_POLL_DELAYS_MS = [0, 1000, 2000, 4000, 8000];

/**
 * Parametri di attesa del container. Opzionali: se omessi si usano i valori
 * sopra. Esposti tramite costruttore perché i test non devono attendere 60s.
 */
type ContainerWaitOptions = {
  containerTimeoutMs?: number;
  pollDelaysMs?: number[];
};

/**
 * Provider Instagram basato sull'Instagram API with Instagram Login (Meta).
 *
 * Flusso: create media container → attesa che il container sia FINISHED →
 * media_publish. L'attesa è necessaria perché Meta elabora il media in modo
 * asincrono (vedi CONTAINER_TIMEOUT_MS).
 * Autenticazione: token IGAA… passato come query param `access_token`.
 * L'ID usato è l'IG User ID restituito da GET /me su graph.instagram.com
 * (NON l'IGUID numerico della Facebook Login).
 */
export class InstagramProvider implements SocialProvider {
  readonly platform: Platform = "INSTAGRAM";

  private readonly containerTimeoutMs: number;
  private readonly pollDelaysMs: number[];

  constructor(options: ContainerWaitOptions = {}) {
    this.containerTimeoutMs = options.containerTimeoutMs ?? CONTAINER_TIMEOUT_MS;
    this.pollDelaysMs = options.pollDelaysMs ?? CONTAINER_POLL_DELAYS_MS;
  }

  get isConfigured() {
    return hasInstagram();
  }

  missingConfig(): string[] {
    const missing: string[] = [];
    if (!config.instagram.token) missing.push("INSTAGRAM_ACCESS_TOKEN");
    if (!config.instagram.accountId)
      missing.push("INSTAGRAM_BUSINESS_ACCOUNT_ID");
    return missing;
  }

  private async graph(path: string, params: Record<string, string>) {
    const url = `${GRAPH_URL}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { method: "POST" });
    const json = (await res.json()) as {
      id?: string;
      error?: { message?: string };
    };
    if (!res.ok || json.error) {
      throw new Error(
        redactSecrets(
          `Instagram Graph API ${res.status}: ${json.error?.message ?? "unknown"}`
        )
      );
    }
    return json;
  }

  /**
   * Attende che un container diventi utilizzabile.
   *
   * Interroga GET /{creationId}?fields=status_code con intervalli crescenti
   * finché lo stato non è FINISHED. Termina con errore esplicito se il
   * container scade (EXPIRED/ERROR) o se il timeout si esaurisce, riportando
   * l'ultimo stato osservato.
   *
   * Il timeout è un limite rigido: se l'attesa successiva porterebbe oltre la
   * deadline, il ciclo termina subito e l'ultimo stato noto viene riportato
   * nell'errore, senza tirare avanti il container oltre il tempo previsto.
   */
  private async waitForContainer(
    creationId: string,
    label: string,
    token: string
  ): Promise<void> {
    const deadline = Date.now() + this.containerTimeoutMs;
    let attempt = 0;
    let lastStatus = "UNKNOWN";

    while (Date.now() < deadline) {
      const delay = this.pollDelaysMs[Math.min(attempt, this.pollDelaysMs.length - 1)];
      // Non dormire oltre la deadline: meglio un errore di timeout puntuale
      // che un'attesa più lunga del previsto. Con delay 0 il primo poll è immediato.
      if (delay >= deadline - Date.now()) break;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      attempt += 1;

      const url = `${GRAPH_URL}/${creationId}?${new URLSearchParams({
        fields: "status_code",
        access_token: token,
      })}`;
      const res = await fetch(url, { method: "GET" });
      const json = (await res.json().catch(() => null)) as {
        status_code?: string;
        error?: { code?: number; message?: string };
      } | null;

      if (!res.ok || json?.error) {
        throw new Error(
          redactSecrets(
            `Instagram Graph API ${res.status} durante l'attesa del container ${label}: ${
              json?.error?.message ?? "unknown"
            }`
          )
        );
      }

      lastStatus = json?.status_code ?? "UNKNOWN";

      if (lastStatus === "FINISHED") return;

      if (lastStatus === "EXPIRED" || lastStatus === "ERROR") {
        throw new Error(
          redactSecrets(
            `Instagram: il container ${label} è ${lastStatus} prima della pubblicazione. Il media non è stato elaborato da Meta: riprova con un'immagine o un video diverso.`
          )
        );
      }
    }

    throw new Error(
      redactSecrets(
        `Instagram: il container ${label} non è pronto dopo ${Math.round(
          this.containerTimeoutMs / 1000
        )}s (ultimo stato: ${lastStatus}). Meta non ha completato l'elaborazione del media: riprova più tardi.`
      )
    );
  }

  /** Crea un container e attende che sia FINISHED. Restituisce il creation_id. */
  private async createReadyContainer(
    params: Record<string, string>,
    token: string,
    label: string
  ): Promise<string> {
    const container = await this.graph(`/${config.instagram.accountId}/media`, {
      ...params,
      access_token: token,
    });
    if (!container.id) {
      throw new Error(
        `Instagram: la creazione del container ${label} non ha restituito un id.`
      );
    }
    await this.waitForContainer(container.id, label, token);
    return container.id;
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    if (!this.isConfigured) {
      return {
        ok: false,
        message: `Account Instagram non configurato. Aggiungi al file .env: ${this.missingConfig().join(", ")}`,
      };
    }
    const accountId = config.instagram.accountId!;
    const token = config.instagram.token!;
    const caption = [payload.caption, payload.hashtags].filter(Boolean).join(" ");

    try {
      if (payload.contentType === "CAROUSEL") {
        if (!payload.mediaUrls.length) {
          return { ok: false, message: "Nessuna immagine per il carousel." };
        }
        const childrenIds: string[] = [];
        // Ogni child va processato da Meta prima di poterlo usare.
        for (const [i, url] of payload.mediaUrls.entries()) {
          const imgUrl = mediaUrl(url);
          if (!imgUrl) {
            return { ok: false, message: NO_PUBLIC_URL };
          }
          const childId = await this.createReadyContainer(
            { image_url: imgUrl, is_carousel_item: "true" },
            token,
            `carousel immagine ${i + 1}/${payload.mediaUrls.length}`
          );
          childrenIds.push(childId);
        }
        // Il container padre va creato solo quando tutti i figli sono pronti.
        const containerId = await this.createReadyContainer(
          {
            media_type: "CAROUSEL",
            children: childrenIds.join(","),
            caption,
          },
          token,
          "carousel"
        );
        const res = await this.graph(`/${accountId}/media_publish`, {
          creation_id: containerId,
          access_token: token,
        });
        return { ok: true, message: "Carousel pubblicato su Instagram.", externalId: res.id };
      }

      if (payload.contentType === "VIDEO") {
        const videoUrl = mediaUrl(payload.videoUrl);
        const fallback = mediaUrl(payload.mediaUrls[0]);
        const finalUrl = videoUrl ?? fallback;
        if (!finalUrl) return { ok: false, message: NO_PUBLIC_URL };
        const containerId = await this.createReadyContainer(
          {
            media_type: "VIDEO",
            video_url: finalUrl,
            caption,
          },
          token,
          "video"
        );
        const res = await this.graph(`/${accountId}/media_publish`, {
          creation_id: containerId,
          access_token: token,
        });
        return { ok: true, message: "Video pubblicato su Instagram.", externalId: res.id };
      }

      const imageUrl = mediaUrl(payload.mediaUrls[0]);
      if (!imageUrl) {
        return { ok: false, message: NO_PUBLIC_URL };
      }
      const containerId = await this.createReadyContainer(
        { image_url: imageUrl, caption },
        token,
        "immagine"
      );
      const res = await this.graph(`/${accountId}/media_publish`, {
        creation_id: containerId,
        access_token: token,
      });
      return { ok: true, message: "Post pubblicato su Instagram.", externalId: res.id };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}