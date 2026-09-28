import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Rocket,
} from "lucide-react";
import { getDashboardStats } from "@/lib/services/stats";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import { NewContentButton } from "@/components/new-content-button";

export const dynamic = "force-dynamic";

/**
 * Dashboard = orientamento, non gestione.
 *
 * Non duplica Calendario, Idee, account social o elenchi di contenuti:
 * mostra solo i numeri che dicono "da dove cominciare" e porta al posto
 * giusto. Il lavoro sui contenuti è in /contents.
 */
export default async function DashboardPage() {
  let stats: Awaited<ReturnType<typeof getDashboardStats>> | null = null;
  try {
    stats = await getDashboardStats();
  } catch (e) {
    console.error("[page:dashboard] caricamento statistiche fallito", e);
  }

  if (!stats) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Panoramica della gestione social.
          </p>
        </div>
        <Card>
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            Impossibile caricare i dati in questo momento.{" "}
            <Link href="/" className="font-medium text-sky-600 hover:text-sky-700">
              Riprova
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const failed = stats.counts.FAILED ?? 0;

  const primary = [
    {
      label: "Da approvare",
      hint: "Bozze in attesa di una decisione",
      value: stats.pendingApproval,
      href: "/contents?view=approvals",
      icon: FileText,
      color: "text-amber-600 bg-amber-100",
    },
    {
      label: "Programmati",
      hint: "In coda di pubblicazione",
      value: stats.counts.SCHEDULED ?? 0,
      href: "/calendar",
      icon: CalendarClock,
      color: "text-sky-600 bg-sky-100",
    },
    {
      label: "Errori",
      hint: "Contenuti da recuperare",
      value: failed,
      href: "/contents?status=FAILED",
      icon: AlertTriangle,
      color: "text-red-600 bg-red-100",
    },
  ];

  const secondary = [
    {
      label: "Approvati",
      value: stats.counts.APPROVED ?? 0,
      href: "/contents?status=APPROVED",
      icon: CheckCircle2,
      color: "text-emerald-600 bg-emerald-100",
    },
    {
      label: "Pubblicati (30g)",
      value: stats.published30d,
      href: "/contents?status=PUBLISHED",
      icon: Rocket,
      color: "text-violet-600 bg-violet-100",
    },
    {
      label: "Media caricati",
      value: stats.mediaCount,
      href: "/media",
      icon: ImageIcon,
      color: "text-slate-600 bg-slate-100",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Crea con l&apos;AI, poi gestisci e approva tutto da Contenuti.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <NewContentButton />
          <LinkButton href="/chat" variant="secondary" size="sm">
            Chiedi all&apos;AI
          </LinkButton>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {primary.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.label}
              href={c.href}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:border-sky-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${c.color}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="text-2xl font-bold text-slate-900">{c.value}</div>
              </div>
              <div className="text-sm font-medium text-slate-800">{c.label}</div>
              <div className="text-xs text-slate-500">{c.hint}</div>
            </Link>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {secondary.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.label}
              href={c.href}
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-sky-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              <div
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${c.color}`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-lg font-bold text-slate-900">{c.value}</div>
                <div className="truncate text-xs text-slate-500">{c.label}</div>
              </div>
            </Link>
          );
        })}
      </div>

      {stats.pendingApproval === 0 && (stats.counts.SCHEDULED ?? 0) === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Niente da fare per ora"
            description="Chiedi all'assistente AI di creare il prossimo contenuto, oppure parti da un'idea."
            action={
              <LinkButton href="/chat" size="sm">
                Crea con l&apos;AI
              </LinkButton>
            }
          />
        </div>
      ) : null}

      <p className="mt-6 text-xs text-slate-400">
        Il flusso è: l&apos;Assistente AI crea la bozza, in Contenuti la
        controlli, approvi, programmi e pubblichi.
      </p>
    </div>
  );
}
