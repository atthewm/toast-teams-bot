#!/usr/bin/env node

import { App } from "@microsoft/teams.apps";
import { loadConfig } from "./config/index.js";
import { ToastMcpClient } from "./mcp/client.js";
import { createChatPrompt, getMemory } from "./ai/prompt.js";
import { startScheduler } from "./scheduler/index.js";
import {
  registerChannel,
  getAllChannels,
  removeChannel,
} from "./proactive/store.js";
import {
  hasPermission,
  resolveRole,
  denyMessage,
  type Role,
  type RoleConfig,
} from "./auth/roles.js";

// Use console.log (stdout) for Azure App Service log capture
const log = (...args: unknown[]) => console.log("[Bot]", ...args);

const config = loadConfig();
log("Config loaded. MCP:", config.mcpServerUrl, "Model:", config.openaiModel);

const app = new App({
  clientId: config.botId,
  clientSecret: config.botPassword,
  tenantId: config.botTenantId,
  activity: { mentions: { stripText: true } },
  manifest: {
    name: { short: "Toast Ops", full: "Toast Restaurant Operations Bot" },
    bots: [{
      botId: config.botId,
      scopes: ["personal", "team", "groupChat"],
    }],
  },
});

const mcp = new ToastMcpClient(config.mcpServerUrl, config.mcpApiKey);

let prompt: ReturnType<typeof createChatPrompt>["prompt"];
try {
  const ai = createChatPrompt(config);
  prompt = ai.prompt;
  log("AI prompt initialized");
} catch (err) {
  log("AI prompt init failed:", (err as Error).message);
  // Create a fallback so the app still starts without AI
  prompt = null as unknown as typeof prompt;
}

const roleConfig: RoleConfig = {
  adminGroupId: config.adminGroupId,
  managerGroupId: config.managerGroupId,
};

mcp.connect().catch((err) => {
  log("MCP connect failed, will retry on first message:", err.message);
});

// -- Activity log for diagnostics --
const activityLog: Array<{ time: string; type: string; from: string; convType: string; text: string }> = [];

// Log EVERY incoming activity so we can see what reaches the bot
app.on("activity", async ({ activity }) => {
  const entry = {
    time: new Date().toISOString(),
    type: String(activity.type ?? "unknown"),
    from: activity.from?.name ?? activity.from?.id ?? "?",
    convType: String(activity.conversation?.conversationType ?? "?"),
    text: String((activity as unknown as Record<string, unknown>).text ?? "").slice(0, 100),
  };
  activityLog.push(entry);
  if (activityLog.length > 50) activityLog.shift();
  log("ACTIVITY:", JSON.stringify(entry));
});

// -- Role resolution cache (per session, not persisted) --
const roleCache = new Map<string, { role: Role; expires: number }>();
const ROLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUserRole(userId: string): Promise<Role> {
  // If no groups configured, everyone is admin (open access)
  if (!roleConfig.adminGroupId && !roleConfig.managerGroupId) {
    return "admin";
  }

  const cached = roleCache.get(userId);
  if (cached && Date.now() < cached.expires) {
    return cached.role;
  }

  // Fetch groups via Graph (requires bot token with Group.Read permissions)
  // For now, default to admin since we need Graph consent setup
  // TODO: Wire up Graph token once admin consent is granted
  const groups: string[] = [];
  const role = resolveRole(groups, roleConfig);

  roleCache.set(userId, { role, expires: Date.now() + ROLE_CACHE_TTL });
  return role;
}

// ---- Command: help ----
app.message(/^(help|\?)$/i, async ({ send }) => {
  await send(
    "**Toast Operations Bot**\n\n" +
    "**Commands:**\n" +
    "**health** : System health check\n" +
    "**menus** : Menu overview\n" +
    "**menu search [term]** : Search menu items\n" +
    "**orders** : Today's orders\n" +
    "**config** : Restaurant configuration\n" +
    "**status** : Authentication status\n" +
    "**capabilities** : Available API features\n\n" +
    "**Admin:**\n" +
    "**register [channel]** : Register this channel for reports (e.g. register ops-control)\n" +
    "**channels** : List registered channels\n" +
    "**unregister [channel]** : Remove a channel registration\n\n" +
    "Or just ask me anything in plain English!"
  );
});

