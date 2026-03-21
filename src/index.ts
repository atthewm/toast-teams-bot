#!/usr/bin/env node

import { App } from "@microsoft/teams.apps";
import { MessageActivity } from "@microsoft/teams.api";
import { loadConfig } from "./config/index.js";
import { ToastMcpClient } from "./mcp/client.js";
import {
  infoCard,
  errorCard,
  healthCard,
  menuSearchCard,
  configCard,
  orderListCard,
} from "./cards/templates.js";

const config = loadConfig();

// Initialize the Teams app
const app = new App({
  clientId: config.botId,
  clientSecret: config.botPassword,
  tenantId: config.botTenantId,
});

// MCP client for Toast data
const mcp = new ToastMcpClient(config.mcpServerUrl, config.mcpApiKey);

// Connect to MCP server on startup
mcp.connect().catch((err) => {
  console.error(`[Bot] MCP connect failed, will retry on first message: ${err.message}`);
});

// Store conversation IDs for proactive messaging
const conversations = new Map<string, string>();

// Bot installation
app.on("install.add", async ({ send, activity }) => {
  conversations.set(
    activity.conversation?.id ?? "unknown",
    activity.conversation?.id ?? ""
  );
  await send(
    "Hello! I am the Toast Operations Bot. I can help you query " +
      "restaurant data, search menus, check orders, and monitor system health.\n\n" +
      "Try: **health**, **menu search [term]**, **orders**, **config**, or **help**"
  );
});

// Command: help
app.message(/^(help|\?)$/i, async ({ send }) => {
  await send(
    infoCard(
      "Toast Operations Bot",
      "Available commands:",
      [
        { title: "health", value: "Run a full system health check" },
        { title: "menu search [term]", value: "Search menu items by keyword" },
        { title: "menus", value: "Show menu overview" },
        { title: "orders", value: "List today's orders" },
        { title: "order [guid]", value: "Get details for a specific order" },
        { title: "config", value: "Show restaurant configuration" },
        { title: "status", value: "Check authentication status" },
        { title: "capabilities", value: "Show available features" },
      ]
    )
  );
});

// Command: health
app.message(/^health(check)?$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson("toast_healthcheck");
    await send(healthCard(data as Record<string, unknown>));
  } catch (err) {
    await send(errorCard("Health check failed", (err as Error).message));
  }
});

// Command: menu search
app.message(/^(menu search|search menu)\s+(.+)/i, async ({ send, activity }) => {
  const match = activity.text?.match(/^(menu search|search menu)\s+(.+)/i);
  const query = match?.[2]?.trim() ?? "";
  if (!query) {
    await send("Please provide a search term. Example: **menu search espresso**");
    return;
  }

  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson<{
      query: string;
      resultCount: number;
      results: Array<{
        item: { name: string; price?: number; guid: string };
        menuName: string;
        groupName: string;
        matchField: string;
      }>;
    }>("toast_search_menu_items", { query });

    if (!data.results || data.results.length === 0) {
      await send(`No menu items found matching "${query}".`);
      return;
    }

    await send(menuSearchCard(query, data.results));
  } catch (err) {
    await send(errorCard("Menu search failed", (err as Error).message));
  }
});

// Command: menus
app.message(/^menus?$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson<{
      menuCount: number;
      menus: Array<{ guid: string; name: string; groupCount: number }>;
    }>("toast_get_menu_metadata");

    await send(
      infoCard(
        `Menus (${data.menuCount})`,
        "Available menus:",
        data.menus.map((m) => ({
          title: m.name,
          value: `${m.groupCount} group${m.groupCount === 1 ? "" : "s"}`,
        }))
      )
    );
  } catch (err) {
    await send(errorCard("Failed to fetch menus", (err as Error).message));
  }
});

// Command: orders
app.message(/^orders?(\s+today)?$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const data = await mcp.callToolJson<{
      count: number;
      orders: Array<{
        guid: string;
        openedDate?: string;
        closedDate?: string;
        server?: { name?: string };
        checks?: Array<{ totalAmount?: number }>;
      }>;
    }>("toast_list_orders", { businessDate: today });

    if (data.orders.length === 0) {
      await send("No orders found for today.");
      return;
    }

    await send(orderListCard(data.orders, today));
  } catch (err) {
    await send(errorCard("Failed to fetch orders", (err as Error).message));
  }
});

// Command: order [guid]
app.message(/^order\s+([a-f0-9-]+)/i, async ({ send, activity }) => {
  const match = activity.text?.match(/^order\s+([a-f0-9-]+)/i);
  const guid = match?.[1] ?? "";
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson("toast_get_order", { orderGuid: guid });
    await send(
      infoCard(
        `Order ${guid.slice(0, 8)}...`,
        "Order details:",
        [{ title: "Data", value: JSON.stringify(data, null, 2).slice(0, 500) }]
      )
    );
  } catch (err) {
    await send(errorCard("Failed to fetch order", (err as Error).message));
  }
});

// Command: config
app.message(/^config(uration)?$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson("toast_get_config_summary");
    await send(configCard(data as Record<string, unknown>));
  } catch (err) {
    await send(errorCard("Failed to fetch config", (err as Error).message));
  }
});

// Command: status
app.message(/^(status|auth)$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_auth_status");
    await send(
      infoCard(
        "Authentication Status",
        data.authenticated ? "Connected to Toast API" : "Not authenticated",
        [
          { title: "Authenticated", value: String(data.authenticated) },
          { title: "API Host", value: String(data.apiHost) },
          {
            title: "Restaurants",
            value: String((data.configuredRestaurants as string[])?.length ?? 0),
          },
          { title: "Writes Enabled", value: String(data.writesEnabled) },
        ]
      )
    );
  } catch (err) {
    await send(errorCard("Status check failed", (err as Error).message));
  }
});

// Command: capabilities
app.message(/^capabilities$/i, async ({ send }) => {
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson("toast_api_capabilities");
    await send(
      infoCard("API Capabilities", JSON.stringify(data, null, 2).slice(0, 1000))
    );
  } catch (err) {
    await send(errorCard("Failed to fetch capabilities", (err as Error).message));
  }
});

// Fallback: unrecognized messages try a menu search
app.on("message", async ({ send, activity }) => {
  const text = (activity.text ?? "").trim();
  if (text.length < 2) {
    await send("Type **help** to see available commands.");
    return;
  }

  // Try menu search as a fallback
  await send({ type: "typing" });
  try {
    const data = await mcp.callToolJson<{
      results?: Array<{
        item: { name: string; price?: number; guid: string };
        menuName: string;
        groupName: string;
        matchField: string;
      }>;
    }>("toast_search_menu_items", { query: text });

    if (data.results && data.results.length > 0) {
      await send(menuSearchCard(text, data.results));
    } else {
      await send(
        `I did not find anything matching "${text}". Type **help** for available commands.`
      );
    }
  } catch {
    await send(
      `I did not understand "${text}". Type **help** for available commands.`
    );
  }
});

// Proactive message helper (exported for future event integration)
export async function sendProactiveAlert(
  conversationId: string,
  title: string,
  body: string
): Promise<void> {
  const card = infoCard(title, body);
  await app.send(conversationId, new MessageActivity(JSON.stringify(card)));
}

// Start the app
app.start(config.port).catch((err) => {
  console.error(`[Bot] Fatal: ${err.message}`);
  process.exit(1);
});

console.error(`[Bot] Toast Teams Bot starting on port ${config.port}`);
