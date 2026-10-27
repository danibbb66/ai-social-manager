import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: ["@prisma/client", "ffmpeg-static", "ffprobe-static"],
  // Include i binari ffmpeg/ffprobe (in `bin/`) nel bundle serverless di
  // Vercel: senza questa voce Next.js non li traccia (vengono referenziati
  // solo a runtime da `path.join(process.cwd(), "bin", ...)`) e la generazione
  // video fallirebbe con "ffmpeg non trovato nel PATH".
  outputFileTracingIncludes: {
    "/**": ["./bin/ffmpeg", "./bin/ffprobe"],
  },
};

export default nextConfig;