// ---- Command: health ----
app.message(/^health(check)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "health")) { await send(denyMessage("health")); return; }

  await send("Running health check...");
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_healthcheck");
    if (!data) { await send(await mcp.callToolText("toast_healthcheck")); return; }
    const checks = data.checks as Record<string, { status: string; message: string; durationMs?: number }>;
    const cfg = data.config as Record<string, unknown>;

    let text = `**Health: ${data.overall}**\n\n`;
    if (checks) {
      for (const [name, check] of Object.entries(checks)) {
        const icon = check.status === "pass" ? "Pass" : "FAIL";
        text += `${icon} **${name}**: ${check.message}`;
        if (check.durationMs) text += ` (${check.durationMs}ms)`;
        text += "\n";
      }
    }
    if (cfg) {
      text += `\nRestaurants: ${cfg.restaurantsConfigured}, Writes: ${cfg.writesEnabled ? "On" : "Off"}, Dry Run: ${cfg.dryRun ? "Yes" : "No"}`;
    }
    await send(text);
  } catch (err) {
    await send(`Health check failed: ${(err as Error).message}`);
  }
});

// ---- Command: menu search ----
app.message(/^(menu search|search menu)\s+(.+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "search")) { await send(denyMessage("search")); return; }

  const match = activity.text?.match(/(menu search|search menu)\s+(.+)/i);
  const query = match?.[2]?.trim() ?? "";
  if (!query) {
    await send("Please provide a search term. Example: **menu search espresso**");
    return;
  }

  await send(`Searching for "${query}"...`);
  try {
    const rawText = await mcp.callToolText("toast_search_menu_items", { query });
    let data: { results?: Array<{ item: { name: string; price?: number }; menuName: string; groupName: string }> } | null = null;
    try { data = JSON.parse(rawText); } catch { /* plain text */ }

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

// ---- Command: menus ----
app.message(/^menus?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "menus")) { await send(denyMessage("menus")); return; }

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

// ---- Command: orders ----
app.message(/^orders?(\s+today)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "orders")) { await send(denyMessage("orders")); return; }

  await send("Fetching today's orders...");
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const rawText = await mcp.callToolText("toast_list_orders", { businessDate: today });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      detailsFetched?: number;
      orders?: Array<{
        guid?: string;
        displayNumber?: string;
        openedDate?: string;
        total?: number;
        itemCount?: number;
        voided?: boolean;
      }>;
    } | null = null;
    try { data = JSON.parse(rawText); } catch { /* plain text */ }

    if (!data || !data.orders || data.orders.length === 0) {
      await send("No orders found for today.");
      return;
    }

    let text = `**Orders for ${today}**\n\n`;
    text += `Total orders: **${data.totalOrders}**\n`;
    text += `Total sales: **$${data.totalSales?.toFixed(2) ?? "N/A"}**\n`;
    text += `(showing ${data.detailsFetched} of ${data.totalOrders})\n\n`;

    for (const o of data.orders) {
      if (o.voided) continue;
      const num = o.displayNumber ?? o.guid?.slice(0, 8) ?? "?";
      const total = o.total != null ? `$${o.total.toFixed(2)}` : "";
      const items = o.itemCount ? `${o.itemCount} item${o.itemCount === 1 ? "" : "s"}` : "";
      text += `#${num} ${total} ${items}\n`;
    }
    await send(text);
  } catch (err) {
    await send(`Failed to fetch orders: ${(err as Error).message}`);
  }
});

// ---- Command: config ----
app.message(/^config(uration)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "config")) { await send(denyMessage("config")); return; }

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

// ---- Command: status ----
app.message(/^(status|auth)$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "status")) { await send(denyMessage("status")); return; }

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

// ---- Command: capabilities ----
app.message(/^capabilities$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "capabilities")) { await send(denyMessage("capabilities")); return; }

  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_api_capabilities");
    await send(`**API Capabilities**\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 2000)}\n\`\`\``);
  } catch (err) {
    await send(`Failed: ${(err as Error).message}`);
  }
});

