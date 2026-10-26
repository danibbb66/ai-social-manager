import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: [
    "@prisma/client",
    "ffmpeg-static",
    "ffprobe-static",
    // OCR (tesseract.js): lascia il pacchetto e il core fuori dal bundle, così
    // il worker thread e i file `.wasm` vengono risolti da node_modules a
    // runtime invece di essere processati da webpack/turbopack.
    "tesseract.js",
    "tesseract.js-core",
    "wasm-feature-detect",
    "node-fetch",
    "zlibjs",
    "bmp-js",
    "idb-keyval",
  ],
  // Include i binari ffmpeg/ffprobe (in `bin/`) e i modelli lingua OCR
  // (in `vendor/tessdata/`) nel bundle serverless di Vercel: senza questa voce
  // Next.js non li traccia (vengono referenziati solo a runtime da
  // `path.join(process.cwd(), …)`) e la generazione video/OCR fallirebbe.
  outputFileTracingIncludes: {
    "/**": [
      "./bin/ffmpeg",
      "./bin/ffprobe",
      "./vendor/tessdata/**/*.traineddata",
      "./node_modules/tesseract.js/src/worker-script/**",
      "./node_modules/tesseract.js/dist/worker.min.js",
      "./node_modules/tesseract.js-core/**/*.wasm",
    ],
  },
};

export default nextConfig;
