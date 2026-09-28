import { notFound } from "next/navigation";
import { getContent } from "@/lib/services/content";
import { ContentEditor } from "@/components/content/editor";
import { getApprovalState } from "@/lib/services/approvals";
import { listAssets } from "@/lib/services/media";
import { Card } from "@/components/ui";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ContentEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let content: Awaited<ReturnType<typeof getContent>> | null = null;
  let approvals: Awaited<ReturnType<typeof getApprovalState>> | null = null;
  let library: Awaited<ReturnType<typeof listAssets>> = [];
  try {
    content = await getContent(id);
    if (!content) notFound();
    approvals = await getApprovalState(id);
    library = await listAssets();
  } catch (e) {
    if ((e as { digest?: string }).digest) throw e;
    console.error("[page:content] caricamento fallito", id, e);
    return (
      <div className="mx-auto max-w-5xl">
        <Card>
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            Impossibile caricare il contenuto in questo momento.{" "}
            <Link href="/contents" className="font-medium text-sky-600 hover:text-sky-700">
              Torna ai contenuti
            </Link>
          </div>
        </Card>
      </div>
    );
  }
  if (!content || !approvals) notFound();

  return (
    <ContentEditor
      content={JSON.parse(JSON.stringify(content))}
      approvals={JSON.parse(JSON.stringify(approvals.approvals))}
      hasExplicitApproval={approvals.hasExplicitApproval}
      library={JSON.parse(JSON.stringify(library))}
    />
  );
}