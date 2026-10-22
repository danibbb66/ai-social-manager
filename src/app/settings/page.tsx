import {
  config,
  hasInstagram,
  hasFacebook,
  hasTiktok,
} from "@/lib/env";
import { Card, CardHeader, PageHeader, Badge } from "@/components/ui";
import { Terminal, Database, Lock, Share2 } from "lucide-react";

export const dynamic = "force-dynamic";

function Row({
  label,
  value,
  ok,
  hint,
}: {
  label: string;
  value: string;
  ok?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint ? <div className="text-xs text-slate-400">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <code className="max-w-52 truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
          {value}
        </code>
        {ok !== undefined ? (
          <Badge
            className={
              ok
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }
          >
            {ok ? "OK" : "Mancante"}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Impostazioni"
        description="Configurazione del sistema: credenziali e provider."
      />

      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-slate-500" /> Provider configurati
            </span>
          }
          description="Valori letti dal file .env"
        />
        <div className="divide-y divide-slate-100 px-5 py-2">
          <Row label="Image provider" value={config.imageProvider} hint="manual = solo upload" />
          <Row
            label="Video provider"
            value={config.videoProvider}
            hint="ffmpeg per slideshow/reel locali"
          />
        </div>
      </Card>

      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-indigo-500" /> Credenziali piattaforme
            </span>
          }
          description="Le pubblicazioni usano le API ufficiali. Senza token, gli account restano «non configurati»."
        />
        <div className="divide-y divide-slate-100 px-5 py-2">
          <Row
            label="Instagram Graph API"
            value={config.instagram.token ? "Token presente" : "—"}
            ok={hasInstagram()}
            hint="INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID"
          />
          <Row
            label="Facebook Graph API"
            value={config.facebook.token ? "Token presente" : "—"}
            ok={hasFacebook()}
            hint="FACEBOOK_PAGE_ACCESS_TOKEN + FACEBOOK_PAGE_ID"
          />
          <Row
            label="TikTok Content API"
            value={config.tiktok.token ? "Token presente" : "—"}
            ok={hasTiktok()}
            hint="TIKTOK_ACCESS_TOKEN + TIKTOK_OPEN_ID"
          />
        </div>
      </Card>

      <Card className="mb-6">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Database className="h-4 w-4 text-emerald-500" /> Database
            </span>
          }
        />
        <div className="px-5 py-3">
          <p className="text-sm text-slate-600">
            SQLite locale. Avvia{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
              npm run db:studio
            </code>{" "}
            per esplorare i dati con Prisma Studio.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-slate-500" /> Sicurezza
            </span>
          }
        />
        <div className="px-5 py-4">
          <p className="text-sm text-slate-600">
            Niente credenziali o dati sensibili vengono mai scritti nel database o
            nei log. I token si leggono solo da <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">.env</code>{" "}
            e non sono inclusi nelle risposte dell&apos;assistente AI.
          </p>
        </div>
      </Card>
    </div>
  );
}