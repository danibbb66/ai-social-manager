import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: ["@prisma/client", "ffmpeg-static", "ffprobe-static"],
  // Include i binari ffmpeg/ffprobe (in `bin/`) SOLO nella funzione della
  // pagina /generate (l'unica che monta video): senza questa voce Next.js non
  // li traccia (vengono referenziati a runtime da `path.join(process.cwd(),
  // "bin", ...)`) e la generazione fallirebbe con "ffmpeg non trovato".
  //
  // Il vecchio glob "/**" copiava ~139 MB di binari in TUTTE le ~17 rotte del
  // progetto: ~2,4 GB di "Function Storage" per ogni deploy, che su Vercel
  // Hobby (10 GB gratuiti) esplode dopo pochi deploy. Qui i binari stanno solo
  // in /generate (~139 MB in totale).
  outputFileTracingIncludes: {
    "/generate": ["./bin/ffmpeg", "./bin/ffprobe"],
    // La RIGENERAZIONE video parte anche dalla pagina di modifica contenuto
    // (/contents/[id], pulsante "Modifica media"): senza i binari in questa
    // route, l'edit falliva con "ffmpeg non trovato nel PATH" mentre la
    // creazione (da /generate) funzionava. Costo extra: ~139 MB su un'altra
    // funzione, ampiamente sotto il tetto Hobby.
    "/contents/[id]": ["./bin/ffmpeg", "./bin/ffprobe"],
  },
};

export default nextConfig;
