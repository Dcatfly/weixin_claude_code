# 微信 Claude Code Channel 设计文档

## 概述

将 `@tencent-weixin/openclaw-weixin` 的微信通信层移植为 Claude Code Channel MCP 服务器，实现微信与 Claude Code 的双向消息通信。

## 目标

- 微信消息（文本、图片、语音、视频、文件）以 `<channel>` 通知的形式到达 Claude Code 会话
- Claude 通过 `reply` MCP 工具回复，支持文本和媒体
- 扫码登录、零配置安全（仅接受登录者消息）、凭证存储在 `~/.claude/channels/wechat/`

## 架构

```
微信用户 <-> iLink Bot API (HTTP) <-> [MCP Channel 服务器 (stdio)] <-> Claude Code
```

MCP 服务器作为 Claude Code 的 stdio 子进程运行。通过对 iLink Bot API（`https://ilinkai.weixin.qq.com`）的 long-poll 循环接收入站消息，通过 MCP 工具处理出站回复。

## 项目结构

```
weixin_claw/
├── src/
│   ├── index.ts              # 入口：MCP Server + long-poll 启动
│   ├── mcp-server.ts         # MCP Channel 服务器定义 + 工具注册
│   ├── poll-loop.ts          # 微信 getUpdates long-poll 循环
│   ├── auth/
│   │   ├── accounts.ts       # 账号存储 (~/.claude/channels/wechat/)
│   │   └── login-qr.ts       # 扫码登录流程
│   ├── api/
│   │   ├── api.ts            # HTTP 通信层 (iLink Bot API)
│   │   ├── types.ts          # 协议类型定义
│   │   ├── config-cache.ts   # typing_ticket 缓存管理
│   │   └── session-guard.ts  # 会话过期检测与暂停
│   ├── cdn/
│   │   ├── aes-ecb.ts        # AES-128-ECB 加解密
│   │   ├── cdn-upload.ts     # CDN 上传逻辑
│   │   ├── cdn-url.ts        # CDN URL 构建
│   │   ├── pic-decrypt.ts    # 图片解密
│   │   └── upload.ts         # 上传编排
│   ├── media/
│   │   ├── media-download.ts # 从微信 CDN 下载媒体
│   │   ├── mime.ts           # MIME 类型判断
│   │   └── silk-transcode.ts # 语音转码 (silk -> wav)
│   ├── messaging/
│   │   ├── inbound.ts        # 入站消息标准化
│   │   ├── send.ts           # 消息构建与发送（文本+媒体）
│   │   └── send-media.ts     # 媒体上传+发送编排
│   ├── storage/
│   │   └── sync-buf.ts       # getUpdates 断点持久化
│   └── util/
│       ├── logger.ts         # 日志
│       ├── random.ts         # ID 生成
│       └── redact.ts         # Token/消息体脱敏
├── vendor/                   # 原始 openclaw-weixin 源码（仅供参考）
├── package.json
└── tsconfig.json
```

### 代码复用策略

从 `vendor/package/src/` 复制源文件到 `src/`，然后做适配修改：

- **直接复用**（改动极小）：`api/types.ts`、`cdn/*`、`messaging/send-media.ts`、`media/mime.ts`、`media/silk-transcode.ts`、`util/random.ts`、`util/redact.ts`
- **适配修改**（去除 `openclaw/plugin-sdk` 依赖，更改存储路径等）：
  - `api/api.ts` — 移除 `loadConfigRouteTag` 调用，SKRouteTag header 改为可选参数传入
  - `api/config-cache.ts` — 移除 SDK 类型依赖，typing_ticket 缓存 TTL 改为随机刷新（最长 24 小时内刷新），失败时指数退避（初始 2 秒，最大 1 小时），与 vendor 行为一致
  - `api/session-guard.ts` — 保留 errcode -14 检测逻辑；设计变更：vendor 原实现为暂停 1 小时后自动重试，此处改为暂停 poll 并通知用户手动 `login` 重新扫码，因为 MCP Channel 场景下 token 过期通常需要重新认证
  - `auth/accounts.ts` — 自行实现 `normalizeAccountId`（将 `@` 和 `.` 替换为 `-`，已通过 vendor 代码 `deriveRawAccountId` 反向确认），存储路径改为 `~/.claude/channels/wechat/`，去除 `deriveRawAccountId` 和 `loadLegacyToken` 等向后兼容逻辑
  - `auth/login-qr.ts` — 移除 `loadConfigRouteTag` 依赖；`qrcode-terminal` 输出重定向到 stderr（stdout 是 MCP 协议通道），或作为备用方案仅依赖 `qrcodeUrl` 返回值让 Claude 展示
  - `media/media-download.ts` — 将 `saveMediaBuffer` 回调替换为本地文件写入（`os.tmpdir()/weixin-claw/media/inbound/`）
  - `messaging/inbound.ts` — 简化，去掉 `MsgContext` 类型，保留消息解析和 `context_token` 缓存
  - `messaging/send.ts` — 自行实现完整的 `markdownToPlainText`：vendor 版本先处理代码围栏/图片/链接/表格，最后调用 SDK 的 `stripMarkdown(result)` 做最终清理（去除 `**`、`*`、`~~`、`#` 等 Markdown 格式标记），新实现需将此逻辑内联，不依赖 SDK；移除 `ReplyPayload` 类型依赖
  - `storage/sync-buf.ts` — 从 vendor 的 `storage/sync-buf.ts` 适配，去除 legacy 兼容路径回退，存储路径改为 `~/.claude/channels/wechat/sync/`
  - `util/logger.ts` — 重写为 stderr 输出（stdout 是 MCP 协议通道）
