/**
 * Memory Module for Discord-Telegram Relay
 * 
 * Uses Diego's MCP server for persistent memory instead of Supabase.
 * Memory intents are sent to MCP for storage and retrieval.
 * 
 * Intent tags (Claude automatically includes these in responses):
 *   [REMEMBER: fact to store]
 *   [GOAL: text | DEADLINE: optional date]
 *   [DONE: search text for completed goal]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ============================================================
// MCP CONFIGURATION
// ============================================================

const MCP_URL = process.env.MCP_URL || "http://localhost:3001/sse";
const MCP_API_KEY = process.env.MCP_API_KEY || "";

// ============================================================
// MCP CLIENT
// ============================================================

let mcpClient: Client | null = null;
let mcpClientPromise: Promise<Client> | null = null;

async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;
  
  // Prevent race condition with proper mutex
  if (mcpClientPromise) {
    return mcpClientPromise;
  }
  
  mcpClientPromise = (async () => {
    // Build headers with API key instead of query string
    const headers: Record<string, string> = {};
    if (MCP_API_KEY) {
      headers["x-api-key"] = MCP_API_KEY;
    }
    
    const url = new URL(MCP_URL);
    const transport = new SSEClientTransport(url, { headers });
    mcpClient = new Client({ name: "discord-telegram-relay", version: "1.0.0" });
    await mcpClient.connect(transport);
    
    console.log("[Memory] MCP connected");
    return mcpClient;
  })();
  
  return mcpClientPromise;
}

// ============================================================
// MEMORY INTENT PROCESSING
// ============================================================

/**
 * Parse Claude's response for memory intent tags.
 * Saves to MCP and returns cleaned response.
 */
export async function processMemoryIntents(response: string): Promise<string> {
  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const fact = match[1].trim();
    try {
      await saveMemory(fact, "fact");
      console.log(`[Memory] Saved fact: ${fact.substring(0, 50)}...`);
    } catch (error) {
      console.error("[Memory] Error saving fact:", error);
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    const goal = match[1].trim();
    const deadline = match[2]?.trim();
    try {
      await saveMemory(goal, "goal", deadline);
      console.log(`[Memory] Saved goal: ${goal.substring(0, 50)}...`);
    } catch (error) {
      console.error("[Memory] Error saving goal:", error);
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();
    try {
      await markGoalComplete(searchText);
      console.log(`[Memory] Marked goal complete: ${searchText}`);
    } catch (error) {
      console.error("[Memory] Error marking goal complete:", error);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

// ============================================================
// MCP STORAGE
// ============================================================

async function saveMemory(content: string, type: string, deadline?: string): Promise<void> {
  const client = await getMcpClient();
  
  const title = content.substring(0, 100);
  const nature = type === "fact" ? "know" : "action";
  const subject = deadline ? `DEADLINE: ${deadline}` : "";
  
  await client.callTool({
    name: "ledger_item_create",
    arguments: {
      title,
      status: "inbox",
      priority: "medium",
      nature,
      subject,
      category: "memory"
    }
  });
}

async function markGoalComplete(searchText: string): Promise<void> {
  // Search for the goal and mark it as done
  const client = await getMcpClient();
  
  const result = await client.callTool({
    name: "ledger_query",
    arguments: {
      query: searchText,
      limit: 5
    }
  });
  
  // Parse result and mark first matching goal as done
  try {
    const data = JSON.parse(result.content[0].text);
    if (data.data?.items?.length) {
      const firstItem = data.data.items[0];
      if (firstItem && firstItem.id) {
        await client.callTool({
          name: "ledger_item_update",
          arguments: {
            id: firstItem.id,
            status: "done"
          }
        });
        console.log(`[Memory] Marked goal complete: ${firstItem.title}`);
        return;
      }
    }
  } catch (error) {
    console.error("[Memory] Error parsing ledger result:", error);
  }
  
  console.log(`[Memory] Could not find goal to mark complete: ${searchText}`);
}

// ============================================================
// CONTEXT RETRIEVAL
// ============================================================

/**
 * Get facts and active goals for prompt context.
 */
export async function getMemoryContext(): Promise<string> {
  try {
    const client = await getMcpClient();
    
    // Get todo items (goals)
    const todoResult = await client.callTool({
      name: "ledger_query",
      arguments: { status: "todo", limit: 10 }
    });
    
    // Get inbox items
    const inboxResult = await client.callTool({
      name: "ledger_query",
      arguments: { status: "inbox", limit: 10 }
    });
    
    const parts: string[] = [];
    
    // Parse inbox items as facts/context
    try {
      const inboxData = JSON.parse(inboxResult.content[0].text);
      if (inboxData.data?.items?.length) {
        const facts = inboxData.data.items
          .filter((i: any) => i.nature === "know")
          .map((i: any) => i.title)
          .join("\n");
        if (facts) {
          parts.push(`FACTS:\n${facts}`);
        }
      }
    } catch {
      // Ignore parse errors
    }
    
    // Parse todo items as goals
    try {
      const todoData = JSON.parse(todoResult.content[0].text);
      if (todoData.data?.items?.length) {
        const goals = todoData.data.items
          .map((i: any) => `- ${i.title}`)
          .join("\n");
        parts.push(`PENDING:\n${goals}`);
      }
    } catch {
      // Ignore parse errors
    }
    
    return parts.join("\n\n");
  } catch (error) {
    console.error("[Memory] Context error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant context.
 */
export async function getRelevantContext(query: string): Promise<string> {
  try {
    const client = await getMcpClient();
    
    const result = await client.callTool({
      name: "ledger_query",
      arguments: { query, limit: 5 }
    });
    
    try {
      const data = JSON.parse(result.content[0].text);
      if (data.data?.items?.length) {
        const context = data.data.items
          .map((i: any) => `[${i.nature}]: ${i.title}`)
          .join("\n");
        return `RELEVANT CONTEXT:\n${context}`;
      }
    } catch {
      // Ignore parse errors
    }
    
    return "";
  } catch (error) {
    console.error("[Memory] Search error:", error);
    return "";
  }
}

// ============================================================
// MCP TEST
// ============================================================

export async function testMcpConnection(): Promise<boolean> {
  try {
    const client = await getMcpClient();
    
    // Try a simple query to verify connection
    const result = await client.callTool({
      name: "ledger_query",
      arguments: { status: "inbox", limit: 1 }
    });
    
    console.log("[Memory] MCP connection successful");
    return true;
  } catch (error) {
    console.error("[Memory] MCP connection failed:", error);
    return false;
  }
}
