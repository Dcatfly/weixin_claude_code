import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, setOnLoginSuccess, setPollLoopRunning, setPollAbortController } from "./mcp-server.js";
import { startPollLoop } from "./poll-loop.js";
import { listIndexedWeixinAccountIds, resolveWeixinAccount } from "./auth/accounts.js";
import { logger } from "./util/logger.js";
import { cleanupTempMedia } from "./media/media-download.js";
async function main() {
    logger.info("weixin-claude-code channel starting...");
    // 清理过期临时文件
    await cleanupTempMedia().catch((err) => logger.warn(`temp cleanup failed: ${String(err)}`));
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP server connected via stdio");
    const abortController = new AbortController();
    // 启动 poll-loop 的函数，返回是否成功启动
    function launchPollLoop(accountId) {
        const account = resolveWeixinAccount(accountId);
        if (!account.configured) {
            logger.warn(`account ${accountId} not configured, skipping poll-loop`);
            return false;
        }
        if (!account.userId) {
            logger.warn(`account ${accountId} has no userId, skipping poll-loop`);
            return false;
        }
        // pollAbort: logout 时停止当前 poll-loop
        // AbortSignal.any: 全局退出 (SIGINT/SIGTERM) 或 logout 都能停止
        const pollAbort = new AbortController();
        setPollAbortController(pollAbort);
        const combinedSignal = AbortSignal.any([abortController.signal, pollAbort.signal]);
        startPollLoop({
            server,
            baseUrl: account.baseUrl,
            cdnBaseUrl: account.cdnBaseUrl,
            token: account.token,
            accountId: account.accountId,
            allowedUserId: account.userId,
            abortSignal: combinedSignal,
        }).catch((err) => {
            if (!combinedSignal.aborted) {
                logger.error(`poll-loop crashed: ${String(err)}`);
                setPollLoopRunning(false);
            }
        });
        return true;
    }
    // 登录成功后的回调
    setOnLoginSuccess((accountId) => {
        logger.info(`login success callback, launching poll-loop for ${accountId}`);
        launchPollLoop(accountId);
    });
    // 检查已有凭证
    const accountIds = listIndexedWeixinAccountIds();
    const launched = accountIds.length > 0 && launchPollLoop(accountIds[0]);
    if (!launched) {
        logger.info("no accounts found, sending login prompt notification");
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
            }
            catch (err) {
                logger.warn(`failed to send login prompt: ${String(err)}`);
            }
        }, 1000);
    }
    // 优雅退出
    process.on("SIGINT", () => {
        logger.info("received SIGINT, shutting down...");
        abortController.abort();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        logger.info("received SIGTERM, shutting down...");
        abortController.abort();
        process.exit(0);
    });
}
main().catch((err) => {
    logger.error(`fatal: ${String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map