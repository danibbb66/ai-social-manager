import { Instagram, Facebook, Music2, Share2, KeyRound, CheckCircle2, XCircle } from "lucide-react";
import { listAccounts, platformRequires } from "@/lib/services/accounts";
import { Card, CardHeader, EmptyState, PageHeader, Badge } from "@/components/ui";
import { AccountForm, AccountDeleteButton } from "@/components/accounts";

export const dynamic = "force-dynamic";

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform) {
    case "INSTAGRAM":
      return <Instagram className="h-5 w-5" />;
    case "FACEBOOK":
      return <Facebook className="h-5 w-5" />;
    case "TIKTOK":
      return <Music2 className="h-5 w-5" />;
    default:
      return <Share2 className="h-5 w-5" />;
  }
}

const PLATFORM_COLORS: Record<string, string> = {
  INSTAGRAM: "bg-pink-50 text-pink-600",
  FACEBOOK: "bg-blue-50 text-blue-600",
  TIKTOK: "bg-slate-900 text-white",
};

export default async function SocialPage() {
  let accounts: Awaited<ReturnType<typeof listAccounts>> = [];
  try {
    accounts = await listAccounts();
  } catch (e) {
    console.error("[page:social] caricamento fallito", e);
  }

  const grouped = accounts.reduce<Record<string, typeof accounts>>((acc, a) => {
    (acc[a.platform] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Account social"
        description="Piattaforme collegate e stato delle credenziali."
      />

      <Card className="mb-6">
        <CardHeader
          title="Aggiungi account"
          description="Registra le pagine/profili da usare per la pubblicazione"
        />
        <div className="px-5 py-5">
          <AccountForm />
        </div>
      </Card>

      {accounts.length === 0 ? (
        <EmptyState
          title="Nessun account configurato"
          description="Aggiungi almeno un account per iniziare."
        />
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([platform, list]) => (
            <Card key={platform} className="overflow-hidden">
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-lg ${PLATFORM_COLORS[platform] ?? "bg-slate-100 text-slate-600"}`}
                    >
                      <PlatformIcon platform={platform} />
                    </span>
                    {platform}
                  </span>
                }
                description={platformRequires[platform as keyof typeof platformRequires]}
              />
              <div className="divide-y divide-slate-100">
                {list.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium text-slate-800">
                        {a.name}
                        {!a.active ? (
                          <Badge className="bg-slate-100 text-slate-500 border-slate-200">
                            Disattivo
                          </Badge>
                        ) : null}
                      </div>
                      {a.handle ? (
                        <div className="text-sm text-slate-500">{a.handle}</div>
                      ) : null}
                      <p className="mt-0.5 text-xs text-slate-400">{a.note}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          a.configured ? "text-emerald-600" : "text-amber-600"
                        }`}
                      >
                        {a.configured ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <XCircle className="h-4 w-4" />
                        )}
                        {a.configured ? "Configurato" : "No credenziali"}
                      </span>
                      <AccountDeleteButton id={a.id} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 p-4">
        <p className="flex items-start gap-2 text-xs text-slate-500">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          Lo stato &quot;configurato&quot; si basa sulle credenziali presenti in{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">.env</code>.
          La pubblicazione richiede sempre un&apos;approvazione esplicita del contenuto
          e credenziali valide per la piattaforma.
        </p>
      </Card>
    </div>
  );
}