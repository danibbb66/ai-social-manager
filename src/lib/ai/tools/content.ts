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
import { attachStockVisual } from "@/lib/ai/content-stock";
import { resolveCatalogProposalForAi } from "@/lib/services/catalog-ai";
import { materializeCatalogVisual } from "@/lib/services/catalog-visual";
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
      "true = il contenuto nasce dal Catalogo Agenzia: testo e formato editoriale derivano da una proposta reale, e il DRAFT viene creato con il visuale già a terra. Il visuale NON è la locandina del catalogo (quella è promozionale del fornitore e porta il suo logo): è una fotografia ad alta risoluzione generata sulla destinazione, con il template grafico dell'agenzia, il vostro logo/wordmark e i dati dell'offerta. Se il visuale non si può comporre non viene creato alcun DRAFT. Usalo SEMPRE per i post su una destinazione dell'agenzia, e anche quando l'utente non ha indicato una destinazione precisa."
    ),
  destination: z
    .string()
    .optional()
    .describe(
      "Destinazione da promuovere (es. \"Rodi\"). Deve esistere come proposta ATTIVA nel Catalogo: se non esiste, il tool NON crea nulla. Con \"fromCatalog\": true il DRAFT nasce anche con il visuale."
    ),
  catalogProposalId: z
    .string()
    .optional()
    .describe(
      "Id esatto della proposta di Catalogo, preso da searchCatalog. Ha la precedenza su destination ed evita ogni ambiguità sulla selezione."
    ),
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
      "Legacy/compatibilità: non usato. Non controlla il visuale del flusso catalogo, che lo materializza da solo, e non produce immagini nel ramo senza catalogo. Non passarlo."
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
 * Creazione ancorata a una proposta reale del Catalogo, visuale compreso.
 *
 * Quattro garanzie, tutte applicative e testabili:
 * 1. senza una proposta ACTIVE e utilizzabile non viene creato nulla, e il
 *    messaggio dice al modello cosa rispondere all'utente;
 * 2. la copy è derivata dalla proposta, non dal topic: se il catalogo non ha
 *    prezzo o date, il testo non li nomina e il format non può essere OFFER;
 * 3. il visuale nasce insieme al DRAFT. Qui non viene creato nessun Content:
 *    la persistenza è delegata a `materializeCatalogVisual`, che porta a terra
 *    la fotografia generata, la compone con il template dell'agenzia e scrive
 *    contenuto e asset nella stessa transazione. Un DRAFT senza visuale non deve
 *    esistere, quindi non deve esistere nemmeno per un istante;
 * 4. il DRAFT resta collegato alla proposta e dichiara da quale immagine del
 *    catalogo arrivano i dati, ma **il visuale non è quella immagine**: è la
 *    creatività dell'agenzia, e la locandina del fornitore resta fuori dagli
 *    asset del contenuto.
 *
 * Questa funzione orchestra e basta. Download, generazione, composizione,
 * scelta della fonte, transazione, rollback e idempotenza stanno nel servizio:
 * ripeterle qui darebbe al catalogo due versioni della stessa logica da tenere
 * allineate, e il giorno in cui cambiano i dati del visuale una delle due
 * mentirebbe.
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

  // 1. Il visuale, e con esso il DRAFT. Il servizio genera la fotografia,
  //    compone il fotogramma con il template dell'agenzia e scrive tutto
  //    insieme; l'originale del catalogo resta fuori, come provenienza.
  const materialized = await materializeCatalogVisual({
    proposal,
    direction: visualDirection,
    copy,
    platforms: parsed.platforms,
    type: parsed.type,
    // Fissare la proposta per id è una richiesta esatta: un DRAFT preesistente
    // è la sua ripetizione idempotente e va dichiarata in `reused`. Risolta per
    // destinazione, il DRAFT è quella della destinazione: nessun riuso di un'
    // altra, nessuna dichiarazione.
    pinnedById: Boolean(parsed.catalogProposalId?.trim()),
  });

  if (!materialized.ok) {
    // 2. Fallimento dichiarato, non aggirato: nessun DRAFT, nessun asset, e
    //    il modello riceve il codice per capire se riprovare o segnalare.
    return {
      ok: false,
      message:
        `Nessun contenuto creato: ${materialized.message} ` +
        (materialized.needsGeneration
          ? "Se l'utente vuole comunque un post, proponigli un'altra proposta del Catalogo."
          : "Non aggirare il problema con un'immabricata: riferiscilo all'utente."),
      data: {
        catalogFailure: materialized.reason,
        createdContentId: null,
        assetId: null,
        catalogProposalId: proposal.id,
        proposalName: proposal.name,
        editorialFormat: format,
        visualDirection: materialized.direction,
        needsGeneration: materialized.needsGeneration,
        failureDetail: materialized.detail ?? null,
        warnings,
      },
    };
  }

  // 3. Il contenuto esiste: una lettura in più per restituire al modello la
  //    stessa vista sintetica degli altri tool (piattaforme, tipo, caption),
  //    senza indovinare nulla su ciò che il servizio non ha restituito.
  const stored = await svcGet(materialized.content.id);
  const brief = stored
    ? contentBriefView(stored)
    : {
        id: materialized.content.id,
        title: materialized.content.title,
        status: materialized.content.status,
      };

  const reused = materialized.reused;

  return {
    ok: true,
    // Il messaggio che l'agente rilegge all'utente: due frasi, niente altro.
    //
    // Prima qui finivano id, formato, origine del visuale, id dell'asset e la
    // lista dei warning. Erano log di esecuzione, non un messaggio: l'utente
    // che chiede "crea un post" vuole sapere se è stato creato e dove trovarlo,
    // non com'è stata scattata l'immagine. I dettagli restano in `data`, dove
    // il modello li legge se servono e l'utente no.
    //
    // Il riuso ha una frase sua perché è un fatto, non un dettaglio: se l'utente
    // chiede due post e ne ottiene uno, dirgli "creato con successo" sarebbe
    // una risposta falsa. Il nome della proposta resta, perché è l'unica parte
    // del messaggio che l'utente può non aver in testa.
    message: reused
      ? `Esisteva già una bozza per "${proposal.name}": non ne ho creata un'altra.`
      : "Post creato con successo in stato DRAFT. Lo trovi nella sezione Contenuti.",
    data: {
      ...brief,
      catalogProposalId: proposal.id,
      proposalName: proposal.name,
      destination: proposal.destination,
      place: placeOf(proposal),
      editorialFormat: format,
      availableFormats: availableFormats(proposal),
      // Nel riuso è la direzione già registrata, non quella di adesso: il
      // visuale a terra è quello di prima e il servizio non finge il contrario.
      visualDirection: materialized.direction,
      visualOrigin: materialized.origin,
      visualReused: materialized.reused,
      withMedia: true,
      assetId: materialized.asset.id,
      // Dichiarato perché il modello non dica all'utente "post con la locandina
      // del catalogo": il fotogramma è nostro, e i dati dell'offerta arrivano
      // dalla proposta.
      visualTemplate: materialized.metadata.template,
      printedTitle: materialized.metadata.printedTitle,
      brandMark: materialized.metadata.brandMark,
      offerDataPrinted: materialized.metadata.commercialLines,
      commercialFieldsPresent: proposal.commercialFieldsPresent,
      provenance: {
        sourceUrl: proposal.sourceUrl,
        sourceType: proposal.sourceType,
        sourcePage: proposal.source.pageUrl,
        authority: proposal.source.authority,
      },
      warnings,
    },
  };
}

