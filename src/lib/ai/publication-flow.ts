/**
 * I due flussi di pubblicazione e chi decide quale si applica.
 *
 * ## La regola
 *
 * I due flussi non si mischiano mai, perché pubblicano cose diverse con
 * garanzie diverse:
 *
 * - **TEASER** (post o video di incuriosimento): parla del luogo con i suoi
 *   visual, non nomina mai prezzi, date o servizi. Non ha bisogno di una
 *   proposta del catalogo e non ne usa i dati commerciali, nemmeno quando
 *   esistono.
 * - **OFFER** (post commerciale/locandina): parte dalla locandina reale di una
 *   proposta del Catalogo, la rigenera graficamente con il template dell'agenzia
 *   e stampa su di essa i dati commerciali estratti. Senza una proposta con
 *   dati sufficienti non esiste: pubblicare un'offerta senza dati veri
 *   significherebbe inventarli.
 *
 * La risoluzione è deterministica e vive qui in un unico punto: tool AI e
 * servizi devono arrivare allo stesso verdetto sugli stessi input, altrimenti
 * un prezzo finirebbe in un teaser (o un teaser senza offerta nel template
 * commerciale) a seconda del percorso di ingresso.
 */

export const PUBLICATION_FLOWS = ["TEASER", "OFFER"] as const;

export type PublicationFlow = (typeof PUBLICATION_FLOWS)[number];

export interface PublicationFlowResolution {
  flow: PublicationFlow;
  /** Perché la richiesta è stata deviata: finisce nei warning del DRAFT. */
  warnings: string[];
}

export interface ResolvePublicationFlowInput {
  /** Il flow esplicitamente richiesto dal modello, se l'ha dichiarato. */
  requested?: string | null;
  /** Il tipo di contenuto: i VIDEO sono teaser per natura. */
  contentType?: string | null;
  /**
   * La proposta collegata può sostenere un'offerta vera (prezzo e date nel
   * catalogo). Senza questo, OFFER non è un'opzione.
   */
  hasUsableOffer?: boolean;
  /** Verdetto in assenza di segnali (default: dipende dal chiamante). */
  defaultFlow?: PublicationFlow;
}

function normalizeRequested(requested: string | null | undefined): string | null {
  const value = requested?.trim().toUpperCase();
  return value ? value : null;
}

/**
 * Risolve il flusso di pubblicazione.
 *
 * Ordine delle decisioni:
 * 1. un VIDEO è sempre teaser: il reel di incuriosimento non stamperebbe mai
 *    un'offerta, e un eventuale "OFFER" richiesto viene rifiutato con un
 *    warning invece di essere applicato in sordina;
 * 2. un flow esplicito vince, ma OFFER è onorato solo se i dati commerciali
 *    realmente esistono: altrimenti si scivola su TEASER dichiarandolo;
 * 3. senza segnali vale il default del chiamante.
 */
export function resolvePublicationFlow(
  input: ResolvePublicationFlowInput
): PublicationFlowResolution {
  const warnings: string[] = [];
  const requested = normalizeRequested(input.requested);

  if (requested && !(PUBLICATION_FLOWS as readonly string[]).includes(requested)) {
    warnings.push(
      `flow "${requested}" sconosciuto: ammessi solo TEASER e OFFER.`
    );
  }

  const isVideo = input.contentType === "VIDEO";
  if (isVideo && requested === "OFFER") {
    warnings.push(
      "flow OFFER non compatibile con un VIDEO: il video è un teaser di incuriosimento, senza dati commerciali."
    );
    return { flow: "TEASER", warnings };
  }

  if (requested === "TEASER") return { flow: "TEASER", warnings };
  if (requested === "OFFER") {
    if (input.hasUsableOffer) return { flow: "OFFER", warnings };
    warnings.push(
      "flow OFFER richiesto ma la proposta non ha dati commerciali sufficienti (prezzo e date nel catalogo): creato come TEASER, senza prezzi né offerte."
    );
    return { flow: "TEASER", warnings };
  }

  const defaultFlow = input.defaultFlow ?? "TEASER";
  if (isVideo && defaultFlow === "OFFER") {
    warnings.push("un VIDEO nasce nel flusso teaser, non nel flusso offerta.");
    return { flow: "TEASER", warnings };
  }
  return { flow: defaultFlow, warnings };
}
