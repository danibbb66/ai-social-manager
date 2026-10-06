import sharp from "sharp";
import type { Prisma } from "@prisma/client";
import { setStockProvider } from "../../src/lib/images/factory";
import { createAsset } from "../../src/lib/services/media";
import { saveUploadedFile } from "../../src/lib/uploads";
import type {
  StockImage,
  StockProvider,
  StockSearchRequest,
} from "../../src/lib/images/stock";

/**
 * Provider stock finto per i test.
 *
 * `createContent` non genera immagini: cerca il visual nella libreria stock e,
 * senza un provider iniettato, la ricerca finirebbe su Magnific (chiave rete e
 * crediti). Qui la ricerca risponde con una foto decodificabile da `sharp`,
 * così il layout/template viene davvero applicato e l'asset finisce a terra
 * come in produzione. `returnImage = false` esercita invece il ramo di
 * "nessun risultato".
 */
export class FakeStockProvider implements StockProvider {
  readonly name = "fake-stock";
  readonly searches: StockSearchRequest[] = [];
  /** false = la libreria stock non ha nulla per quella query. */
  returnImage = true;
  private cached: Buffer | null = null;

  async searchImage(request: StockSearchRequest): Promise<StockImage | null> {
    this.searches.push(request);
    if (!this.returnImage) return null;

    if (!this.cached) {
      this.cached = await sharp({
        create: { width: 1080, height: 720, channels: 3, background: "#2b6a8f" },
      })
        .jpeg({ quality: 80 })
        .toBuffer();
    }

    const slug = request.query.toLowerCase().replace(/[^\w]+/g, "-").slice(0, 40);
    return {
      buffer: this.cached,
      mimeType: "image/jpeg",
      filename: `stock-${slug}.jpg`,
      sourceUrl: `https://images.example.test/stock/${slug}.jpg`,
      pageUrl: `https://example.test/photo/${slug}`,
      resourceId: 1,
      title: request.query,
      provider: this.name,
    };
  }
}

/** Monta il doppione stock e lo resetta a fine suite. */
export function installFakeStock(): FakeStockProvider {
  const provider = new FakeStockProvider();
  setStockProvider(provider);
  return provider;
}

/**
 * Un'immagine reale in Media Library, libera (nessun contenuto collegato) e
 * riconoscibile dalla query di ricerca: serve a esercitare il secondo gradino
 * della catena del visual (stock → Media Library) quando lo stock non risponde.
 */
export async function createLocalStockAsset(
  keyword: string,
  metadata: Prisma.InputJsonValue = { origin: "test-local", keyword }
) {
  const buffer = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#5b8c5a" },
  })
    .jpeg({ quality: 75 })
    .toBuffer();

  const saved = await saveUploadedFile({
    buffer,
    originalName: `${keyword}-locale.jpg`,
    mimeType: "image/jpeg",
  });

  const asset = await createAsset({
    url: saved.url,
    filename: `foto ${keyword}.jpg`,
    mimeType: saved.mimeType,
    size: saved.size,
    kind: "IMAGE",
    contentId: null,
    metadata,
  });

  return asset;
}

/**
 * Una locandina di fornitore in Media Library: libera, con il nome della
 * destinazione e dichiarata come provenienza del catalogo.
 *
 * Serve a provare che questo file non può diventare il visuale di un post
 * generico. È materiale promozionale di terzi, con il loro logo e la loro
 * grafica, e la catena del visual lo cerca per nome: senza il controllo,
 * "crea un post su Creta" avrebbe come sfondo la locandina Creta del fornitore.
 */
export async function createSupplierFlyerAsset(destination: string) {
  return createLocalStockAsset(`locandina-${destination}`, {
    origin: "catalog-flyer-source",
    role: "SOURCE_FLYER",
    destination,
    sourceUrl: `https://catalogo.example.test/${destination}/locandina.webp`,
  });
}
