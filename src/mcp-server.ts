import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { WeixinBotClient } from "weixin-bot-plugin";

function log(msg: string): void {
  process.stderr.write(`[weixin-claw] ${msg}\n`);
}

// 权限回复正则（Claude Code 特有）
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)(?:\s+([a-km-z]{5}))?\s*$/i;

// 权限请求 ID 缓存
let pendingPermissionRequestId: string | undefined;

export function createMcpServer(client: WeixinBotClient): Server {
  const server = new Server(
    { name: "wechat", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
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
      {
        name: "logout",
        description: "登出微信，清除凭证并停止消息接收",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = req.params.arguments as Record<string, string> | undefined;

    if (name === "reply") {
      return handleReply(client, args ?? {});
    }
    if (name === "login") {
      return handleLogin(client);
    }
    if (name === "status") {
      return handleStatus(client);
    }
    if (name === "logout") {
      return handleLogout(client);
    }
    throw new Error(`unknown tool: ${name}`);
  });

  // 权限转发：Claude Code 在权限弹窗时发送 permission_request，channel 转发到微信
  const PermissionRequestSchema = z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  });

  server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    const status = client.getStatus();
    if (!status.userId) return;

    const text =
      `Claude 请求执行 ${params.tool_name}:\n${params.description}\n` +
      (params.input_preview ? `输入: ${params.input_preview}\n` : "") +
      `\n回复 yes / no `;

    try {
      await client.sendText(status.userId, text, { raw: true });
      // 仅在转发成功后缓存 request_id，避免用户未收到提示时 yes/no 被误拦截
      pendingPermissionRequestId = params.request_id;
    } catch (err) {
      log(`permission_request forward failed: ${String(err)}`);
    }
  });

  return server;
}

async function handleReply(client: WeixinBotClient, args: Record<string, string>) {
  const chatId = args.chat_id;
  const text = args.text;
  const mediaPath = args.media_path;

  if (!chatId || !text) {
    return { content: [{ type: "text" as const, text: "缺少 chat_id 或 text 参数" }] };
  }

  // 取消 typing + 清理 pending 权限请求（Agent 已继续工作）
  client.stopTyping(chatId);
  clearPendingPermissionRequestId();

  try {
    if (mediaPath) {
      await client.sendMedia(chatId, mediaPath, text);
    } else {
      await client.sendText(chatId, text);
    }
    return { content: [{ type: "text" as const, text: "已发送" }] };
  } catch (err) {
    log(`reply failed: ${String(err)}`);
    return { content: [{ type: "text" as const, text: `发送失败: ${String(err)}` }] };
  }
}

async function handleLogin(client: WeixinBotClient) {
  const result = await client.login();

  if (!result.qrcodeUrl) {
    return { content: [{ type: "text" as const, text: `登录失败: ${result.message}` }] };
  }

  const responseText = result.qrAscii
    ? `请用微信扫描以下二维码登录（如被折叠请按 ctrl+o 展开）:\n\n${result.qrAscii}\n链接: ${result.qrcodeUrl}\n\n${result.message}`
    : `${result.message}\n\n链接: ${result.qrcodeUrl}`;

  return {
    content: [{
      type: "text" as const,
      text: responseText,
    }],
  };
}

async function handleStatus(client: WeixinBotClient) {
  const status = client.getStatus();
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        connected: status.connected,
        accountId: status.accountId,
        userId: status.userId,
        lastInboundAt: status.lastInboundAt,
        sessionPaused: status.sessionPaused,
      }),
    }],
  };
}

async function handleLogout(client: WeixinBotClient) {
  const status = client.getStatus();
  const accountId = status.accountId;

  if (!accountId) {
    return { content: [{ type: "text" as const, text: "当前没有已登录的微信账号" }] };
  }

  await client.logout();

  log(`logout: account ${accountId} cleared`);

  return {
    content: [{
      type: "text" as const,
      text: `已登出微信账号 ${accountId}，凭证已清除。如需重新连接请调用 login 工具。`,
    }],
  };
}

export function getPendingPermissionRequestId(): string | undefined { return pendingPermissionRequestId; }
export function clearPendingPermissionRequestId(): void { pendingPermissionRequestId = undefined; }
export { PERMISSION_REPLY_RE };
