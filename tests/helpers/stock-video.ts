import {
  setStockVideoProvider,
  type StockVideo,
  type StockVideoProvider,
} from "../../src/lib/video/stock";

/**
 * Provider di stock VIDEO finto per i test.
 *
 * `hits` registra le query ricevute; `queue` è la lista di video restituiti.
 * `downloadVideo` restituisce un buffer fasullo con MIME video: il servizio lo
 * salva in /uploads/videos come una clip reale (il montaggio fake non ne legge
 * i byte). Con `queue` vuota la ricerca risponde "nessun video", così nessun
 * test tocca la rete di Magnific.
 */
export interface FakeStockVideoProvider extends StockVideoProvider {
  hits: string[];
  queue: StockVideo[];
}

export function installFakeStockVideo(): FakeStockVideoProvider {
  // Nessun provider esterno reale deve attivarsi durante i test: eventuali
  // chiavi presenti in `.env` (Pexels/Pixabay, caricate da @prisma/client)
  // vengono annullate qui, così risponde SOLO il provider finto con la sua
  // `queue` controllata dal test. Senza questo, una chiave reale farebbe
  // partire chiamate di rete (lente e non deterministiche) al posto del fake.
  process.env.PEXELS_API_KEY = "";
  process.env.PIXABAY_API_KEY = "";

  const provider: FakeStockVideoProvider = {
    name: "fake-stock-video",
    hits: [],
    queue: [],
    async searchVideo(request) {
      provider.hits.push(request.query);
      return provider.queue.slice(0, Math.max(1, request.limit ?? 6));
    },
    async downloadVideo() {
      return { buffer: Buffer.from("fake-mp4-bytes"), mimeType: "video/mp4" };
    },
  };
  setStockVideoProvider(provider);
  return provider;
}

/** Reset dell'override, per il `after` delle suite. */
export function resetStockVideo(): void {
  setStockVideoProvider(null);
}
