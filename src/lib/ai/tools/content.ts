import { z } from "zod";
import {
  createContent as svcCreate,
  updateContent as svcUpdate,
  getContent as svcGet,
  listContents as svcList,
  duplicateContent as svcDuplicate,
  deleteContent as svcDelete,
} from "@/lib/services/content";
import { AiTool, contentBriefView } from "@/lib/ai/tools/types";
import { platformsField, hashtagsField } from "@/lib/ai/tools/schemas";
import { fallbackCopyFromTopic } from "@/lib/ai/content-copy";
import { resolveCatalogProposalForAi } from "@/lib/services/catalog-ai";
import {
  CONTENT_FORMATS,
  availableFormats,
  buildVisualDirection,
  catalogCopyFromProposal,
  pickEditorialFormat,
  placeOf,
  type ContentFormat,
} from "@/lib/ai/catalog-content";

const TYPES = z.enum(["POST", "CAROUSEL", "VIDEO"]);

const createSchema = z.object({
  type: z
    .enum(["POST", "VIDEO"])
    .optional()
    .describe(
      "Tipo contenuto. IMPORTANTE: per i CAROUSEL usa lo strumento dedicato createCarousel, NON createContent."
    ),
  topic: z
    .string()
    .optional()
    .describe(
      "Argomento/destinazione esatta richiesta dall'utente (es. 'proposta Calabria'). È un VINCOLO: titolo, caption, hashtag e immagine devono parlare solo di questo. Ripasalo sempre, anche se l'hai già usato per scrivere la caption."
    ),
  fromCatalog: z
    .boolean()
    .optional()
    .describe(
      "true = il contenuto nasce dal Catalogo Agenzia: il testo, il formato editoriale e la direzione visual derivano da una proposta reale del catalogo. Usalo SEMPRE per i post su una destinazione dell'agenzia, e anche quando l'utente non ha indicato una destinazione precisa."
    ),
  destination: z
    .string()
    .optional()
    .describe(
      "Destinazione da promuovere (es. \"Rodi\"). Deve esistere come proposta ATTIVA nel Catalogo: se non esiste, il tool NON crea nulla."
    ),
  catalogProposalId: z
    .string()
    .optional()
    .describe("Id esatto della propostaCatalogo, preso da searchCatalog. Ha la precedenza su destination."),
  format: z
    .enum(CONTENT_FORMATS)
    .optional()
    .describe(
      "Formato editoriale. Viene scelto dal codice in base ai dati disponibili se lo ometti: non forzare OFFER senza prezzi e date reali."
    ),
  title: z.string().optional().describe("Titolo breve del contenuto"),
  caption: z.string().optional().describe("Testo/caption da pubblicare"),
  hashtags: hashtagsField.optional(),
  platforms: platformsField.optional(),
  withMedia: z
    .boolean()
    .optional()
    .describe(
      "Non usato: questo tool non genera immagini AI. Il visual si aggiunge dopo, dalla Media Library o con generateImage su richiesta esplicita."
    ),
  ideaId: z.string().optional().describe("Id di un'idea collegata, se serve"),
});

const updateSchema = z.object({
  contentId: z.string().describe("Id del contenuto da modificare"),
  type: TYPES.optional(),
  title: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  hashtags: hashtagsField.nullable().optional(),
  platforms: platformsField.optional(),
  scheduledDate: z.string().nullable().optional().describe("Data ISO per la programmazione"),
});

/**
 * Creazione ancorata a una proposta reale del Catalogo.
 *
 * Tre garanzie, tutte applicative e testabili:
 * 1. senza una proposta ACTIVE e utilizzabile non viene creato nulla, e il
 *    messaggio dice al modello cosa rispondere all'utente;
 * 2. la copy è derivata dalla proposta, non dal topic: se il catalogo non ha
 *    prezzo o date, il testo non li nomina e il format non può essere OFFER;
 * 3. il DRAFT nasce collegato alla proposta, così risale a fonte, pagina e
 *    tipo di provenienza.
 *
 * Nessuna immagine viene generata: si registra solo la direzione visual.
 */
