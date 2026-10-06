import { ImageProvider } from "@/lib/images/provider";
import { ManualImageProvider } from "@/lib/images/manual";
import { MagnificImageProvider } from "@/lib/images/magnific";
import { MagnificStockProvider, StockProvider } from "@/lib/images/stock";
import { config } from "@/lib/env";

let cached: ImageProvider | null = null;
let override: ImageProvider | null = null;
let stockCached: StockProvider | null = null;
let stockOverride: StockProvider | null = null;

/**
 * Iniezione di un provider immagini alternativo.
 *
 * Usata dai test per esercitare il percorso "genera → salva → collega"
 * senza chiamare Magnific. In produzione non va mai chiamata: con `null` il
 * comportamento è esattamente quello basato su IMAGE_PROVIDER.
 */
export function setImageProvider(provider: ImageProvider | null): void {
  override = provider;
  cached = null;
}

/**
 * Iniezione di un provider della libreria stock alternativo.
 *
 * Stessa logica di `setImageProvider`: i test la usano per esercitare la
 * ricerca del visual (destinazione → immagine stock → layout) senza rete né
 * consumo di crediti. Con `null` si torna al provider basato su MAGNIFIC_API_KEY.
 */
export function setStockProvider(provider: StockProvider | null): void {
  stockOverride = provider;
  stockCached = null;
}

/** Factory del provider immagini usato da tutta l'app */
export function getImageProvider(): ImageProvider {
  if (override) return override;
  if (cached) return cached;
  switch (config.imageProvider) {
    case "magnific":
      cached = new MagnificImageProvider();
      break;
    case "manual":
    default:
      cached = new ManualImageProvider();
  }
  return cached;
}

/**
 * Factory del provider della libreria stock.
 *
 * È la sola fonte dei visual recuperati per i post generici: cerca immagini
 * reali per destinazione, non ne genera mai. Senza MAGNIFIC_API_KEY il
 * provider risponde "nessun risultato" e il chiamante decide (ricerca nella
 * Media Library, poi nessun DRAFT).
 */
export function getStockProvider(): StockProvider {
  if (stockOverride) return stockOverride;
  if (stockCached) return stockCached;
  stockCached = new MagnificStockProvider();
  return stockCached;
}
