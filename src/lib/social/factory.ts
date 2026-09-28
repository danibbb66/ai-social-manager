import { Platform } from "@prisma/client";
import { SocialProvider } from "@/lib/social/provider";
import { InstagramProvider } from "@/lib/social/instagram";
import { FacebookProvider } from "@/lib/social/facebook";
import { TiktokProvider } from "@/lib/social/tiktok";

const providers: SocialProvider[] = [
  new InstagramProvider(),
  new FacebookProvider(),
  new TiktokProvider(),
];

/** Factory dei provider social */
export function getSocialProvider(platform: Platform): SocialProvider {
  const found = providers.find((p) => p.platform === platform);
  if (!found) throw new Error(`Provider non supportato: ${platform}`);
  return found;
}

export function getAllSocialProviders(): SocialProvider[] {
  return providers;
}