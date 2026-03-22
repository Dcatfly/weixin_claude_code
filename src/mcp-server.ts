import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getContextToken } from "./messaging/inbound.js";
import { markdownToPlainText, sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { resolveWeixinAccount, listIndexedWeixinAccountIds } from "./auth/accounts.js";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveWeixinAccount, registerWeixinAccountId, normalizeAccountId } from "./auth/accounts.js";
import { resetSession, isSessionPaused } from "./api/session-guard.js";
import { sendTyping } from "./api/api.js";
import { TypingStatus } from "./api/types.js";
import { logger } from "./util/logger.js";

// typing 状态管理
type TypingState = {
  timer: NodeJS.Timeout;
  baseUrl: string;
  token?: string;
  typingTicket: string;
};
const typingStates = new Map<string, TypingState>();

export function startTyping(chatId: string, baseUrl: string, token?: string, typingTicket?: string): void {
  stopTyping(chatId);
  if (!typingTicket) return;

  const doTyping = () => {
    sendTyping({
      baseUrl, token,
      body: { ilink_user_id: chatId, typing_ticket: typingTicket, status: TypingStatus.TYPING },
    }).catch((err) => logger.warn(`typing send error: ${String(err)}`));
  };

  doTyping();
  const timer = setInterval(doTyping, 5000);
  typingStates.set(chatId, { timer, baseUrl, token, typingTicket });
}

export function stopTyping(chatId: string): void {
  const state = typingStates.get(chatId);
  if (state) {
    clearInterval(state.timer);
    typingStates.delete(chatId);
    // 向微信发送取消 typing 状态
    sendTyping({
      baseUrl: state.baseUrl, token: state.token,
      body: { ilink_user_id: chatId, typing_ticket: state.typingTicket, status: TypingStatus.CANCEL },
    }).catch((err) => logger.warn(`typing cancel error: ${String(err)}`));
  }
}

// 上次入站消息时间
let lastInboundAt: number | undefined;
export function setLastInboundAt(ts: number): void { lastInboundAt = ts; }

// 状态
let pollLoopRunning = false;
export function setPollLoopRunning(running: boolean): void { pollLoopRunning = running; }

// 登录后的回调
let onLoginSuccess: ((accountId: string) => void) | undefined;
export function setOnLoginSuccess(cb: (accountId: string) => void): void { onLoginSuccess = cb; }

// 模块级 server 引用，供 handleLogin 发 notification
let mcpServer: Server | undefined;

export function createMcpServer(): Server {
  const server = new Server(
    { name: "wechat", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions:
        '微信消息以 <channel source="wechat" chat_id="..." sender="..."> 格式到达。文本内容在标签体内，媒体附件通过 media_path 属性指向本地临时文件。用 reply 工具回复，传入 chat_id。如需发送文件，设置 media_path 为本地文件绝对路径。',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "reply",
        description: "回复微信消息",
        inputSchema: {
          type: "object" as const,
          properties: {
            chat_id: { type: "string", description: "目标用户 ID（从 <channel> 标签的 chat_id 属性获取）" },
            text: { type: "string", description: "回复文本内容" },
            media_path: { type: "string", description: "可选，本地文件绝对路径（图片/视频/文件）" },
          },
          required: ["chat_id", "text"],
        },
      },
      {
        name: "login",
        description: "发起微信扫码登录，返回二维码 URL",
        inputSchema: { type: "object" as const, properties: {} },
      },
      {
        name: "status",
        description: "查询当前微信连接状态",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = req.params.arguments as Record<string, string> | undefined;

    if (name === "reply") {
      return handleReply(args ?? {});
    }
    if (name === "login") {
      return handleLogin();
    }
    if (name === "status") {
      return handleStatus();
    }
    throw new Error(`unknown tool: ${name}`);
  });

  mcpServer = server;
  return server;
}

async function handleReply(args: Record<string, string>) {
  const chatId = args.chat_id;
  const text = args.text;
  const mediaPath = args.media_path;

  if (!chatId || !text) {
    return { content: [{ type: "text" as const, text: "缺少 chat_id 或 text 参数" }] };
  }

  const contextToken = getContextToken(chatId);
  if (!contextToken) {
    return { content: [{ type: "text" as const, text: "未收到过该用户的消息，无法回复（缺少 context_token）" }] };
  }

  // 取消 typing
  stopTyping(chatId);

  // 查找 account
  const accountIds = listIndexedWeixinAccountIds();
  if (accountIds.length === 0) {
    return { content: [{ type: "text" as const, text: "未登录微信账号" }] };
  }
  const account = resolveWeixinAccount(accountIds[0]);

  const plainText = markdownToPlainText(text);

  try {
    if (mediaPath) {
      await sendWeixinMediaFile({
        filePath: mediaPath,
        to: chatId,
        text: plainText,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
        cdnBaseUrl: account.cdnBaseUrl,
      });
    } else {
      await sendMessageWeixin({
        to: chatId,
        text: plainText,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      });
    }
    return { content: [{ type: "text" as const, text: "已发送" }] };
  } catch (err) {
    logger.error(`reply failed: ${String(err)}`);
    return { content: [{ type: "text" as const, text: `发送失败: ${String(err)}` }] };
  }
}

async function handleLogin() {
  const accountIds = listIndexedWeixinAccountIds();
  const existingId = accountIds[0];
  const account = existingId ? resolveWeixinAccount(existingId) : null;
  const apiBaseUrl = account?.baseUrl || "https://ilinkai.weixin.qq.com";

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    return { content: [{ type: "text" as const, text: `登录失败: ${startResult.message}` }] };
  }

  // 通过 channel notification 发送 ASCII 二维码（避免工具响应被折叠）
  if (mcpServer) {
    try {
      const qrcodeterminal = await import("qrcode-terminal");
      const qrAscii = await new Promise<string>((resolve) => {
        qrcodeterminal.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
          resolve(qr);
        });
      });
      if (qrAscii) {
        await mcpServer.notification({
          method: "notifications/claude/channel",
          params: {
            content: `请用微信扫描以下二维码登录:\n\n${qrAscii}\n链接: ${startResult.qrcodeUrl}`,
            meta: { type: "qrcode" },
          },
        });
      }
    } catch {
      // qrcode-terminal 不可用，回退到仅在工具响应中显示 URL
    }
  }

  // 后台轮询扫码状态
  (async () => {
    const waitResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl,
      timeoutMs: 480_000,
    });

    if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
      const normalizedId = normalizeAccountId(waitResult.accountId);
      saveWeixinAccount(normalizedId, {
        token: waitResult.botToken,
        baseUrl: waitResult.baseUrl,
        userId: waitResult.userId,
      });
      registerWeixinAccountId(normalizedId);
      resetSession(normalizedId);
      logger.info(`login success: accountId=${normalizedId}`);
      onLoginSuccess?.(normalizedId);
    } else {
      logger.warn(`login failed: ${waitResult.message}`);
    }
  })().catch((err) => logger.error(`background login poll failed: ${String(err)}`));

  return {
    content: [{
      type: "text" as const,
      text: `${startResult.message}\n\n链接: ${startResult.qrcodeUrl}`,
    }],
  };
}

async function handleStatus() {
  const accountIds = listIndexedWeixinAccountIds();
  if (accountIds.length === 0) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ connected: false }) }] };
  }
  const account = resolveWeixinAccount(accountIds[0]);
  const paused = isSessionPaused(account.accountId);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        connected: account.configured && !paused && pollLoopRunning,
        accountId: account.accountId,
        userId: account.userId,
        lastInboundAt,
        sessionPaused: paused,
      }),
    }],
  };
}
