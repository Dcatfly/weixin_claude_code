import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { getUpdates } from "./api/api.js";
import { WeixinConfigManager } from "./api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, isSessionPaused } from "./api/session-guard.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "./storage/sync-buf.js";
import { bodyFromItemList, setContextToken, isMediaItem } from "./messaging/inbound.js";
import { downloadMediaFromItem } from "./media/media-download.js";
import type { InboundMediaResult } from "./media/media-download.js";
import type { WeixinMessage, MessageItem } from "./api/types.js";
import { MessageItemType } from "./api/types.js";
import { startTyping, stopTyping, setLastInboundAt, setPollLoopRunning } from "./mcp-server.js";
import { logger } from "./util/logger.js";
import { sendTyping } from "./api/api.js";
import { TypingStatus } from "./api/types.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type PollLoopOpts = {
  server: Server;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  /** 仅接受此 userId 的消息 */
  allowedUserId: string;
  abortSignal?: AbortSignal;
};

export async function startPollLoop(opts: PollLoopOpts): Promise<void> {
  const { server, baseUrl, cdnBaseUrl, token, accountId, allowedUserId, abortSignal } = opts;
  const aLog = logger.withAccount(accountId);

  aLog.info(`poll-loop started: baseUrl=${baseUrl}`);
  setPollLoopRunning(true);

  const syncFilePath = getSyncBufFilePath(accountId);
  let getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";
  if (getUpdatesBuf) {
    aLog.info(`resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, (msg) => aLog.info(msg));
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          setPollLoopRunning(false);
          aLog.error(`session expired, pausing poll-loop. Please re-login.`);

          // 通知 Claude
          await server.notification({
            method: "notifications/claude/channel",
            params: {
              content: "微信连接已断开（session 过期），请调用 login 工具重新扫码连接。",
              meta: { type: "session_expired" },
            },
          });
          return; // 退出 poll-loop，等待 login 后重新启动
        }

        consecutiveFailures += 1;
        aLog.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const msg of list) {
        await processMessage(msg, {
          server, baseUrl, cdnBaseUrl, token, accountId, allowedUserId, configManager,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) break;
      consecutiveFailures += 1;
      aLog.error(`getUpdates error: ${String(err)} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  setPollLoopRunning(false);
  aLog.info(`poll-loop ended`);
}

async function processMessage(
  msg: WeixinMessage,
  deps: {
    server: Server;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
    accountId: string;
    allowedUserId: string;
    configManager: WeixinConfigManager;
  },
): Promise<void> {
  const fromUserId = msg.from_user_id ?? "";

  // 安全过滤：仅接受登录者自己的消息
  if (fromUserId !== deps.allowedUserId) {
    logger.debug(`dropping message from ${fromUserId} (allowed: ${deps.allowedUserId})`);
    return;
  }

  setLastInboundAt(Date.now());

  // 缓存 context_token
  if (msg.context_token) {
    setContextToken(fromUserId, msg.context_token);
  }

  // 下载媒体
  const mainMediaItem = findMediaItem(msg.item_list);
  const refMediaItem = !mainMediaItem ? findRefMediaItem(msg.item_list) : undefined;
  const mediaItem = mainMediaItem ?? refMediaItem;

  let mediaResult: InboundMediaResult = {};
  if (mediaItem) {
    mediaResult = await downloadMediaFromItem(mediaItem, {
      cdnBaseUrl: deps.cdnBaseUrl,
      log: (m) => logger.info(m),
      errLog: (m) => logger.error(m),
      label: "inbound",
    });
  }

  // typing
  const cachedConfig = await deps.configManager.getForUser(fromUserId, msg.context_token);
  startTyping(fromUserId, deps.baseUrl, deps.token, cachedConfig.typingTicket);

  // 构建 notification
  const textBody = bodyFromItemList(msg.item_list);
  const meta: Record<string, string> = {
    chat_id: fromUserId,
    sender: fromUserId,
  };

  const mediaPath =
    mediaResult.decryptedPicPath ??
    mediaResult.decryptedVideoPath ??
    mediaResult.decryptedFilePath ??
    mediaResult.decryptedVoicePath;
  const mediaType =
    mediaResult.decryptedPicPath ? "image/*" :
    mediaResult.decryptedVideoPath ? "video/mp4" :
    mediaResult.fileMediaType ?? mediaResult.voiceMediaType;

  if (mediaPath) meta.media_path = mediaPath;
  if (mediaType) meta.media_type = mediaType;

  await deps.server.notification({
    method: "notifications/claude/channel",
    params: { content: textBody || "[媒体消息]", meta },
  });
}

function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  return (
    itemList?.find((i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param) ??
    itemList?.find((i) => i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param) ??
    itemList?.find((i) => i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param) ??
    itemList?.find((i) => i.type === MessageItemType.VOICE && i.voice_item?.media?.encrypt_query_param && !i.voice_item.text)
  );
}

function findRefMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  const ref = itemList?.find(
    (i) => i.type === MessageItemType.TEXT && i.ref_msg?.message_item && isMediaItem(i.ref_msg.message_item),
  )?.ref_msg?.message_item;
  return ref ?? undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}
