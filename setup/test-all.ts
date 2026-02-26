#!/usr/bin/env bun
/**
 * Setup test script
 * Tests Telegram, Discord, and MCP connections
 */

import { readFileSync } from "fs";

// Load .env
const envPath = ".env";
let env: Record<string, string> = {};

try {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    
    // Find first = separator
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    if (key) {
      env[key] = value;
    }
  }
} catch {
  console.log("No .env file found. Please create one from .env.example");
  process.exit(1);
}

console.log("Testing connections...\n");

// Test Telegram
if (env.TELEGRAM_BOT_TOKEN) {
  console.log("Testing Telegram...");
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await response.json();
    if (data.ok) {
      console.log(`✅ Telegram: @${data.result.username}`);
    } else {
      console.log(`❌ Telegram: ${data.description}`);
    }
  } catch (error) {
    console.log(`❌ Telegram: ${error.message}`);
  }
} else {
  console.log("⏭️ Telegram: not configured");
}

// Test Discord
if (env.DISCORD_BOT_TOKEN) {
  console.log("Testing Discord...");
  try {
    const response = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Discord: ${data.username}#${data.discriminator}`);
    } else {
      console.log(`❌ Discord: ${response.status}`);
    }
  } catch (error) {
    console.log(`❌ Discord: ${error.message}`);
  }
} else {
  console.log("⏭️ Discord: not configured");
}

// Test MCP
if (env.MCP_URL) {
  console.log("Testing MCP...");
  try {
    const response = await fetch(`${env.MCP_URL.replace("/sse", "")}/health`);
    if (response.ok) {
      const data = await response.json();
      console.log(`✅ MCP: ${data.version || "connected"}`);
    } else {
      console.log(`❌ MCP: ${response.status}`);
    }
  } catch (error) {
    console.log(`❌ MCP: ${error.message}`);
  }
} else {
  console.log("⏭️ MCP: not configured");
}

console.log("\nDone!");
