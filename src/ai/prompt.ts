/**
 * ChatPrompt factory: wires OpenAI model + McpClientPlugin for natural language mode.
 * The ChatPrompt auto-discovers MCP tools and lets the LLM call them as needed.
 */

import { ChatPrompt, LocalMemory } from "@microsoft/teams.ai";
import { McpClientPlugin } from "@microsoft/teams.mcpclient";
import { OpenAIChatModel } from "./model.js";
import type { BotConfig } from "../config/index.js";

const SYSTEM_INSTRUCTIONS = `You are Toast Ops, the AI operations assistant for Remote Coffee.
Remote Coffee is a single location coffee shop that closes at 6 PM Central Time.

You have access to Toast POS data through MCP tools. Use them to answer questions about:
menus, menu items, prices, orders, sales, restaurant configuration, dining options, and system health.

Rules:
1. Be concise. This is a work chat, not an essay.
2. Format for Teams: use markdown, bold key numbers.
3. Always include dollar amounts when discussing sales or prices.
4. Use today's date for "today" queries. Yesterday means the previous calendar day.
5. If a tool fails or returns no data, say so clearly.
6. Do not fabricate data. Only report what tools return.
7. Never use dashes of any kind in your responses. Use commas, colons, or rewrite instead.

Dining platform mapping:
DoorDash: "DoorDash", "DoorDash Delivery", "DoorDash Takeout"
Uber Eats: "Uber Eats Delivery", "Uber Eats Takeout", "UberEats", "UberEats Delivery"
Grubhub: "Grubhub", "Grubhub Delivery"

When users ask about marketplace or third party sales, use these names to identify platform orders.`;

// Per conversation memory, keyed by conversation ID
const memories = new Map<string, LocalMemory>();

export function createChatPrompt(config: BotConfig) {
  const model = new OpenAIChatModel(config.openaiApiKey, config.openaiModel);

  const mcpPlugin = new McpClientPlugin();

  const prompt = new ChatPrompt(
    {
      model,
      instructions: SYSTEM_INSTRUCTIONS,
    },
    [mcpPlugin]
  );

  const headers: Record<string, string> = {};
  if (config.mcpApiKey) {
    headers["Authorization"] = `Bearer ${config.mcpApiKey}`;
  }

  prompt.usePlugin("mcpClient", {
    url: config.mcpServerUrl,
    params: {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      skipIfUnavailable: true,
    },
  });

  return { prompt, model, mcpPlugin };
}

export function getMemory(conversationId: string): LocalMemory {
  let memory = memories.get(conversationId);
  if (!memory) {
    memory = new LocalMemory({ max: 20 });
    memories.set(conversationId, memory);
  }
  return memory;
}
