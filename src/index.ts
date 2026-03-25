import os from "node:os";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WeixinBotClient } from "weixin-bot-plugin";
import type { InboundMessage } from "weixin-bot-plugin";

import { createMcpServer, PERMISSION_REPLY_RE, getPendingPermissionRequestId, clearPendingPermissionRequestId } from "./mcp-server.js";

function log(msg: string): void {
  process.stderr.write(`[weixin-claw] ${msg}\n`);
}

async function main() {
  log("weixin-claude-code channel starting...");

  const client = new WeixinBotClient({
    stateDir: path.join(os.homedir(), ".claude", "channels", "wechat"),
    tempDir: path.join(os.tmpdir(), "weixin-claude-code"),
    clientIdPrefix: "openclaw-weixin",
  });

  // 清理过期临时文件
  await client.cleanupTempMedia().catch((err: unknown) =>
    log(`temp cleanup failed: ${String(err)}`),
  );

  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server connected via stdio");

  // shutdown
  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down...");
    client.stop();
    process.exit(0);
  }
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ---------------------------------------------------------------------------
  // 已知局限：channel 模式检测
  //
  // 当前 MCP 协议不提供任何机制让 server 检测自身是否运行在 channel 模式
  // （即 Claude Code 是否以 --channels 启动）。非 channel 模式下：
  //   - poll-loop 仍会运行并消费 getUpdates 中的消息
  //   - notifications/claude/channel 会被 Claude Code 静默丢弃
  //   - 这会导致后续以 channel 模式启动的会话丢失已被消费的消息
  //
  // 此问题属于 Claude Code 核心架构缺陷，社区已有反馈：
  //   - https://github.com/anthropics/claude-code/issues/36964
  //
  // 在官方提供 channel 模式检测信号之前，此处暂无法区分两种模式，
  // 只能无条件启动 poll-loop，建议只在需要的会话中启动此 MCP Server。
  // ---------------------------------------------------------------------------

  // 绑定事件
  client.on("message", async (msg: InboundMessage) => {
    // 权限回复拦截
    const permMatch = PERMISSION_REPLY_RE.exec(msg.text);
    if (permMatch) {
      const requestId = permMatch[2]?.toLowerCase() ?? getPendingPermissionRequestId();
      if (requestId) {
        await server.notification({
          method: "notifications/claude/channel/permission" as any,
          params: {
            request_id: requestId,
            behavior: permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny",
          },
        });
        clearPendingPermissionRequestId();
        return;
      }
    }

    // 正常消息 → typing + MCP notification
    client.startTyping(msg.chatId);

    const meta: Record<string, string> = {
      chat_id: msg.chatId,
      sender: msg.chatId,
    };
    if (msg.mediaPath) meta.media_path = msg.mediaPath;
    if (msg.mediaType) meta.media_type = msg.mediaType;

    await server.notification({
      method: "notifications/claude/channel",
      params: { content: msg.text || "[媒体消息]", meta },
    });
  });

  client.on("sessionExpired", async (accountId: string) => {
    log(`session expired for ${accountId}`);
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: "微信连接已断开（session 过期），请调用 login 工具重新扫码连接。",
        meta: { type: "session_expired" },
      },
    });
  });

  client.on("qrRefresh", async ({ qrcodeUrl, qrAscii }) => {
    log(`QR code refreshed: ${qrcodeUrl}`);
    const text = qrAscii
      ? `二维码已过期，新二维码:\n\n${qrAscii}\n链接: ${qrcodeUrl}`
      : `二维码已过期，请使用新链接扫码: ${qrcodeUrl}`;
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: text, meta: { type: "qr_refresh" } },
      });
    } catch (err) {
      log(`failed to send qr refresh notification: ${String(err)}`);
    }
  });

  client.on("loginSuccess", (accountId) => {
    log(`login success: ${accountId}`);
  });

  client.on("error", (err: unknown) => {
    log(`client error: ${String(err)}`);
  });

  // 尝试启动
  const accounts = client.listAccounts();
  const launched = accounts.length > 0 && await client.start(accounts[0]);
  if (!launched) {
    log("no accounts found, sending login prompt notification");
    // 延迟发送，确保 MCP 连接就绪
    setTimeout(async () => {
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: "微信 Channel 已启动，但尚未登录。请调用 login 工具扫码连接微信。",
            meta: { type: "login_required" },
          },
        });
      } catch (err) {
        log(`failed to send login prompt: ${String(err)}`);
      }
    }, 1000);
  }
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  process.exit(1);
});