async function createFromCatalog(parsed: z.infer<typeof createSchema>) {
  const resolution = await resolveCatalogProposalForAi({
    proposalId: parsed.catalogProposalId ?? null,
    destination: parsed.destination ?? null,
  });

  if (!resolution.ok) {
    return {
      ok: false,
      message: resolution.message,
      data: {
        catalogFailure: resolution.reason,
        createdContentId: null,
        searchHint: "Usa searchCatalog per vedere cosa c'è davvero nel Catalogo.",
      },
    };
  }

  const proposal = resolution.proposal;
  const { format, warnings } = pickEditorialFormat(
    proposal,
    parsed.format as ContentFormat | undefined
  );
  const copy = catalogCopyFromProposal(proposal, format);
  const visualDirection = buildVisualDirection(proposal, format);

  if (parsed.caption || parsed.title || parsed.hashtags) {
    warnings.push(
      "testo ricevuto dal modello ignorato: nel flusso catalogo la copy deriva dalla proposta."
    );
  }
  warnings.push(
    `copy derivata dal Catalogo (proposta "${proposal.name}"): da rivedere e rifinire a mano.`
  );
  if (!copy.usesCommercialData) {
    warnings.push(
      "nessun dato commerciale in catalogo per questa proposta: la copy non cita prezzi, date, durata o servizi."
    );
  }

  const content = await svcCreate({
    type: parsed.type,
    title: copy.title,
    caption: copy.caption,
    hashtags: copy.hashtags || null,
    platforms: parsed.platforms,
    catalogProposalId: proposal.id,
  });

  const visual = visualDirection.useOfficialImage
    ? "direzione visual basata sull'immagine ufficiale del catalogo, nessuna generazione necessaria"
    : "nessuna immagine nel catalogo: visual da generare in un secondo momento";

  return {
    ok: true,
    message:
      `Contenuto "${content.title}" creato (id ${content.id}, stato ${content.status}) ` +
      `dalla proposta di catalogo "${proposal.name}" (formato ${format}, ${visual}). ` +
      `Attenzione: ${warnings.join("; ")}.`,
    data: {
      ...contentBriefView(content),
      catalogProposalId: proposal.id,
      proposalName: proposal.name,
      destination: proposal.destination,
      place: placeOf(proposal),
      editorialFormat: format,
      availableFormats: availableFormats(proposal),
      visualDirection,
      commercialFieldsPresent: proposal.commercialFieldsPresent,
      provenance: {
        sourceUrl: proposal.sourceUrl,
        sourceType: proposal.sourceType,
        sourcePage: proposal.source.pageUrl,
        authority: proposal.source.authority,
      },
      warnings,
      withMedia: false,
      assetId: null,
    },
  };
}

