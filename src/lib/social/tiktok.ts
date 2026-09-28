import { Platform } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config, hasTiktok } from "@/lib/env";
import { PublishPayload, PublishResult, SocialProvider } from "@/lib/social/provider";

const TIKTOK_API = "https://open.tiktokapis.com/v2";
const CHUNK_SIZE = 1024 * 1024;
const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 3000;

async function downloadToTemp(videoUrl: string): Promise<{ file: string; size: number }> {
  const res = await fetch(videoUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Download video fallito (${res.status}). TikTok richiede un video pubblicamente scaricabile.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(os.tmpdir(), `tiktok-${Date.now()}.mp4`);
  await fs.writeFile(file, buf);
  return { file, size: buf.length };
}

/**
 * Provider TikTok basato sulla TikTok Content Posting API ufficiale.
 * Flow reale: init → upload del file (chunked PUT sull'URL firmato) → polling dello stato.
 * Solo VIDEO: TikTok non permette post di immagini via API.
 */
export class TiktokProvider implements SocialProvider {
  readonly platform: Platform = "TIKTOK";

  get isConfigured() {
    return hasTiktok();
  }

  missingConfig(): string[] {
    const missing: string[] = [];
    if (!config.tiktok.token) missing.push("TIKTOK_ACCESS_TOKEN");
    if (!config.tiktok.openId) missing.push("TIKTOK_OPEN_ID");
    return missing;
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    if (!this.isConfigured) {
      return {
        ok: false,
        message: `Account TikTok non configurato. Aggiungi al file .env: ${this.missingConfig().join(", ")}`,
      };
    }

    const videoUrl = payload.videoUrl ?? payload.mediaUrls[0];
    if (payload.contentType !== "VIDEO" && !videoUrl) {
      return {
        ok: false,
        message: "TikTok accetta solo video tramite API. Per le foto usa Instagram o Facebook.",
      };
    }
    if (!videoUrl) return { ok: false, message: "Nessun video da pubblicare." };

    const token = config.tiktok.token!;
    const openId = config.tiktok.openId!;
    const description = [payload.caption, payload.hashtags].filter(Boolean).join(" ");
    let tempFile: string | null = null;

    try {
      // 1) scarica il video per conoscere la dimensione reale
      const downloaded = await downloadToTemp(videoUrl);
      tempFile = downloaded.file;

      const initBody = {
        post_info: {
          title: description.slice(0, 2200),
          privacy_level: "SELF_ONLY",
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: { width: 1080, height: 1920 },
          chunk_size: CHUNK_SIZE,
          total_size: downloaded.size,
        },
      };

      const initRes = await fetch(`${TIKTOK_API}/post/publish/video/init/?open_id=${openId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(initBody),
      });
      const initJson = (await initRes.json()) as {
        data?: { publish_id?: string; upload_url?: string } | null;
        error?: { code?: string; message?: string };
      };
      if (!initRes.ok || !initJson.data?.upload_url || !initJson.data.publish_id) {
        throw new Error(
          `TikTok API ${initRes.status}: ${initJson.error?.message ?? "errore init"}`
        );
      }
      const publishId = initJson.data.publish_id;
      const uploadUrl = initJson.data.upload_url;

      // 2) upload chunked con ranges sull'URL firmato
      const fd = await fs.open(downloaded.file, "r");
      let offset = 0;
      let id = 0;
      const total = downloaded.size;
      while (offset < total) {
        const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, total - offset));
        const { bytesRead } = await fd.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) break;
        const start = offset;
        const end = offset + bytesRead - 1;
        const contentRange = `bytes ${start}-${end}/${total}`;
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Range": contentRange,
            "Content-Length": String(bytesRead),
          },
          body: chunk.subarray(0, bytesRead),
        });
        if (!putRes.ok) {
          await fd.close();
          throw new Error(`Upload chunk ${id} fallito: ${putRes.status}`);
        }
        const putText = await putRes.text();
        if (putText && putText !== "0" && !/^[0-9]+$/.test(putText)) {
          await fd.close();
          throw new Error(`Upload TikTok non concluso: ${putText}`);
        }
        offset += bytesRead;
        id += 1;
      }
      await fd.close();

      // 3) polling dello stato di pubblicazione
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const statusRes = await fetch(`${TIKTOK_API}/post/publish/status/fetch/?open_id=${openId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({ publish_id: publishId }),
        });
        const statusJson = (await statusRes.json()) as {
          data?: { status?: string; fail_reason?: string };
          error?: { code?: string; message?: string };
        };
        const status = statusJson.data?.status ?? "UNKNOWN";
        if (status === "PUBLISH_COMPLETE") {
          return { ok: true, message: "Video pubblicato su TikTok.", externalId: publishId };
        }
        if (status === "FAILED") {
          throw new Error(`Pubblicazione TikTok fallita: ${statusJson.data?.fail_reason ?? "errore sconosciuto"}`);
        }
      }
      return {
        ok: false,
        message: "Tempo scaduto in attesa dello stato TikTok. Verifica l'account (modalità self-only).",
        externalId: publishId,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (tempFile) await fs.unlink(tempFile).catch(() => {});
    }
  }
}