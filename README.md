# Discord + Telegram Relay

A personal AI assistant on Discord and Telegram powered by Claude Code.

You message it on Discord or Telegram. Claude responds. Text, photos, documents, voice. It remembers across sessions using MCP for memory.

## What You Get

- **Dual Platform**: Works on both Discord and Telegram simultaneously
- **Memory via MCP**: Uses Diego's MCP server for persistent memory
- **Voice**: Transcribe voice messages (Groq or local Whisper)
- **Always On**: Runs in the background, starts on boot, restarts on crash

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- **Discord** and/or **Telegram** account

### Setup

```bash
# Clone and install
git clone https://github.com/diegovelezg/discord-telegram-relay.git
cd discord-telegram-relay
bun install

# Create .env file
cp .env.example .env
# Edit .env with your tokens

# Test connections
bun run setup/test-all.ts

# Run
bun run start
```

### Telegram Setup

1. Message @BotFather on Telegram
2. Create a new bot with /newbot
3. Copy the token to TELEGRAM_BOT_TOKEN
4. Get your user ID from @userinfobot
5. Set TELEGRAM_USER_ID

### Discord Setup

1. Go to Discord Developer Portal
2. Create a new application
3. Add a bot to the application
4. Copy the bot token to DISCORD_BOT_TOKEN
5. Enable Message Content Intent
6. Invite bot to your server
7. Set DISCORD_CHANNEL_IDS (comma-separated channel IDs)

### MCP Setup

Configure your MCP server:
- MCP_URL: Your MCP server URL
- MCP_API_KEY: Your MCP API key

## Commands

```bash
bun run start           # Start the relay
bun run dev             # Start with auto-reload
bun run setup:test-all  # Test all connections
```

## VPS Deployment

### 1. Install Dependencies

```bash
ssh your-vps
curl -fsSL https://bun.sh/install | bash
git clone <this-repo>
cd discord-telegram-relay
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Set your tokens (or use systemd environment variables).

### 3. Install Systemd Service

```bash
sudo cp daemon/claude-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable claude-relay
sudo systemctl start claude-relay
```

### 4. Security (Recommended)

- Use SSL/TLS via nginx reverse proxy
- Set up fail2ban for brute-force protection
- Keep tokens in systemd environment, not .env
- Use firewall to limit access

## Project Structure

```
src/
  relay.ts         # Main relay (Discord + Telegram)
  memory.ts        # MCP integration for memory
  transcribe.ts    # Voice transcription
config/
  profile.md      # User profile template
daemon/
  claude-relay.service  # Systemd service
```

## License

MIT