- **全新编写**：`index.ts`、`mcp-server.ts`、`poll-loop.ts`

## 数据流

### 入站（微信 → Claude）

1. `poll-loop` 调用 `ilink/bot/getupdates`（HTTP long-poll，35 秒超时）
2. 过滤消息：仅接受 `msg.from_user_id === savedUserId`（登录用户自己的微信 ID，扫码时由 iLink API 返回的 `ilink_user_id`）
3. 如果消息包含媒体（图片/语音/视频/文件），从微信 CDN 下载到本地临时目录（`os.tmpdir()/weixin-claw/media/inbound/`）并解密
4. 自动发送 typing 状态（通过 `ilink/bot/sendtyping`，需要 `typing_ticket`）
5. 发送 MCP notification：
   ```
   method: 'notifications/claude/channel'
   params:
     content: <文本内容>（引用消息格式化为 "[引用: ...]\n{text}"）
     meta:
       chat_id: <from_user_id>
       sender: <from_user_id>
       media_path: <本地文件路径，如有媒体>
       media_type: <MIME 类型，如有媒体>
   ```
6. 缓存消息中的 `context_token`（内存 Map，以 chat_id 为键，后到的覆盖先到的，不持久化）

### 出站（Claude → 微信）

1. Claude 调用 `reply` 工具，传入 `chat_id`、`text`，可选 `media_path`
2. 查找缓存的 `context_token`（如未找到则报错 "未收到过该用户的消息，无法回复"）
3. 对 `text` 执行 Markdown → 纯文本转换（剥离代码围栏、图片语法、链接语法、表格分隔行等，微信不支持 Markdown 渲染）
4. 取消 typing 状态
5. 纯文本：直接调用 `ilink/bot/sendmessage`
6. 带媒体：AES-128-ECB 加密文件 → 从 `ilink/bot/getuploadurl` 获取预签名上传地址 → 上传到微信 CDN → 发送引用 CDN 资源的消息

## MCP 工具

### `reply` — 回复微信消息

```typescript
{
  name: 'reply',
  inputSchema: {
    properties: {
      chat_id: { type: 'string', description: '目标用户 ID（从 <channel> 标签的 chat_id 属性获取）' },
      text: { type: 'string', description: '回复文本内容' },
      media_path: { type: 'string', description: '可选，本地文件绝对路径（图片/视频/文件）' },
    },
    required: ['chat_id', 'text'],
  },
}
```

### `login` — 发起微信扫码登录

```typescript
{
  name: 'login',
  inputSchema: { properties: {} },
}
// 返回值：{ qrcodeUrl: string, message: string }
// qrcodeUrl 为二维码图片链接，Claude 可展示给用户
// 工具内部同时启动后台轮询扫码状态，确认后自动保存凭证并启动 long-poll
```

### `status` — 查询连接状态

```typescript
{
  name: 'status',
  inputSchema: { properties: {} },
}
// 返回值：{ connected: boolean, accountId?: string, userId?: string, lastInboundAt?: number }
```

### Instructions（系统指令）

> 微信消息以 `<channel source="wechat" chat_id="..." sender="...">` 格式到达。文本内容在标签体内，媒体附件通过 media_path 属性指向本地临时文件。用 reply 工具回复，传入 chat_id。如需发送文件，设置 media_path 为本地文件绝对路径。

## 认证与登录

### 首次登录

1. Claude Code 启动 Channel → MCP 服务器启动
2. 检查 `~/.claude/channels/wechat/accounts/` 下是否有已保存的凭证
3. **有凭证** → 直接启动 long-poll 循环
4. **无凭证** → 发送 notification 提醒用户调用 `login` 工具
5. `login` 工具 → 请求 iLink API 获取二维码 → 返回二维码 URL 给 Claude → Claude 展示给用户
6. 后台轮询扫码状态 → 确认后保存 `bot_token` + `userId` 到 `~/.claude/channels/wechat/accounts/<accountId>.json`
7. 自动启动 long-poll

