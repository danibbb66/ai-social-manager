import { VideoProvider } from "@/lib/video/provider";
import { FfmpegVideoProvider } from "@/lib/video/ffmpeg";
import { config } from "@/lib/env";

let cached: VideoProvider | null = null;

/** Factory del provider video */
export function getVideoProvider(): VideoProvider {
  if (cached) return cached;
  switch (config.videoProvider) {
    case "ffmpeg":
      cached = new FfmpegVideoProvider();
      break;
    default:
      cached = new FfmpegVideoProvider();
  }
  return cached;
}