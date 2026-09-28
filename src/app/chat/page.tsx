import { Suspense } from "react";
import Link from "next/link";
import { ChatPanel } from "@/components/chat/chat-panel";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { listContents } from "@/lib/services/content";

export const metadata = {
  title: "Assistente AI",
};

export const dynamic = "force-dynamic";

/**
 * Chat è il punto di creazione assistita, non un gestore di contenuti.
 * I contenuti che l'AI crea nascono in stato DRAFT e si aprono da Contenuti,
 * che è il centro operativo. Qui si aggiunge solo un modo per arrivarci.
 */
export default async function ChatPage() {
  let recent: Awaited<ReturnType<typeof listContents>> = [];
  try {
    recent = await listContents({ limit: 5 });
  } catch (e) {
    console.error("[page:chat] caricamento contenuti recenti fallito", e);
  }

  return (
    <>
      <PageHeader
        title="Assistente AI"
        description="Chat con il modello locale (Ollama) per creare contenuti. Ogni contenuto nasce come bozza e si gestisce in Contenuti."
      />
      <Suspense fallback={null}>
        <ChatPanel />
      </Suspense>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Ultimi contenuti</h2>
          {recent.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              Nessun contenuto ancora. Chiedi all&apos;AI di creare il primo post.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {recent.map((c) => (
                <li key={c.id} className="text-xs">
                  <Link
                    href={`/contents/${c.id}`}
                    className="font-medium text-slate-700 hover:text-sky-700"
                  >
                    {c.title ?? "Senza titolo"}
                  </Link>
                  <span className="ml-2 text-slate-400">
                    {formatDate(c.updatedAt, "dd/MM")}
                  </span>
                </li>
              ))}
              <li className="pt-1">
                <Link
                  href="/contents"
                  className="text-xs font-medium text-sky-600 hover:text-sky-700"
                >
                  Vai a Contenuti
                </Link>
              </li>
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Idee salvate</h2>
          <p className="mt-1 text-xs text-slate-500">
            Gli spunti restano separati dai contenuti finché non li sviluppi.
          </p>
          <Link
            href="/ideas"
            className="mt-2 inline-block text-xs font-medium text-sky-600 hover:text-sky-700"
          >
            Apri le idee
          </Link>
        </div>
      </div>
    </>
  );
}