### 会话过期

- iLink API 返回 errcode `-14` → session 过期
- 暂停 long-poll，发 notification 通知用户连接已断开
- 用户调用 `login` 工具重新认证

## Typing 状态指示

收到微信消息后，自动发送 typing 状态让微信端显示"对方正在输入..."：

1. 收到消息时，通过 `ilink/bot/getconfig` 获取该用户的 `typing_ticket`（带内存缓存，随机 TTL 最长 24 小时内刷新，失败时指数退避：初始 2 秒，最大 1 小时）
2. 发送 notification 给 Claude 前，调用 `ilink/bot/sendtyping`（status=1 表示开始输入）
3. 每 5 秒发送一次 keepalive（微信端的 typing 状态约 8 秒后自动消失）
4. Claude 调用 `reply` 工具时，自动取消 typing（status=2）
5. 如果获取 `typing_ticket` 失败，静默跳过 typing（不影响消息收发）

## 存储结构

```
~/.claude/channels/wechat/
├── accounts.json                # 账号 ID 列表
├── accounts/
│   └── <accountId>.json         # { token, baseUrl, userId, savedAt }
└── sync/
    └── <accountId>.sync.json    # { get_updates_buf: "<base64 string>" }
```

说明：`cdnBaseUrl` 使用硬编码常量 `https://novac2c.cdn.weixin.qq.com/c2c`（与原插件一致），不存储在账号文件中。

## 安全门控

- 扫码登录时，iLink API 返回 `ilink_user_id`（扫码人的微信 ID）
- 保存到 `accounts/<accountId>.json` 的 `userId` 字段
- 每条入站消息检查 `msg.from_user_id === savedUserId`
- 不匹配则静默丢弃，不发送 notification 给 Claude
- 零配置，扫码即生效

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| long-poll 超时 | 正常行为，立即重试 |
| 连续 3 次 API 失败 | 退避 30 秒后重试 |
| session 过期 (errcode -14) | 暂停 poll，通知用户调用 `login` 重新扫码（设计变更：vendor 原为暂停 1 小时后自动重试） |
| 媒体下载/上传失败 | 通知 Claude 失败原因，文本消息正常送达 |
| MCP 连接断开 | 进程退出，由 Claude Code 重新拉起 |

## 临时文件管理

入站媒体下载到 `os.tmpdir()/weixin-claw/media/inbound/`，出站媒体临时文件存放在 `os.tmpdir()/weixin-claw/media/outbound/`。进程启动时清理超过 24 小时的临时文件。

## 依赖

- `@modelcontextprotocol/sdk` — MCP 服务器实现
- `qrcode-terminal` — 终端二维码显示
- `zod` — Schema 校验
- `silk-wasm` — SILK 语音格式转码为 WAV
- `typescript`（dev）— 类型检查与编译

运行时要求：Node.js >= 22（原生 fetch）。

## iLink Bot API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `ilink/bot/get_bot_qrcode` | GET | 获取登录二维码 |
| `ilink/bot/get_qrcode_status` | GET | 轮询扫码状态 |
| `ilink/bot/getupdates` | POST | Long-poll 接收入站消息 |
| `ilink/bot/sendmessage` | POST | 发送消息 |
| `ilink/bot/sendtyping` | POST | 发送输入状态指示 |
| `ilink/bot/getconfig` | POST | 获取 bot 配置（含 typing_ticket） |
| `ilink/bot/getuploadurl` | POST | 获取 CDN 预签名上传地址 |

## 全新编写模块说明

### `index.ts`

启动顺序：
1. 创建 MCP Server 实例（声明 `claude/channel` + `tools` capabilities）
2. 通过 stdio 连接 Claude Code
3. 检查已保存凭证 → 有则启动 `poll-loop`，无则发 notification 提示登录
4. MCP Server 和 poll-loop 并行运行

### `mcp-server.ts`

- 创建 MCP Server，capabilities 声明 `{ experimental: { 'claude/channel': {} }, tools: {} }`
- 注册 `reply`、`login`、`status` 三个工具的 handler
- 提供 `sendNotification` 方法供 `poll-loop` 调用
- 管理 typing 状态的启停

### `poll-loop.ts`

基于原始 `monitor.ts` 简化：
- 保留 long-poll 循环、错误退避、session 过期检测
- 去掉 OpenClaw 的 `processOneMessage`、agent 路由、回复调度、斜杠命令
- 替换为：过滤 → 下载媒体 → 启动 typing → 发送 MCP notification
