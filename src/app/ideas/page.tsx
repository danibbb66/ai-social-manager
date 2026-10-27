import { listIdeas } from "@/lib/services/ideas";
import { Card, CardHeader, PageHeader, LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/ui";
import { CreateIdeaForm, DeleteIdeaButton } from "@/components/ideas";
import { timeAgo } from "@/lib/utils";
import { Lightbulb } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
  let ideas: Awaited<ReturnType<typeof listIdeas>> = [];
  try {
    ideas = await listIdeas(80);
  } catch (e) {
    console.error("[page:ideas] caricamento fallito", e);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Idee"
        description="Spunti da trasformare in contenuti social. Un'idea esiste anche senza diventare un contenuto."
      />

      <Card className="mb-6">
        <CardHeader
          title="Nuova idea"
          description="Crea manualmente uno spunto da sviluppare"
        />
        <div className="px-5 py-5">
          <CreateIdeaForm />
        </div>
      </Card>

      {ideas.length === 0 ? (
        <EmptyState
          title="Nessuna idea"
          description="Crea una idea o chiedi all'assistente AI di suggerirti argomenti."
        />
      ) : (
        <div className="space-y-3">
          {ideas.map((idea) => (
            <Card key={idea.id}>
              <div className="flex items-start justify-between gap-3 px-5 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                    <Lightbulb className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                      {idea.title}
                    </h3>
                    {idea.topic ? (
                      <p className="mt-0.5 text-xs text-slate-500">
                        <span className="font-medium">Argomento:</span>{" "}
                        {idea.topic}
                      </p>
                    ) : null}
                    {idea.description ? (
                      <p className="mt-1 text-sm text-slate-600">
                        {idea.description}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-400">
                      {timeAgo(idea.createdAt)}
                    </p>
                  </div>
                </div>
                <DeleteIdeaButton id={idea.id} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 p-4">
        <p className="text-xs text-slate-500">
          Le idee restano una fase a se: <strong>idea → sviluppo → bozza</strong>.
          La bozza creata in Contenuti è quella che poi approvi, programmi e
          pubblichi.
        </p>
      </Card>
    </div>
  );
}