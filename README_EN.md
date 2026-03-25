# weixin-claude-code

WeChat Channel plugin for Claude Code — bidirectional messaging between WeChat and Claude Code.

Built on [`weixin-bot-plugin`](https://github.com/Dcatfly/weixin_bot_plugin) WeChat SDK, adapted for Claude Code's [Channel](https://docs.anthropic.com/en/docs/claude-code/channels) feature.

[中文文档](./README.md)

## Features

- Send messages to Claude Code from WeChat, get replies back in WeChat
- Full media support: text, images, voice, video, files
- QR code login, zero configuration
- Replies automatically converted to plain text (WeChat doesn't render Markdown)
- [Permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts): tool-use approvals (e.g. Bash, Write, Edit) are forwarded to WeChat — reply yes/no to authorize remotely without being at the terminal

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- [Bun](https://bun.sh/) runtime
- claude.ai login (API Key authentication not supported)

## Installation

```bash
# 1. Add plugin marketplace
/plugin marketplace add Dcatfly/claude-plugins

# 2. Install plugin
/plugin install weixin-claude-code@dcatfly-plugins
```

## Usage

### Start

```bash
claude --dangerously-load-development-channels plugin:weixin-claude-code@dcatfly-plugins
```

> Custom Channels are in research preview and require the `--dangerously-load-development-channels` flag.

### First Login

After starting, Claude will prompt you to call the `login` tool:

1. Claude calls the login tool, displaying a QR code (press `ctrl+o` to expand if folded)
2. Scan the QR code with WeChat
3. Confirm login on WeChat
4. Connection established, ready to send and receive messages

### Messaging

Once connected, messages you send in WeChat are pushed to the Claude Code session in real time. Claude processes them and sends replies back via the `reply` tool.

**Send text**: Type directly in WeChat

**Send media**: Send images, voice messages, videos, or files — Claude will download and process them

**Receive replies**: Claude's responses are automatically converted to plain text and sent to WeChat

### Available Tools

| Tool | Description |
|------|-------------|
| `login` | Initiate WeChat QR code login |
| `reply` | Reply to WeChat messages (text and media) |
| `status` | Query current connection status |
| `logout` | Disconnect WeChat and clear credentials |

### Logout

Call the `logout` tool in Claude Code to disconnect and clear all local credentials.

## How It Works

```
WeChat User <-> WeChat Server <-> iLink Bot API <-> [Plugin MCP Server] <-> Claude Code
```

The plugin runs as an MCP Channel server. WeChat communication is handled by the [`weixin-bot-plugin`](https://github.com/Dcatfly/weixin_bot_plugin) library (iLink Bot API long-polling, CDN media encryption, SILK voice transcoding, etc.). The plugin pushes received messages to the Claude Code session as Channel notifications. Claude replies through the `reply` tool, which sends messages back to WeChat.

## Limitations

- **Only accepts messages from the logged-in user** — messages from others and group chats are filtered out (security by design)
- **No Claude Code native commands** — WeChat messages are treated as conversation content, they cannot trigger CLI commands like `/clear` or `/compact`
- **Manual re-login on session expiry** — when the WeChat session expires, you need to call `login` again
- **Channel feature is in research preview** — requires `--dangerously-load-development-channels` flag
- **Requires claude.ai login** — Console or API Key authentication not supported
- **Plugin still starts in non-channel mode** — the MCP protocol provides no way for plugins to detect whether they are running in channel mode ([claude-code#36964](https://github.com/anthropics/claude-code/issues/36964)). If loaded as a regular MCP server, the plugin will still consume WeChat messages but notifications are silently discarded, causing subsequent channel-mode sessions to miss those messages. Only enable the plugin when needed

## Data Storage

Credentials and sync data are stored in `~/.claude/channels/wechat/`:

```
~/.claude/channels/wechat/
├── accounts.json              # Account list
├── accounts/<id>.json         # Login credentials (owner-readable only)
└── sync/<id>.sync.json        # Message sync checkpoint
```

All data is automatically cleared on logout.

Media files (images, voice, video, documents) are cached in the system temp directory:

```
$TMPDIR/weixin-claude-code/media/
├── inbound/     # received media
└── outbound/    # sent media
```

## License

MIT
