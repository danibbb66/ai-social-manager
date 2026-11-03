import { config } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { redactSecrets } from "@/lib/security";

/**
 * Token Instagram long-lived con rinnovo automatico.
 *
 * Il token IGAA… (Instagram API with Instagram Login) scade dopo 60 giorni.
 * Meta permette di rinnovarlo con `GET /refresh_access_token`: ogni rinnovo
 * restituisce un token nuovo valido altri 60 giorni. Il cron giornaliero
 * chiama `refreshInstagramAccessToken()`, così con l'app in uso la catena non
 * scade mai. Il token rinnovato vive nel DB (AppSetting): le variabili
 * d'ambiente di Vercel non sono scrivibili a runtime.
 *
 * Priorità della sorgente:
 *  1. se l'utente ha CAMBIATO manualmente INSTAGRAM_ACCESS_TOKEN su Vercel
 *     (valore diverso dall'ultimo visto), vince l'env e il DB si allinea;
 *  2. altrimenti vince il token rinnovato nel DB;
 *  3. in assenza di entrambi, l'env originale.
 *
 * Nota: se l'app resta spenta/inutilizzata per più di 60 giorni la catena si
 * interrompe comunque (il token muore prima del rinnovo successivo) e il
 * token va rigenerato a mano da Meta.
 */

const TOKEN_KEY = "instagram_access_token";
const ENV_SEEN_KEY = "instagram_access_token_env_seen";

type SettingRow = { key: string; value: string };

async function readSettings(keys: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows: SettingRow[] = await prisma.appSetting.findMany({
      where: { key: { in: keys } },
      select: { key: true, value: true },
    });
    for (const r of rows) map.set(r.key, r.value);
  } catch {
    // DB non raggiungibile (build, test senza DB): si ricade sull'env.
  }
  return map;
}

async function writeSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * Il token Instagram attualmente valido: quello rinnovato nel DB, oppure
 * quello dell'env se l'utente lo ha aggiornato manualmente.
 */
export async function getInstagramAccessToken(): Promise<string | null> {
  const envToken = config.instagram.token?.trim() || null;
  const settings = await readSettings([TOKEN_KEY, ENV_SEEN_KEY]);
  const dbToken = settings.get(TOKEN_KEY) || null;
  const envSeen = settings.get(ENV_SEEN_KEY) || null;

  // L'utente ha cambiato il token su Vercel: vince lui, il DB si allinea.
  if (envToken && envToken !== envSeen) {
    try {
      await writeSetting(TOKEN_KEY, envToken);
      await writeSetting(ENV_SEEN_KEY, envToken);
    } catch {
      // scrittura fallita: si usa comunque il token env per questa richiesta
    }
    return envToken;
  }

  return dbToken ?? envToken;
}

/**
 * Rinnova il token Instagram presso Meta e lo salva nel DB.
 * Chiamato dal cron giornaliero: Meta consente un rinnovo ogni 24h, quindi
 * una chiamata al giorno rientra nel limite. Un fallimento NON blocca il
 * dispatch: viene solo registrato in audit (il token attuale resta valido
 * fino alla sua scadenza naturale).
 */
export async function refreshInstagramAccessToken(): Promise<{
  refreshed: boolean;
  message: string;
}> {
  const current = await getInstagramAccessToken();
  if (!current) {
    return { refreshed: false, message: "Token Instagram assente: niente da rinnovare." };
  }

  try {
    const url =
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` +
      `&access_token=${encodeURIComponent(current)}`;
    const res = await fetch(url);
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: { message?: string };
    };

    if (!res.ok || json.error || !json.access_token) {
      const message = redactSecrets(
        `Rinnovo token Instagram fallito: ${json.error?.message ?? `HTTP ${res.status}`}`
      );
      await logAudit("IG_TOKEN_REFRESH_FAILED", "AppSetting", TOKEN_KEY, { message });
      return { refreshed: false, message };
    }

    await writeSetting(TOKEN_KEY, json.access_token);
    const days = json.expires_in ? Math.round(json.expires_in / 86400) : 60;
    const message = `Token Instagram rinnovato automaticamente (valido ~${days} giorni).`;
    await logAudit("IG_TOKEN_REFRESHED", "AppSetting", TOKEN_KEY, { days });
    return { refreshed: true, message };
  } catch (e) {
    const message = redactSecrets(
      `Rinnovo token Instagram fallito: ${e instanceof Error ? e.message : String(e)}`
    );
    try {
      await logAudit("IG_TOKEN_REFRESH_FAILED", "AppSetting", TOKEN_KEY, { message });
    } catch {
      // anche l'audit fallisce: niente da fare, il dispatch non si ferma
    }
    return { refreshed: false, message };
  }
}
