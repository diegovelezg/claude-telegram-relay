/**
 * Discord + Telegram Relay
 * 
 * Connects both Discord and Telegram to Claude Code CLI.
 * Uses Diego's MCP for memory instead of Supabase.
 * 
 * Run: bun run src/relay.ts
 * 
 * Environment variables required:
 * - TELEGRAM_BOT_TOKEN (optional)
 * - TELEGRAM_USER_ID (optional)
 * - DISCORD_BOT_TOKEN (optional)
 * - DISCORD_CHANNEL_IDS (comma-separated)
 * - MCP_URL
 * - MCP_API_KEY
 * - CLAUDE_PATH (default: "claude")
 * - PROJECT_DIR
 */

import { Bot as TelegramBot } from "grammy";
import { Client as DiscordClient, GatewayIntentBits, TextChannel, ChannelType } from "discord.js";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  testMcpConnection,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

// Telegram (optional)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";

// Discord (optional)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_CHANNEL_IDS = (process.env.DISCORD_CHANNEL_IDS || "").split(",").filter(Boolean);

// Claude
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";

// Relay working directory
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".discord-telegram-relay");
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");
const SESSION_FILE = join(RELAY_DIR, "session.json");

// User config
const USER_NAME = process.env.USER_NAME || "User";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================
// SESSION MANAGEMENT
// ============================================================

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

process.on("exit", () => {
  try { require("fs").unlinkSync(LOCK_FILE); } catch {}
});
process.on("SIGINT", async () => { await releaseLock(); process.exit(0); });
process.on("SIGTERM", async () => { await releaseLock(); process.exit(0); });

// ============================================================
// SETUP
// ============================================================

// Verify at least one platform is configured
if (!TELEGRAM_BOT_TOKEN && !DISCORD_BOT_TOKEN) {
  console.error("No platform configured! Set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

// Test MCP connection
console.log("[Relay] Testing MCP connection...");
const mcpReady = await testMcpConnection();
if (!mcpReady) {
  console.warn("[Relay] Warning: MCP connection failed. Memory features may not work.");
}

// ============================================================
// TELEGRAM BOT
// ============================================================

let telegramBot: TelegramBot | null = null;

if (TELEGRAM_BOT_TOKEN) {
  console.log("[Relay] Initializing Telegram bot...");
  telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN);
  
  // Security: Only respond to authorized user
  telegramBot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (TELEGRAM_USER_ID && userId !== TELEGRAM_USER_ID) {
      console.log(`[Telegram] Unauthorized: ${userId}`);
      await ctx.reply("This bot is private.");
      return;
    }
    await next();
  });
}

// ============================================================
// DISCORD BOT
// ============================================================

let discordClient: DiscordClient | null = null;

if (DISCORD_BOT_TOKEN) {
  console.log("[Relay] Initializing Discord bot...");
  discordClient = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });
  
  discordClient.on("ready", () => {
    console.log(`[Discord] Logged in as ${discordClient?.user?.tag}`);
  });
  
  discordClient.on("messageCreate", async (msg) => {
    // Ignore bot messages
    if (msg.author.bot) return;
    
    // Check if in allowed channel or DM
    const isAllowedChannel = DISCORD_CHANNEL_IDS.includes(msg.channelId);
    const isDM = msg.channel.type === ChannelType.DM;
    
    if (!isAllowedChannel && !isDM) {
      console.log(`[Discord] Message from unauthorized channel: ${msg.channelId}`);
      return;
    }
    
    console.log(`[Discord] Message: ${msg.content.substring(0, 50)}...`);
    await msg.channel.sendTyping();
    
    const response = await processMessage(msg.content, msg.author.username);
    
    // Send response
    await msg.reply(response);
  });
}

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`[Claude] ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: process.env,
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("[Claude] Error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("[Claude] Spawn error:", error);
    return "Error: Could not run Claude CLI";
  }
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

async function processMessage(text: string, userName?: string): Promise<string> {
  // Gather context from MCP
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(text),
    getMemoryContext(),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, userName);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });

  // Process memory intents and clean response
  const response = await processMemoryIntents(rawResponse);

  return response;
}

// ============================================================
// PROMPT BUILDER
// ============================================================

let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet
}

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  userName?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via a messaging platform. Keep responses concise and conversational.",
  ];

  if (userName) parts.push(`You are speaking with ${userName}.`);
  parts.push(`Current time: ${timeStr}`);
  
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
    "\nWhen the user shares something worth remembering, sets goals, or completes goals," +
    "\ninclude these tags in your response (they are processed automatically):" +
    "\n[REMEMBER: fact to store]" +
    "\n[GOAL: goal text | DEADLINE: optional date]" +
    "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// ============================================================
// TELEGRAM HANDLERS
// ============================================================

if (telegramBot) {
  // Text messages
  telegramBot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    console.log(`[Telegram] Message: ${text.substring(0, 50)}...`);
    await ctx.replyWithChatAction("typing");

    const response = await processMessage(text, ctx.from?.first_name);
    await ctx.reply(response);
  });

  // Voice messages
  telegramBot.on("message:voice", async (ctx) => {
    const voice = ctx.message.voice;
    console.log(`[Telegram] Voice: ${voice.duration}s`);
    await ctx.replyWithChatAction("typing");

    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply("Voice transcription not configured.");
      return;
    }

    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
      const transcription = await transcribe(buffer);
      
      if (!transcription) {
        await ctx.reply("Could not transcribe voice.");
        return;
      }

      const response = await processMessage(`[Voice]: ${transcription}`, ctx.from?.first_name);
      await ctx.reply(response);
    } catch (error) {
      console.error("[Telegram] Voice error:", error);
      await ctx.reply("Could not process voice message.");
    }
  });

  // Photos
  telegramBot.on("message:photo", async (ctx) => {
    console.log("[Telegram] Photo received");
    await ctx.replyWithChatAction("typing");

    try {
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      
      const timestamp = Date.now();
      const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);
      
      const response = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      
      const caption = ctx.message.caption || "Analyze this image.";
      const prompt = `[Image: ${filePath}]\n\n${caption}`;
      
      const claudeResponse = await processMessage(prompt, ctx.from?.first_name);
      
      await unlink(filePath).catch(() => {});
      await ctx.reply(claudeResponse);
    } catch (error) {
      console.error("[Telegram] Image error:", error);
      await ctx.reply("Could not process image.");
    }
  });
}

// ============================================================
// START
// ============================================================

async function start() {
  console.log("\n" + "=".repeat(50));
  console.log("Discord + Telegram Relay");
  console.log("=".repeat(50));
  
  if (TELEGRAM_BOT_TOKEN) {
    console.log(`[Telegram] Bot token: configured`);
    console.log(`[Telegram] Allowed user: ${TELEGRAM_USER_ID || "ANY"}`);
  }
  
  if (DISCORD_BOT_TOKEN) {
    console.log(`[Discord] Bot token: configured`);
    console.log(`[Discord] Allowed channels: ${DISCORD_CHANNEL_IDS.join(", ") || "ALL"}`);
  }
  
  console.log(`[Claude] Path: ${CLAUDE_PATH}`);
  console.log(`[Claude] Project: ${PROJECT_DIR || "(relay dir)"}`);
  console.log(`[MCP] Status: ${mcpReady ? "connected" : "failed"}`);
  console.log("=".repeat(50) + "\n");

  // Start Telegram
  if (telegramBot) {
    telegramBot.start({
      onStart: () => console.log("[Telegram] Bot is running!"),
    });
  }

  // Start Discord
  if (discordClient) {
    await discordClient.login(DISCORD_BOT_TOKEN);
  }
}

start();
