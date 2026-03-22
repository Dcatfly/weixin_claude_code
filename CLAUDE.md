# weixin-claude-code

微信 Channel for Claude Code — 通过 iLink Bot API 实现微信与 Claude Code 的双向通信。

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
├── index.ts          # 入口：MCP Server + poll-loop 启动
├── mcp-server.ts     # MCP Channel 服务器，注册 reply/login/logout/status 工具
├── poll-loop.ts      # 微信 getUpdates long-poll 循环
├── api/              # iLink Bot API 通信层（HTTP POST/GET）
├── auth/             # 账号存储（~/.claude/channels/wechat/）+ 扫码登录
├── cdn/              # 微信 CDN 加解密上传下载
├── media/            # 媒体下载解密、MIME 判断、SILK 语音转码
├── messaging/        # 消息解析（inbound）、发送（send/send-media）
├── storage/          # getUpdates 同步断点持久化
└── util/             # 日志（stderr）、ID 生成、脱敏
```

## 关键设计

- MCP stdio 服务器，声明 `claude/channel` capability，消息通过 notification 推送
- 所有日志输出到 stderr（stdout 是 MCP 协议通道）
- 凭证存储在 `~/.claude/channels/wechat/`，不在项目目录
- 安全过滤：仅接受 `from_user_id === savedUserId` 的消息
- `vendor/` 目录是原始 openclaw-weixin 源码，仅供参考不参与编译

## 插件发布

- `.claude-plugin/` 包含插件清单，`.mcp.json` 使用 `${CLAUDE_PLUGIN_ROOT}`
- `dist/` 预编译后提交到 git，用户安装插件后无需编译
- `start` 脚本中 `bun install` 确保运行时依赖就绪

## 注意事项

- `qrcode-terminal` 输出必须重定向到 stderr，不能用 stdout
- `contextToken` 是每条消息的会话令牌，回复时必须携带，缓存在内存 Map 中
- session 过期（errcode -14）后需要用户手动重新 login，不会自动恢复
- `stripMarkdown` 函数从 openclaw/src/line/markdown-to-line.ts 复制内联
