import { z } from "zod";
import { AiTool } from "@/lib/ai/tools/types";
import { searchCatalogForAi, type CatalogProposalDto } from "@/lib/services/catalog-ai";

/**
 * Vista compatta per il modello.
 *
 * Tiene i campi che il modello deve poter confrontare (id, nome, destinazione,
 * immagine, quali dati commerciali esistono, provenienza) e lascia fuori il
 * dettaglio dei valori commerciali: per scegliere una proposta basta sapere se
 * esistono, non leggere i numeri.
 */
function dtoBrief(dto: CatalogProposalDto) {
  return {
    id: dto.id,
    name: dto.name,
    destination: dto.destination,
    usable: dto.usable,
    unusableReason: dto.unusableReason,
    hasOfficialImage: dto.officialImage !== null,
    officialImageUrl: dto.officialImage?.url ?? null,
    commercialFieldsPresent: dto.commercialFieldsPresent,
    commercialSummary: {
      dates: dto.commercialFieldsPresent.some((f) => f === "periodStart" || f === "periodEnd"),
      price: dto.commercialFieldsPresent.some((f) => f === "priceFrom" || f === "priceTo"),
      duration: dto.commercialFieldsPresent.includes("durationNights"),
      services: dto.commercialFieldsPresent.some((f) => f === "included" || f === "excluded"),
    },
    provenance: {
      sourceUrl: dto.sourceUrl,
      sourceType: dto.sourceType,
      sourcePage: dto.source.pageUrl,
      sourceKind: dto.source.kind,
      authority: dto.source.authority,
    },
    anomalies: dto.anomalies.map((a) => a.code),
  };
}

export const searchCatalogTool: AiTool = {
  name: "searchCatalog",
  brief: "Ricerca Catalogo Agenzia",
  description:
    "Cerca nel Catalogo Agenzia le proposte di viaggio pubblicate sul sito, con la loro provenienza. È una lettura opzionale e mai bloccante: serve a conoscere le offerte reali, non a decidere se un contenuto può essere creato. Passa la destinazione in \"query\" (es. \"Rodi\", \"Maldive\") oppure omettilo per l'elenco delle proposte utilizzabili, ordinate per idoneità. Ogni proposta porta anche quali dati commerciali esistono davvero: se sono assenti, non scrivere prezzi, date, durata o servizi.",
  schema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Destinazione o testo da cercare (es. \"Rodi\", \"Maldive\", \"City Break\"). Omettilo per l'elenco delle proposte utilizzabili."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe("Quante proposte restituire (max 8, default 8)"),
  }),
  execute: async (args) => {
    const parsed = z
      .object({ query: z.string().optional(), limit: z.number().int().min(1).max(8).optional() })
      .parse(args);

    const result = await searchCatalogForAi({
      query: parsed.query ?? null,
      limit: parsed.limit,
    });

    if (result.proposals.length === 0) {
      const target = result.query ? ` per "${result.query}"` : "";
      return {
        ok: false,
        message:
          `Nessuna proposta del Catalogo${target}. ` +
          "Questa ricerca non blocca nulla: puoi comunque creare il contenuto richiesto passando l'argomento a createContent con \"topic\".",
        data: { total: 0, proposals: [] },
      };
    }

    const usable = result.proposals.filter((p) => p.usable).length;
    return {
      ok: true,
      message:
        `Trovate ${result.total} proposte${result.query ? ` per "${result.query}"` : ""}, ` +
        `${usable} utilizzabili. Ne mostro ${result.proposals.length}.`,
      data: {
        total: result.total,
        query: result.query,
        proposals: result.proposals.map(dtoBrief),
      },
    };
  },
};