// ---- Command: register [channel-name] ----
app.message(/^register\s+(\S+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("register")); return; }

  const match = activity.text?.match(/register\s+(\S+)/i);
  const channelName = match?.[1]?.toLowerCase();
  if (!channelName) {
    await send("Usage: **register [channel-name]**\n\nExamples: register ops-control, register finance, register marketing");
    return;
  }

  const conversationId = activity.conversation?.id ?? "";
  const serviceUrl = (activity as unknown as Record<string, unknown>).serviceUrl as string ?? "";
  const teamId = activity.conversation?.tenantId ?? "";
  const userName = activity.from?.name ?? activity.from?.id ?? "unknown";

  if (!conversationId) {
    await send("Could not detect conversation ID. Make sure you run this in a Teams channel.");
    return;
  }

  const reg = registerChannel(channelName, conversationId, serviceUrl, userName, teamId);

  await send(
    `**Channel Registered**\n\n` +
    `Name: **${reg.name}**\n` +
    `Conversation ID: \`${reg.conversationId}\`\n` +
    `Registered by: ${reg.registeredBy}\n\n` +
    `This channel will now receive scheduled reports targeted to **#${channelName}**.`
  );
});

// ---- Command: channels ----
app.message(/^channels$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("channels")); return; }

  const channels = getAllChannels();
  const entries = Object.entries(channels);

  if (entries.length === 0) {
    await send("No channels registered. Use **register [name]** in a channel to set it up.");
    return;
  }

  let text = `**Registered Channels (${entries.length})**\n\n`;
  for (const [name, reg] of entries) {
    text += `**${name}**: \`${reg.conversationId.slice(0, 30)}...\` (by ${reg.registeredBy})\n`;
  }
  await send(text);
});

// ---- Command: unregister [channel-name] ----
app.message(/^unregister\s+(\S+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("unregister")); return; }

  const match = activity.text?.match(/unregister\s+(\S+)/i);
  const channelName = match?.[1]?.toLowerCase();
  if (!channelName) {
    await send("Usage: **unregister [channel-name]**");
    return;
  }

  if (removeChannel(channelName)) {
    await send(`Channel **${channelName}** unregistered. It will no longer receive reports.`);
  } else {
    await send(`Channel **${channelName}** was not registered.`);
  }
});