export const createContentTool: AiTool = {
  name: "createContent",
  description:
    "Crea un nuovo Content in DRAFT: titolo, caption, hashtag e piattaforme. È il tool da usare quando l'utente chiede di creare un post, un reel o un contenuto: non serve alcun contentId, perché il contenuto è nuovo. Per i post dell'agenzia usa il flusso catalogo: prima cerca con searchCatalog, poi passa \"fromCatalog\": true e \"destination\" (o \"catalogProposalId\"): il testo, il formato editoriale e la direzione visual derivano dalla proposta reale. Se la destinazione non è nel catalogo, il tool NON crea nulla e non devi inventare l'offerta. NON genera immagini AI: il contenuto nasce senza visual e si completa dalla Media Library; usa generateImage solo se l'utente chiede esplicitamente un'immagine. Passa sempre \"topic\" con l'argomento esatto chiesto (es. \"proposta Calabria\"): è un vincolo, titolo, testo e hashtag devono parlare solo di quello. \"platforms\" è SEMPRE un array, es. [\"INSTAGRAM\", \"FACEBOOK\"], mai la stringa. \"type\" è \"POST\" o \"VIDEO\". Chiamalo una sola volta per richiesta e poi riferisciti al contenuto creato. Per i CAROUSEL usa createCarousel. Ritorna l'id del contenuto creato.",
  brief: "Creazione contenuto",
  schema: createSchema,
  execute: async (args) => {
    const parsed = createSchema.parse(args);

    // Flusso catalogo: attivo se il modello chiede esplicitamente di ancorare
    // al Catalogo Agenzia, oppure se indica una destinazione o una proposta.
    // La scelta è applicativa, non affidata al prompt: senza una proposta
    // reale non nasce nessun DRAFT.
    const catalogFlow =
      parsed.fromCatalog === true ||
      Boolean(parsed.destination?.trim()) ||
      Boolean(parsed.catalogProposalId?.trim());

    if (catalogFlow) {
      return createFromCatalog(parsed);
    }

    let content = await svcCreate({
      type: parsed.type,
      title: parsed.title,
      caption: parsed.caption,
      hashtags: parsed.hashtags,
      platforms: parsed.platforms,
      ideaId: parsed.ideaId,
    });

    const warnings: string[] = [];
    const topic =
      parsed.topic?.trim() ||
      parsed.title?.trim() ||
      content.caption?.slice(0, 80).trim() ||
      "";

    // 1. Campi testuali mancanti: completati in modo deterministico dal topic
    //    vincolante, senza chiamare il modello (niente latenza, niente rischio
    //    che il testoCompletion scivoli su un'altra destinazione). Un campo già
    //    valorizzato dal modello non viene mai toccato.
    const fallback = fallbackCopyFromTopic({
      topic,
      title: content.title,
      caption: content.caption,
      hashtags: content.hashtags,
    });
    if (fallback.title || fallback.caption || fallback.hashtags) {
      // updateContent ricrea le piattaforme solo se ricevono l'elenco:
      // vanno ripassate, altrimenti il DRAFT le perderebbe.
      content = await svcUpdate(content.id, {
        title: fallback.title ?? undefined,
        caption: fallback.caption ?? undefined,
        hashtags: fallback.hashtags ?? undefined,
        platforms: content.platforms.map((p) => p.platform),
      });
      warnings.push(
        "completati i campi mancanti dal topic: da rivedere e rifinire a mano."
      );
    }

    // 2. Visual: NON generato.
    //    createContent crea testo e piattaforme e basta. Nessuna immagine AI
    //    inventata, nessuna chiamata automatica a Magnific: il DRAFT resta
    //    senza visual e si arricchisce dalla Media Library, oppure con
    //    generateImage quando l'utente lo chiede esplicitamente.
    const fresh = await svcGet(content.id);

    return {
      ok: true,
      message:
        `Contenuto "${content.title}" creato (id ${content.id}, stato ${content.status}). ` +
        "Nessuna immagine AI generata: resta senza visual e si completa dalla Media Library." +
        (warnings.length ? ` Attenzione: ${warnings.join("; ")}.` : ""),
      data: {
        ...contentBriefView(fresh ?? content),
        topic: topic || null,
        withMedia: false,
        assetId: null,
        warnings,
      },
    };
  },
};

export const updateContentTool: AiTool = {
  name: "updateContent",
  description:
    "Aggiorna un contenuto esistente (titolo, testo, hashtag, piattaforme, tipo, data di programmazione). Usalo quando l'utente chiede di modificare/correggere un contenuto esistente indicandone l'id.",
  brief: "Aggiornamento contenuto",
  schema: updateSchema,
  execute: async (args) => {
    const parsed = updateSchema.parse(args);
    const updated = await svcUpdate(parsed.contentId, {
      type: parsed.type,
      title: parsed.title,
      caption: parsed.caption,
      hashtags: parsed.hashtags,
      platforms: parsed.platforms,
      scheduledDate: parsed.scheduledDate,
    });
    return {
      ok: true,
      message: `Contenuto "${updated.title}" aggiornato (id ${updated.id}).`,
      data: contentBriefView(updated),
    };
  },
};

