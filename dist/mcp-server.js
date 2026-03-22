import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { getContextToken } from "./messaging/inbound.js";
import { markdownToPlainText, sendMessageWeixin } from "./messaging/send.js";
import { sendWeixinMediaFile } from "./messaging/send-media.js";
import { resolveWeixinAccount, listIndexedWeixinAccountIds, removeWeixinAccount } from "./auth/accounts.js";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import { saveWeixinAccount, registerWeixinAccountId, normalizeAccountId } from "./auth/accounts.js";
import { resetSession, isSessionPaused } from "./api/session-guard.js";
import { sendTyping } from "./api/api.js";
import { TypingStatus } from "./api/types.js";
import { logger } from "./util/logger.js";
const typingStates = new Map();
export function startTyping(chatId, baseUrl, token, typingTicket) {
    stopTyping(chatId);
    if (!typingTicket)
        return;
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
export function stopTyping(chatId) {
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
let lastInboundAt;
export function setLastInboundAt(ts) { lastInboundAt = ts; }
// 状态
let pollLoopRunning = false;
export function setPollLoopRunning(running) { pollLoopRunning = running; }
// 登录后的回调
let onLoginSuccess;
export function setOnLoginSuccess(cb) { onLoginSuccess = cb; }
// poll-loop abort 控制（供 logout 停止 poll-loop）
let pollAbortController;
export function setPollAbortController(ac) { pollAbortController = ac; }
// 模块级 server 引用，供 handleLogin 发 notification
let mcpServer;
export function createMcpServer() {
    const server = new Server({ name: "wechat", version: "0.1.0" }, {
        capabilities: {
            experimental: { "claude/channel": {} },
            tools: {},
        },
        instructions: '微信消息以 <channel source="wechat" chat_id="..." sender="..."> 格式到达。文本内容在标签体内，媒体附件通过 media_path 属性指向本地临时文件。用 reply 工具回复，传入 chat_id。如需发送文件，设置 media_path 为本地文件绝对路径。',
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "reply",
                description: "回复微信消息",
                inputSchema: {
                    type: "object",
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
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "status",
                description: "查询当前微信连接状态",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "logout",
                description: "登出微信，清除凭证并停止消息接收",
                inputSchema: { type: "object", properties: {} },
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name } = req.params;
        const args = req.params.arguments;
        if (name === "reply") {
            return handleReply(args ?? {});
        }
        if (name === "login") {
            return handleLogin();
        }
        if (name === "status") {
            return handleStatus();
        }
        if (name === "logout") {
            return handleLogout();
        }
        throw new Error(`unknown tool: ${name}`);
    });
    mcpServer = server;
    return server;
}
async function handleReply(args) {
    const chatId = args.chat_id;
    const text = args.text;
    const mediaPath = args.media_path;
    if (!chatId || !text) {
        return { content: [{ type: "text", text: "缺少 chat_id 或 text 参数" }] };
    }
    const contextToken = getContextToken(chatId);
    if (!contextToken) {
        return { content: [{ type: "text", text: "未收到过该用户的消息，无法回复（缺少 context_token）" }] };
    }
    // 取消 typing
    stopTyping(chatId);
    // 查找 account
    const accountIds = listIndexedWeixinAccountIds();
    if (accountIds.length === 0) {
        return { content: [{ type: "text", text: "未登录微信账号" }] };
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
        }
        else {
            await sendMessageWeixin({
                to: chatId,
                text: plainText,
                opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
            });
        }
        return { content: [{ type: "text", text: "已发送" }] };
    }
    catch (err) {
        logger.error(`reply failed: ${String(err)}`);
        return { content: [{ type: "text", text: `发送失败: ${String(err)}` }] };
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
        return { content: [{ type: "text", text: `登录失败: ${startResult.message}` }] };
    }
    // 通过 channel notification 发送 ASCII 二维码（避免工具响应被折叠）
    if (mcpServer) {
        try {
            const qrcodeterminal = await import("qrcode-terminal");
            const qrAscii = await new Promise((resolve) => {
                qrcodeterminal.default.generate(startResult.qrcodeUrl, { small: true }, (qr) => {
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
        }
        catch {
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
        }
        else {
            logger.warn(`login failed: ${waitResult.message}`);
        }
    })().catch((err) => logger.error(`background login poll failed: ${String(err)}`));
    return {
        content: [{
                type: "text",
                text: `${startResult.message}\n\n链接: ${startResult.qrcodeUrl}`,
            }],
    };
}
async function handleStatus() {
    const accountIds = listIndexedWeixinAccountIds();
    if (accountIds.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ connected: false }) }] };
    }
    const account = resolveWeixinAccount(accountIds[0]);
    const paused = isSessionPaused(account.accountId);
    return {
        content: [{
                type: "text",
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
async function handleLogout() {
    const accountIds = listIndexedWeixinAccountIds();
    if (accountIds.length === 0) {
        return { content: [{ type: "text", text: "当前没有已登录的微信账号" }] };
    }
    const accountId = accountIds[0];
    const account = resolveWeixinAccount(accountId);
    // 停止 poll-loop
    if (pollAbortController) {
        pollAbortController.abort();
        pollAbortController = undefined;
    }
    // 用 userId (chatId) 停止 typing，不是 accountId
    if (account.userId) {
        stopTyping(account.userId);
    }
    setPollLoopRunning(false);
    // 清除凭证和索引
    removeWeixinAccount(accountId);
    logger.info(`logout: account ${accountId} cleared`);
    return {
        content: [{
                type: "text",
                text: `已登出微信账号 ${accountId}，凭证已清除。如需重新连接请调用 login 工具。`,
            }],
    };
}
//# sourceMappingURL=mcp-server.js.map