// ---- Fallback: handles @mention stripping + natural language ----
app.on("message", async ({ send, activity }) => {
  const raw = activity.text ?? "";
  // Strip <at>Bot Name</at> tags that Teams injects for @mentions in channels
  const text = raw.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
  log("Fallback handler. Raw:", JSON.stringify(raw).slice(0, 120), "| Stripped:", text.slice(0, 80));

  if (text.length < 2) {
    await send("Type **help** to see commands, or ask me anything.");
    return;
  }

  const lower = text.toLowerCase();

  // Skip commands that the app.message() regex handlers already caught.
  // Only skip commands that DON'T need fallback handling (i.e. the ones
  // where stripText reliably works). Admin commands (register, channels,
  // unregister) are handled below because @mention stripping is unreliable.
  if (
    /^(help|\?|health(check)?|menus?|menu search .+|search menu .+|orders?(\s+today)?|config(uration)?|status|auth|capabilities)$/i.test(lower)
  ) {
    return;
  }

  // ---- register [channel-name] (fallback for @mention in channels) ----
  const registerMatch = lower.match(/^register\s+(\S+)$/);
  if (registerMatch) {
    const role = await getUserRole(activity.from?.id ?? "");
    if (!hasPermission(role, "register")) { await send(denyMessage("register")); return; }

    const channelName = registerMatch[1];
    const conversationId = activity.conversation?.id ?? "";
    const serviceUrl = (activity as unknown as Record<string, unknown>).serviceUrl as string ?? "";
    const teamId = activity.conversation?.tenantId ?? "";
    const userName = activity.from?.name ?? activity.from?.id ?? "unknown";

    if (!conversationId) {
      await send("Could not detect conversation ID. Make sure you run this in a Teams channel.");
      return;
    }

    const reg = registerChannel(channelName, conversationId, serviceUrl, userName, teamId);

    await send(
      `**Channel Registered**\n\n` +
      `Name: **${reg.name}**\n` +
      `Conversation ID: \`${reg.conversationId}\`\n` +
      `Registered by: ${reg.registeredBy}\n\n` +
      `This channel will now receive scheduled reports targeted to **#${channelName}**.`
    );
    return;
  }

  // ---- channels (fallback) ----
  if (lower === "channels") {
    const role = await getUserRole(activity.from?.id ?? "");
    if (!hasPermission(role, "register")) { await send(denyMessage("channels")); return; }

    const channels = getAllChannels();
    const entries = Object.entries(channels);

    if (entries.length === 0) {
      await send("No channels registered. Use **register [name]** in a channel to set it up.");
      return;
    }

    let msg = `**Registered Channels (${entries.length})**\n\n`;
    for (const [name, reg] of entries) {
      msg += `**${name}**: \`${reg.conversationId.slice(0, 30)}...\` (by ${reg.registeredBy})\n`;
    }
    await send(msg);
    return;
  }

  // ---- unregister [channel-name] (fallback) ----
  const unregisterMatch = lower.match(/^unregister\s+(\S+)$/);
  if (unregisterMatch) {
    const role = await getUserRole(activity.from?.id ?? "");
    if (!hasPermission(role, "register")) { await send(denyMessage("unregister")); return; }

    const channelName = unregisterMatch[1];
    if (removeChannel(channelName)) {
      await send(`Channel **${channelName}** unregistered. It will no longer receive reports.`);
    } else {
      await send(`Channel **${channelName}** was not registered.`);
    }
    return;
  }

  // ---- Natural language: route through ChatPrompt + OpenAI + MCP ----
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "ai")) {
    await send("You don't have permission to use the AI assistant. Type **help** for available commands.");
    return;
  }

  if (!prompt) {
    await send("AI mode is not available (initialization failed). Use direct commands instead. Type **help**.");
    return;
  }

  try {
    log("AI query from", activity.from?.name ?? "unknown", ":", text.slice(0, 100));
    const conversationId = activity.conversation?.id ?? "default";
    const memory = getMemory(conversationId);

    const response = await prompt.send(text, { messages: memory });

    const reply = response.content ?? "I wasn't able to generate a response. Try rephrasing or use a direct command.";

    await send(reply);
  } catch (err) {
    const errMsg = (err as Error).message;
    log("AI error:", errMsg);

    if (errMsg.includes("401") || errMsg.includes("auth")) {
      await send("AI service authentication error. Check the OPENAI_API_KEY configuration.");
    } else if (errMsg.includes("429") || errMsg.includes("rate")) {
      await send("AI service is rate limited. Try again in a moment, or use a direct command.");
    } else {
      await send(`AI error: ${errMsg.slice(0, 200)}\n\nTry using a direct command instead (type **help**).`);
    }
  }
});

// ---- Start ----
// Diagnostic HTTP server on a separate port so we can check status without auth
import { createServer } from "node:http";
const diagPort = parseInt(process.env.DIAG_PORT ?? "3979", 10);
createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/diag") {
    res.end(JSON.stringify({
      status: "running",
      uptime: process.uptime(),
      activities: activityLog,
      channels: getAllChannels(),
      mcp: mcp.isConnected(),
    }, null, 2));
  } else {
    res.end(JSON.stringify({ status: "running", uptime: process.uptime() }));
  }
}).listen(diagPort, () => log("Diag server on port", diagPort));

app.start(config.port).then(() => {
  log("Toast Teams Bot v0.2.0 listening on port", config.port);
  log("AI:", config.openaiModel, "| Timezone:", config.timezone);
  log("MCP:", config.mcpServerUrl);

  // Start the scheduler for automated reports
  startScheduler(app, mcp, config.timezone);
}).catch((err) => {
  log("Fatal:", err.message);
  process.exit(1);
});