export const createContentTool: AiTool = {
  name: "createContent",
  description:
    "Crea un nuovo Content in DRAFT: titolo, caption, hashtag, piattaforme e visual. È il tool da usare quando l'utente chiede di creare un post, un reel o un contenuto: non serve alcun contentId, perché il contenuto è nuovo. " +
    "Passa sempre \"topic\" con l'argomento esatto chiesto (es. \"proposta Calabria\"): è un vincolo, titolo, testo e hashtag devono parlare solo di quello. Qualsiasi destinazione o argomento è ammesso, presente o meno nel Catalogo: crea il contenuto richiesto senza verificare l'esistenza della destinazione nel Catalogo. " +
    "\"platforms\" è SEMPRE un array, es. [\"INSTAGRAM\", \"FACEBOOK\"], mai la stringa. \"type\" è \"POST\" o \"VIDEO\". " +
    "Se l'utente chiede N post (es. \"3 post\", \"1 Grecia + 1 Maldive\") puoi chiamarlo PIÙ VOLTE nello stesso turno, una chiamata per post: ne crea TUTTI senza fermarti al primo. Usa un \"format\" diverso per ciascuno (STORYTELLING, TRAVEL_TIPS, ITINERARY, INSPIRATION, HERO_DESTINATION, FAQ) e un tema/angolazione diversa. Per un solo post basta una chiamata. " +
    "Per i CAROUSEL usa createCarousel. Ritorna l'id del contenuto creato. " +
    "SENZA catalogo (solo \"topic\"): il visual viene SEMPRE recuperato cercandolo nella libreria stock (Magnific/Media) in base alla destinazione e applicandovi il layout/template, quindi il DRAFT nasce sempre con il suo visual già collegato. Se la libreria non ha nessuna immagine per quella destinazione, il visual viene GENERATO con il provider immagini su un prompt fotografico: il post non viene bloccato e il tool ti dice esplicitamente che l'immagine è generata e non reale. Se nemmeno la generazione riesce non viene creato alcun DRAFT (ok:false con il motivo), perché nessun post deve restare senza visual. " +
    "Solo se l'utente chiede esplicitamente di ancorare il contenuto a una proposta del Catalogo passa \"fromCatalog\": true con \"destination\", oppure con \"catalogProposalId\" se l'hai già: il testo e il formato editoriale derivano dalla proposta reale, e il DRAFT nasce COMPLETO, visuale incluso. Il visuale è SEMPRE una vostra creatività e non la locandina del catalogo: una fotografia ad alta risoluzione generata sul tema della destinazione, con il template grafico dell'agenzia, il vostro logo (o il wordmark con il nome dell'agenzia) e i dati dell'offerta che il catalogo contiene davvero. La locandina del fornitore non viene usata come immagine né allegata al post. Se il visuale non può essere composto non viene creato alcun DRAFT: il tool ti restituisce ok:false con il motivo, e tu non devi riprovare a creare un contenuto a metà. " +
    "\"withMedia\" è un parametro legacy/compatibilità: non controlla il visuale del flusso catalogo, non passarlo e non aspettarti che produca nulla. ",
  brief: "Creazione contenuto",
  schema: createSchema,
  execute: async (args) => {
    const parsed = createSchema.parse(args);

    // Flusso catalogo: attivo solo con un ancoraggio esplicito (fromCatalog o
    // id di proposta). La destinazione da sola non lo attiva: una richiesta
    // qualsiasi, per una destinazione presente o meno nel Catalogo, crea il
    // DRAFT senza controlli di esistenza sul Catalogo.
    const catalogFlow =
      parsed.fromCatalog === true || Boolean(parsed.catalogProposalId?.trim());

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
    // Va letto subito: più sotto `content` viene riassegnato da `svcUpdate`, che
    // non riporterebbe le anomalie di relazione.
    const relationWarnings = content.relationWarnings ?? [];
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
      // Il formato e la destinazione guidano la struttura di titolo e caption:
      // senza, un post di consigli e un hero sulla stessa destinazione
      // produrrebbero lo stesso testo.
      format: parsed.format ?? null,
      destination: parsed.destination ?? null,
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

    // 2. Visual: dalla libreria stock; generato solo se la libreria è vuota per
    //    quella destinazione. Qui non esiste un DRAFT senza immagine: se neppure
    //    la generazione riesce il contenuto appena scritto viene annullato e il
    //    tool risponde ok:false, perché "post senza visual" non è uno stato
    //    valido.
    const visual = await attachStockVisual({
      contentId: content.id,
      destination: parsed.destination ?? null,
      topic,
      title: content.title,
      format: parsed.format ?? null,
    });

    if (visual.status === "failed") {
      await svcDelete(content.id);
      return {
        ok: false,
        message:
          `Nessun contenuto creato: ${visual.reason} ` +
          `Il DRAFT non è stato scritto, perché nessun post deve restare senza visual.`,
        data: {
          createdContentId: null,
          assetId: null,
          stockQuery: visual.query,
          withMedia: false,
          warnings,
        },
      };
    }

    if (!visual.templateApplied) {
      warnings.push(
        "layout/template non applicato alla foto stock: l'immagine è stata collegata così come recuperata."
      );
    }
    // Il marchio è dichiarato sempre, anche quando è il wordmark: un post con
    // il logo file e un post con il nome dell'agenzia non sono la stessa
    // creatività, e il modello deve saperlo prima di consigliare all'utente.
    if (visual.templateApplied && !visual.hasBrandLogo) {
      warnings.push(
        "nessun marchio stampato sull'overlay: il brand non ha né un logo caricato né un nome."
      );
    }
    // Un ideaId inesistente non viene scritto: il servizio lo dichiara invece di
    // far fallire la creazione, e il modello deve saperlo per non ripeterlo.
    warnings.push(...relationWarnings);
    if (visual.generated) {
      // Va detto chiaramente al modello e all'utente: è una fotografia
      // plausibile, non la foto reale del posto.
      warnings.push(
        `visual generato con "${visual.source}" perché la libreria stock non aveva immagini per "${visual.query}": ` +
          "non è una foto reale del luogo, valuta se tenerlo o sostituirlo con una della libreria."
      );
    }

    const fresh = await svcGet(content.id);

    // I dettagli che il modello deve poter leggere senza infastidire l'utente.
    // Stanno qui e non nel messaggio: l'utente chiede "crea un post", non "crea
    // un post e dimmi da quale provider è arrivata l'immagine". Il modello li
    // usa per decidere e per rispondere a una domanda di follow-up.
    const execution = {
      visualSource: visual.source,
      visualGenerated: visual.generated,
      stockQuery: visual.query,
      template: visual.template,
      templateApplied: visual.templateApplied,
      brandMark: visual.brandMark,
      // La rubrica stampata sul fotogramma: senza, il modello direbbe all'utente
      // che il post è "sulla destinazione" senza dire che è un consiglio.
      kicker: visual.kicker,
    };

    return {
      ok: true,
      message: `Post creato con successo in stato DRAFT. Lo trovi nella sezione Contenuti.`,
      data: {
        ...contentBriefView(fresh ?? content),
        topic: topic || null,
        editorialFormat: parsed.format ?? null,
        withMedia: true,
        assetId: visual.assetId,
        ...execution,
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
      // L'id resta in `data`: un identificativo di database non aiuta l'utente
      // a trovare un post e nel testo finirebbe per essere letto come un errore.
      return {
        ok: false,
        message: "Il contenuto indicato non esiste. Controlla l'elenco dei contenuti.",
        data: { contentId: parsed.contentId },
      };
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
