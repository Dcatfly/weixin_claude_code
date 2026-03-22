import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "../cdn/pic-decrypt.js";
import { silkToWav } from "./silk-transcode.js";
import { getMimeFromFilename, getExtensionFromMime } from "./mime.js";
import { logger } from "../util/logger.js";
import { tempFileName } from "../util/random.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const INBOUND_MEDIA_DIR = path.join(os.tmpdir(), "weixin-claude-code", "media", "inbound");

export type InboundMediaResult = {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
};

async function saveTempMedia(buf: Buffer, contentType: string | undefined, originalFilename?: string): Promise<{ path: string }> {
  if (buf.length > WEIXIN_MEDIA_MAX_BYTES) throw new Error(`media too large: ${buf.length} bytes (max ${WEIXIN_MEDIA_MAX_BYTES})`);
  await fs.mkdir(INBOUND_MEDIA_DIR, { recursive: true });
  const ext = originalFilename ? path.extname(originalFilename) : contentType ? getExtensionFromMime(contentType) : ".bin";
  const name = tempFileName("wx-inbound", ext);
  const filePath = path.join(INBOUND_MEDIA_DIR, name);
  await fs.writeFile(filePath, buf);
  return { path: filePath };
}

/**
 * Download and decrypt media from a single MessageItem.
 * Returns the populated InboundMediaResult fields; empty object on unsupported type or failure.
 */
export async function downloadMediaFromItem(
  item: MessageItem,
  deps: {
    cdnBaseUrl: string;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
    label: string;
  },
): Promise<InboundMediaResult> {
  const { cdnBaseUrl, log, errLog, label } = deps;
  const result: InboundMediaResult = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param) return result;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    logger.debug(
      `${label} image: encrypt_query_param=${img.media.encrypt_query_param.slice(0, 40)}... hasAesKey=${Boolean(aesKeyBase64)} aeskeySource=${img.aeskey ? "image_item.aeskey" : "media.aes_key"}`,
    );
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param,
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param,
            cdnBaseUrl,
            `${label} image-plain`,
          );
      const saved = await saveTempMedia(buf, undefined);
      result.decryptedPicPath = saved.path;
      logger.debug(`${label} image saved: ${saved.path}`);
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
      errLog(`weixin ${label} image download/decrypt failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if (!voice?.media?.encrypt_query_param || !voice.media.aes_key) return result;
    try {
      const silkBuf = await downloadAndDecryptBuffer(
        voice.media.encrypt_query_param,
        voice.media.aes_key,
        cdnBaseUrl,
        `${label} voice`,
      );
      logger.debug(`${label} voice: decrypted ${silkBuf.length} bytes, attempting silk transcode`);
      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const saved = await saveTempMedia(wavBuf, "audio/wav");
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/wav";
        logger.debug(`${label} voice: saved WAV to ${saved.path}`);
      } else {
        const saved = await saveTempMedia(silkBuf, "audio/silk");
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/silk";
        logger.debug(`${label} voice: silk transcode unavailable, saved raw SILK to ${saved.path}`);
      }
    } catch (err) {
      logger.error(`${label} voice download/transcode failed: ${String(err)}`);
      errLog(`weixin ${label} voice download/transcode failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if (!fileItem?.media?.encrypt_query_param || !fileItem.media.aes_key) return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param,
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const saved = await saveTempMedia(buf, mime, fileItem.file_name ?? undefined);
      result.decryptedFilePath = saved.path;
      result.fileMediaType = mime;
      logger.debug(`${label} file: saved to ${saved.path} mime=${mime}`);
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
      errLog(`weixin ${label} file download failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if (!videoItem?.media?.encrypt_query_param || !videoItem.media.aes_key) return result;
    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param,
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
      );
      const saved = await saveTempMedia(buf, "video/mp4");
      result.decryptedVideoPath = saved.path;
      logger.debug(`${label} video: saved to ${saved.path}`);
    } catch (err) {
      logger.error(`${label} video download failed: ${String(err)}`);
      errLog(`weixin ${label} video download failed: ${String(err)}`);
    }
  }

  return result;
}
