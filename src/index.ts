#!/usr/bin/env node

import { App } from "@microsoft/teams.apps";
import { loadConfig } from "./config/index.js";
import { ToastMcpClient } from "./mcp/client.js";

const config = loadConfig();

const app = new App({
  clientId: config.botId,
  clientSecret: config.botPassword,
  tenantId: config.botTenantId,
});

const mcp = new ToastMcpClient(config.mcpServerUrl, config.mcpApiKey);

mcp.connect().catch((err) => {
  console.error(`[Bot] MCP connect failed, will retry on first message: ${err.message}`);
});

// Help
app.message(/^(help|\?)$/i, async ({ send }) => {
  await send(
    "**Toast Operations Bot**\n\n" +
    "Commands:\n" +
    "- **health** : Run a system health check\n" +
    "- **menus** : Show menu overview\n" +
    "- **menu search [term]** : Search menu items\n" +
    "- **orders** : List today's orders\n" +
    "- **config** : Show restaurant configuration\n" +
    "- **status** : Check authentication status\n" +
    "- **capabilities** : Show available features"
  );
});

// Health
app.message(/^health(check)?$/i, async ({ send }) => {
  await send("Running health check...");
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_healthcheck");
    if (!data) { await send(await mcp.callToolText("toast_healthcheck")); return; }
    const checks = data.checks as Record<string, { status: string; message: string; durationMs?: number }>;
    const config = data.config as Record<string, unknown>;

    let text = `**Health: ${data.overall}**\n\n`;
    if (checks) {
      for (const [name, check] of Object.entries(checks)) {
        const icon = check.status === "pass" ? "Pass" : "FAIL";
        text += `${icon} **${name}**: ${check.message}`;
        if (check.durationMs) text += ` (${check.durationMs}ms)`;
        text += "\n";
      }
    }
    if (config) {
      text += `\nRestaurants: ${config.restaurantsConfigured}, Writes: ${config.writesEnabled ? "On" : "Off"}, Dry Run: ${config.dryRun ? "Yes" : "No"}`;
    }
    await send(text);
  } catch (err) {
    await send(`Health check failed: ${(err as Error).message}`);
  }
});

// Menu search
app.message(/^(menu search|search menu)\s+(.+)/i, async ({ send, activity }) => {
  const match = activity.text?.match(/^(menu search|search menu)\s+(.+)/i);
  const query = match?.[2]?.trim() ?? "";
  if (!query) {
    await send("Please provide a search term. Example: **menu search espresso**");
    return;
  }

  await send(`Searching for "${query}"...`);
  try {
    // Use callToolText since the MCP tool may return plain text for no results
    const rawText = await mcp.callToolText("toast_search_menu_items", { query });

    // Try to parse as JSON (structured results)
    let data: { results?: Array<{ item: { name: string; price?: number }; menuName: string; groupName: string }> } | null = null;
    try { data = JSON.parse(rawText); } catch { /* plain text response */ }

    if (!data || !data.results || data.results.length === 0) {
      await send(`No items found matching "${query}".`);
      return;
    }

    let text = `**Menu Search: "${query}"** (${data.results.length} results)\n\n`;
    for (const r of data.results.slice(0, 15)) {
      const price = r.item.price != null ? `$${r.item.price.toFixed(2)}` : "N/A";
      text += `**${r.item.name}** ${price} (${r.menuName} > ${r.groupName})\n`;
    }
    if (data.results.length > 15) {
      text += `\n... and ${data.results.length - 15} more`;
    }
    await send(text);
  } catch (err) {
    await send(`Menu search failed: ${(err as Error).message}`);
  }
});

// Menus
app.message(/^menus?$/i, async ({ send }) => {
  try {
    const data = await mcp.callToolJson<{
      menuCount: number;
      menus: Array<{ guid: string; name: string; groupCount: number }>;
    }>("toast_get_menu_metadata");

    if (!data || !data.menus) {
      await send(await mcp.callToolText("toast_get_menu_metadata"));
      return;
    }

    let text = `**Menus (${data.menuCount})**\n\n`;
    for (const m of data.menus) {
      text += `**${m.name}**: ${m.groupCount} group${m.groupCount === 1 ? "" : "s"}\n`;
    }
    await send(text);
  } catch (err) {
    await send(`Failed to fetch menus: ${(err as Error).message}`);
  }
});

// Orders
app.message(/^orders?(\s+today)?$/i, async ({ send }) => {
  await send("Fetching today's orders...");
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    // The MCP tool returns { count, orders } but fallback to raw text
    const rawText = await mcp.callToolText("toast_list_orders", { businessDate: today });

    let data: { count?: number; orders?: Array<{ guid?: string; server?: { name?: string }; checks?: Array<{ totalAmount?: number }> }> } | null = null;
    try { data = JSON.parse(rawText); } catch { /* plain text */ }

    if (!data || !data.orders || data.orders.length === 0) {
      await send("No orders found for today.");
      return;
    }

    let text = `**Orders for ${today}** (${data.count ?? data.orders.length})\n\n`;
    for (const o of data.orders.slice(0, 20)) {
      const guid = o.guid ?? "unknown";
      const total = o.checks?.reduce((s, c) => s + (c.totalAmount ?? 0), 0)?.toFixed(2);
      text += `${guid.slice(0, 8)}... ${o.server?.name ?? ""} ${total ? `$${total}` : ""}\n`;
    }
    if (data.orders.length > 20) {
      text += `\n... and ${data.orders.length - 20} more`;
    }
    await send(text);
  } catch (err) {
    await send(`Failed to fetch orders: ${(err as Error).message}`);
  }
});

