import { ImageProvider } from "@/lib/images/provider";
import { ManualImageProvider } from "@/lib/images/manual";
import { MagnificImageProvider } from "@/lib/images/magnific";
import { config } from "@/lib/env";

let cached: ImageProvider | null = null;
let override: ImageProvider | null = null;

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