export const getContentTool: AiTool = {
  name: "getContent",
  description:
    "Recupera un singolo contenuto dal database dato il suo id, incluse slide del carousel, asset e piattaforme.",
  brief: "Lettura contenuto",
  schema: z.object({ contentId: z.string().describe("Id del contenuto") }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string() }).parse(args);
    const content = await svcGet(parsed.contentId);
    if (!content) {
      return { ok: false, message: `Contenuto ${parsed.contentId} non trovato.` };
    }
    return {
      ok: true,
      message: `Contenuto trovato: ${content.title ?? "senza titolo"}.`,
      data: {
        ...contentBriefView(content),
        slides: content.slides,
        assets: content.assets.map((a) => ({ kind: a.kind, url: a.url })),
      },
    };
  },
};

export const listContentsTool: AiTool = {
  name: "listContents",
  description:
    "Elenca i contenuti presenti nel database. Accetta filtri opzionali per stato (DRAFT, APPROVED, SCHEDULED, PUBLISHED, REJECTED, FAILED), tipo e testo di ricerca. Usalo quando l'utente chiede 'quali contenuti ho', 'mostrami i post', ecc.",
  brief: "Elenco contenuti",
  schema: z.object({
    status: z.string().optional().describe("Filtro per stato (es. DRAFT, APPROVED)"),
    type: TYPES.optional(),
    search: z.string().optional(),
  }),
  execute: async (args) => {
    const parsed = z.object({ status: z.string().optional(), type: TYPES.optional(), search: z.string().optional() }).parse(args);
    const contents = await svcList({
      status: parsed.status ? (parsed.status.toUpperCase() as never) : undefined,
      type: parsed.type,
      search: parsed.search,
      limit: 40,
    });
    const view = contents.map(contentBriefView);
    return {
      ok: true,
      message: `Trovati ${view.length} contenuti.`,
      data: view,
    };
  },
};

export const duplicateContentTool: AiTool = {
  name: "duplicateContent",
  description:
    "Duplica un contenuto esistente come bozza (DRAFT), includendo slide e supporti. Usalo quando l'utente chiede di duplicare/clonare un post.",
  brief: "Duplicazione contenuto",
  schema: z.object({ contentId: z.string() }),
  execute: async (args) => {
    const parsed = z.object({ contentId: z.string() }).parse(args);
    const dup = await svcDuplicate(parsed.contentId);
    return {
      ok: true,
      message: `Contenuto duplicato: "${dup.title}" (id ${dup.id}).`,
      data: contentBriefView(dup),
    };
  },
};

export const deleteContentTool: AiTool = {
  name: "deleteContent",
  description:
    "Elimina DEFINITIVAMENTE un contenuto dal database. Operazione distruttiva e irreversibile: eseguila solo dopo che l'utente ha confermato esplicitamente nel messaggio successivo, e solo passando confirm=true. Una semplice richiesta di cancellazione NON è una conferma: in quel caso chiedi conferma e non chiamare questo tool.",
  brief: "Eliminazione contenuto",
  schema: z.object({
    contentId: z.string(),
    confirm: z
      .boolean()
      .describe(
        "Deve essere true: conferma esplicita dell'utente all'eliminazione definitiva"
      ),
  }),
  execute: async (args) => {
    const parsed = z
      .object({ contentId: z.string(), confirm: z.boolean() })
      .parse(args);

    if (!parsed.confirm) {
      return {
        ok: false,
        message:
          "Eliminazione NON eseguita: serve la conferma esplicita dell'utente. Chiedigliela e ripeti la chiamata con confirm=true solo dopo un suo 'sì' esplicito.",
      };
    }

    await svcDelete(parsed.contentId);
    return {
      ok: true,
      message: `Contenuto ${parsed.contentId} eliminato definitivamente.`,
    };
  },
};