// Config
app.message(/^config(uration)?$/i, async ({ send }) => {
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_get_config_summary");
    if (!data) { await send(await mcp.callToolText("toast_get_config_summary")); return; }
    const restaurant = data.restaurant as Record<string, unknown> | null;
    const revenueCenters = data.revenueCenters as Array<{ name: string }>;
    const diningOptions = data.diningOptions as Array<{ name: string }>;
    const serviceAreas = data.serviceAreas as Array<{ name: string }>;

    let text = `**${restaurant?.name ?? "Restaurant Configuration"}**\n\n`;
    if (restaurant) {
      text += `Timezone: ${restaurant.timezone ?? "N/A"}, Currency: ${restaurant.currencyCode ?? "N/A"}\n\n`;
    }
    if (revenueCenters?.length > 0) {
      text += `**Revenue Centers (${revenueCenters.length})**: ${revenueCenters.map(r => r.name).join(", ")}\n`;
    }
    if (diningOptions?.length > 0) {
      text += `**Dining Options (${diningOptions.length})**: ${diningOptions.map(d => d.name).join(", ")}\n`;
    }
    if (serviceAreas?.length > 0) {
      text += `**Service Areas (${serviceAreas.length})**: ${serviceAreas.map(s => s.name).join(", ")}\n`;
    }
    await send(text);
  } catch (err) {
    await send(`Failed to fetch config: ${(err as Error).message}`);
  }
});

// Status
app.message(/^(status|auth)$/i, async ({ send }) => {
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_auth_status");
    if (!data) { await send(await mcp.callToolText("toast_auth_status")); return; }
    await send(
      `**Authentication Status**\n\n` +
      `Authenticated: **${data.authenticated}**\n` +
      `API Host: ${data.apiHost}\n` +
      `Restaurants: ${(data.configuredRestaurants as string[])?.length ?? 0}\n` +
      `Writes Enabled: ${data.writesEnabled}\n` +
      `Dry Run: ${data.dryRun}`
    );
  } catch (err) {
    await send(`Status check failed: ${(err as Error).message}`);
  }
});

// Capabilities
app.message(/^capabilities$/i, async ({ send }) => {
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_api_capabilities");
    await send(`**API Capabilities**\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 2000)}\n\`\`\``);
  } catch (err) {
    await send(`Failed: ${(err as Error).message}`);
  }
});

// Fallback: show what we actually received for debugging
app.on("message", async ({ send, activity }) => {
  const raw = activity.text ?? "";
  // Strip any bot @mention tags that Teams may include
  const text = raw.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();

  if (text.length < 2) {
    await send("Type **help** to see available commands.");
    return;
  }

  // Try to match commands manually since Teams may alter the text
  const lower = text.toLowerCase();

  if (lower === "help" || lower === "?") {
    await send("Use one of: **health**, **menus**, **menu search [term]**, **orders**, **config**, **status**, **capabilities**");
    return;
  }

  if (lower.startsWith("menu search ") || lower.startsWith("search menu ") || lower.startsWith("search ")) {
    const query = lower.replace(/^(menu search|search menu|search)\s+/, "").trim();
    if (query) {
      await send(`Searching for "${query}"...`);
      try {
        const rawText = await mcp.callToolText("toast_search_menu_items", { query });
        let data: { results?: Array<{ item: { name: string; price?: number }; menuName: string; groupName: string }> } | null = null;
        try { data = JSON.parse(rawText); } catch { /* plain text */ }
        if (!data || !data.results || data.results.length === 0) {
          await send(`No items found matching "${query}".`);
          return;
        }
        let msg = `**Menu Search: "${query}"** (${data.results.length} results)\n\n`;
        for (const r of data.results.slice(0, 15)) {
          const price = r.item.price != null ? `$${r.item.price.toFixed(2)}` : "N/A";
          msg += `**${r.item.name}** ${price} (${r.menuName} > ${r.groupName})\n`;
        }
        await send(msg);
      } catch (err) {
        await send(`Search failed: ${(err as Error).message}`);
      }
      return;
    }
  }

  if (lower === "menus" || lower === "menu") {
    await send("Fetching menus... (try the **menus** command)");
    return;
  }

  await send(`Did not match command: "${text}" (raw: "${raw.slice(0, 100)}"). Type **help** for commands.`);
});

app.start(config.port).catch((err) => {
  console.error(`[Bot] Fatal: ${err.message}`);
  process.exit(1);
});

console.error(`[Bot] Toast Teams Bot starting on port ${config.port}`);
