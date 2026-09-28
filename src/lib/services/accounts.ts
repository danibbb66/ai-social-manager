import { Platform, SocialAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasFacebook, hasInstagram, hasTiktok, platformConfigured } from "@/lib/env";
import { logAudit } from "@/lib/audit";

export interface AccountInput {
  platform: Platform;
  name: string;
  handle?: string | null;
  active?: boolean;
}

export async function listAccounts(): Promise<SocialAccount[]> {
  const accounts = await prisma.socialAccount.findMany({
    orderBy: { platform: "asc" },
  });
  // Lo stato "configurato" deriva dalle credenziali in .env, non si può falsificare.
  return accounts.map((a) => ({
    ...a,
    configured: platformConfigured(a.platform),
    note:
      a.platform === "INSTAGRAM" && !hasInstagram()
        ? "Richiede INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ACCOUNT_ID nel file .env"
        : a.platform === "FACEBOOK" && !hasFacebook()
        ? "Richiede FACEBOOK_PAGE_ACCESS_TOKEN e FACEBOOK_PAGE_ID nel file .env"
        : a.platform === "TIKTOK" && !hasTiktok()
        ? "Richiede TIKTOK_ACCESS_TOKEN e TIKTOK_OPEN_ID nel file .env"
        : a.note ?? "",
  }));
}

export async function upsertAccount(
  input: AccountInput
): Promise<SocialAccount> {
  const account = await prisma.socialAccount.upsert({
    where: { platform_name: { platform: input.platform, name: input.name } },
    create: {
      platform: input.platform,
      name: input.name,
      handle: input.handle ?? null,
      configured: platformConfigured(input.platform),
    },
    update: {
      handle: input.handle !== undefined ? input.handle ?? null : undefined,
      active: input.active !== undefined ? input.active : undefined,
      configured: platformConfigured(input.platform),
    },
  });
  await logAudit("ACCOUNT_UPSERTED", "SocialAccount", account.id, {
    platform: account.platform,
    name: account.name,
  });
  return account;
}

export async function deleteAccount(id: string): Promise<void> {
  await prisma.socialAccount.delete({ where: { id } });
  await logAudit("ACCOUNT_DELETED", "SocialAccount", id, {});
}

export const platformRequires: Record<Platform, string> = {
  INSTAGRAM: "Instagram Graph API (Instagram Business/Creator Account)",
  FACEBOOK: "Meta Graph API (Pagina Facebook)",
  TIKTOK: "TikTok Content Posting API (Chat/Video API)",
};