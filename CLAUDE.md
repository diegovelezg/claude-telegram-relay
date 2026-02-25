# Claude Setup Guide

This file provides guided setup instructions for Claude Code.

## Overview

You're helping set up a Discord + Telegram relay that connects to Claude Code CLI.

## Setup Steps

### Step 1: Prerequisites

Ensure the user has:
- Bun installed: `curl -fsSL https://bun.sh/install | bash`
- Claude Code CLI installed and authenticated
- Telegram bot token (from @BotFather)
- Discord bot token (from Discord Developer Portal)
- MCP server running with API key

### Step 2: Install Dependencies

```bash
bun install
```

### Step 3: Configure Environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required:
- TELEGRAM_BOT_TOKEN (or DISCORD_BOT_TOKEN, or both)
- MCP_URL
- MCP_API_KEY

Optional:
- TELEGRAM_USER_ID
- DISCORD_CHANNEL_IDS
- USER_NAME
- USER_TIMEZONE

### Step 4: Test Connections

```bash
bun run setup/test-all.ts
```

### Step 5: Run

```bash
bun run start
```

## Troubleshooting

### MCP Connection Failed

- Verify MCP server is running: `curl <MCP_URL>/health`
- Check API key is correct
- Ensure network connectivity

### Telegram Not Responding

- Verify bot token with @BotFather
- Check TELEGRAM_USER_ID is correct
- Bot must be started before sending messages

### Discord Not Responding

- Enable Message Content Intent in Discord Developer Portal
- Invite bot to server with correct permissions
- Check bot has access to configured channels

## Files

- `src/relay.ts` - Main application
- `src/memory.ts` - MCP integration
- `src/transcribe.ts` - Voice processing
- `.env.example` - Configuration template
- `daemon/claude-relay.service` - Systemd service for VPS
