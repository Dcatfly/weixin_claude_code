# weixin-claude-code

微信 Channel for Claude Code — MCP 适配层，依赖 `weixin-bot-plugin` 库实现微信通信。

## 命令

```bash
bun run build      # 编译（bun build 打包为单文件 dist/index.js）
bun run start      # 启动 MCP 服务器（自动安装依赖）
bun run typecheck  # TypeScript 类型检查
bun run dev        # 开发模式（tsc --watch）
```

## 架构

```
src/
├── index.ts          # 入口：创建 WeixinBotClient + MCP Server，事件绑定 + 权限拦截
└── mcp-server.ts     # MCP Channel 服务器，注册 reply/login/logout/status 工具，权限转发

# weixin-bot-plugin    npm 包，独立微信通信库，源码在 ../weixin_bot_plugin/
```

本项目仅包含 Claude Code MCP 协议适配层。微信通信功能（API、认证、CDN、媒体、消息收发、poll-loop）
全部由 `weixin-bot-plugin` 库提供。

## 关键设计

- MCP stdio 服务器，声明 `claude/channel` capability，消息通过 notification 推送
- 通过 `WeixinBotClient` 的 EventEmitter 事件接收微信消息，转发为 MCP notification
- 权限转发：Claude Code 权限请求 → 微信文本 → 用户回复 yes/no → 权限审批 notification
- 权限回复拦截（`PERMISSION_REPLY_RE`）保留在此层，是 Claude Code 特有概念
- 凭证存储路径通过 `stateDir` 配置，向后兼容 `~/.claude/channels/wechat/`
- `vendor/` 目录已移至 `../weixin_bot_plugin/vendor/`，本项目不再包含

## 插件发布

- `.claude-plugin/` 包含插件清单，`.mcp.json` 使用 `${CLAUDE_PLUGIN_ROOT}`
- `dist/` 预编译后提交到 git，用户安装插件后无需编译
- `start` 脚本中 `bun install` 确保运行时依赖就绪
- `bun build` 会将 `weixin-bot-plugin` 打包进单文件，分发时不依赖外部路径

## 注意事项

- `contextToken` 是每条消息的会话令牌，由 `weixin-bot-plugin` 内部管理
- session 过期（errcode -14）后需要用户手动重新 login，不会自动恢复
- Typing 状态由本层在收到消息时手动 start，reply 时手动 stop
