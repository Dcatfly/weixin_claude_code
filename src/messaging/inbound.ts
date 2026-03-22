import { logger } from "../util/logger.js";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

// ---------------------------------------------------------------------------
// Context token store (in-process cache: chatId → contextToken)
// ---------------------------------------------------------------------------

/**
 * contextToken is issued per-message by the Weixin getupdates API and must
 * be echoed verbatim in every outbound send. It is not persisted: the monitor
 * loop populates this map on each inbound message, and the outbound adapter
 * reads it back when the agent sends a reply.
 */
const contextTokenStore = new Map<string, string>();

/** Store a context token for a given chat (user). */
export function setContextToken(chatId: string, token: string): void {
  logger.debug(`setContextToken: key=${chatId}`);
  contextTokenStore.set(chatId, token);
}

/** Retrieve the cached context token for a given chat (user). */
export function getContextToken(chatId: string): string | undefined {
  const val = contextTokenStore.get(chatId);
  logger.debug(
    `getContextToken: key=${chatId} found=${val !== undefined} storeSize=${contextTokenStore.size}`,
  );
  return val;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Returns true if the message item is a media type (image, video, file, or voice). */
export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

/**
 * Extract the text body from a message's item_list.
 * Handles text items, quoted references, and voice-to-text fallback.
 */
export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed as MediaPath; only include the current text as body.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      // Build quoted context from both title and message_item content.
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音转文字：如果语音消息有 text 字段，直接使用文字内容
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}
