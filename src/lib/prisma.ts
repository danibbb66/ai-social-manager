import { PrismaClient } from "@prisma/client";

/**
 * Limite esplicito del pool di connessioni PostgreSQL.
 *
 * Su Vercel (serverless) `os.cpus().length` riporta i core dell'HOST condiviso,
 * non quelli della funzione: senza un limite esplicito Prisma apre
 * `num_cpu * 2 + 1` connessioni PER istanza (anche decine/centinaia), e ogni
 * cold start crea una nuova istanza. Supabase (Supavisor, modalità session) ha
 * un pool fisso (pool_size 15): la prima raffica lo esaurisce e l'app torna
 * "FATAL: max clients reached in session mode". Un limite basso tiene il totale
 * sotto il pool anche con più container in esecuzione. L'app è un gestionale
 * mono-utente con query brevissime: 1 connessione per istanza è più che
 * sufficiente (le query in parallelo si accodano, senza mai sforare).
 */
const CONNECTION_LIMIT = 1;

/**
 * Aggiunge `connection_limit` all'URL di connessione se non è già presente,
 * preservando eventuali altri parametri di query (es. `?schema=...`).
 */
function withConnectionLimit(url: string | undefined): string | undefined {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + `connection_limit=${CONNECTION_LIMIT}`;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const dbUrl = withConnectionLimit(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
    // Solo se c'è una URL: se manca, si lascia che Prisma legga `env("DATABASE_URL")`
    // dallo schema e produca il suo errore standard (più leggibile).
    ...(dbUrl ? { datasources: { db: { url: dbUrl } } } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
