import { getBrandOrCreate } from "@/lib/services/brand";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { BrandForm } from "@/components/brand-form";

export const dynamic = "force-dynamic";

export default async function BrandPage() {
  let brand: Awaited<ReturnType<typeof getBrandOrCreate>> | null = null;
  try {
    brand = await getBrandOrCreate();
  } catch (e) {
    console.error("[page:brand] caricamento fallito", e);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Brand"
        description="Identità, tono e regole usate dall'AI per generare contenuti coerenti."
      />

      <Card>
        <CardHeader
          title="Profilo del brand"
          description="Questi dati vengono forniti all'assistente AI come contesto."
        />
        <div className="px-5 py-5">
          <BrandForm
            brand={
              brand
                ? {
                    name: brand.name,
                    description: brand.description,
                    website: brand.website,
                    instagram: brand.instagram,
                    facebook: brand.facebook,
                    tiktok: brand.tiktok,
                    logoUrl: brand.logoUrl,
                    tone: brand.tone,
                    audience: brand.audience,
                    style: brand.style,
                    preferredTopics: Array.isArray(brand.preferredTopics)
                      ? (brand.preferredTopics as string[])
                      : [],
                    forbiddenTopics: Array.isArray(brand.forbiddenTopics)
                      ? (brand.forbiddenTopics as string[])
                      : [],
                    forbiddenWords: Array.isArray(brand.forbiddenWords)
                      ? (brand.forbiddenWords as string[])
                      : [],
                    preferredCtas: Array.isArray(brand.preferredCtas)
                      ? (brand.preferredCtas as string[])
                      : [],
                    colors: (brand.colors as Record<string, string> | null) ?? null,
                    fonts: (brand.fonts as Record<string, string> | null) ?? null,
                  }
                : null
            }
          />
        </div>
      </Card>
    </div>
  );
}