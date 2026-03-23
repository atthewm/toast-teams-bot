#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { App } from "@microsoft/teams.apps";
import { loadConfig } from "./config/index.js";
import { ToastMcpClient } from "./mcp/client.js";
import {
  dailySalesSummary,
  marketplaceBreakdown,
  rushRecap,
  shiftRoster,
  endOfDaySummary,
} from "./reports/index.js";
import { pollAlerts, resetAlertState } from "./alerts/monitor.js";
import { buildDailySummary, saveSummary } from "./cache/history.js";

/** Get today's YYYYMMDD in the configured timezone (not UTC). */
function todayDateStr(tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}${parts.find((p) => p.type === "month")!.value}${parts.find((p) => p.type === "day")!.value}`;
}

// Write activity log to persistent file on Azure for debugging
const LOG_FILE = "/home/LogFiles/bot-activity.log";
function logToFile(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* not on Azure */ }
}
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
app.on("activity", async ({ activity, send, next }) => {
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
  logToFile("ACTIVITY: " + JSON.stringify(entry));

  // Teams SDK v2 does not route channel messages to app.message() / app.on("message").
  // Handle channel messages here directly. Personal messages pass through to app.message() handlers.
  if (
    String(activity.type) !== "message" ||
    String(activity.conversation?.conversationType) === "personal"
  ) {
    await next();
    return;
  }

  // Channel message handling below
  {
    const raw = String((activity as unknown as Record<string, unknown>).text ?? "");
    const text = raw.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
    logToFile("CHANNEL_MSG: stripped=" + text);

    if (text.length < 2) return;

    const lower = text.toLowerCase();

    try {
      // Help
      if (lower === "help" || lower === "?") {
        await send(
          "**Toast Operations Bot**\n\n" +
          "**Commands:**\n" +
          "**health** : System health check\n" +
          "**menus** : Menu overview\n" +
          "**menu search [term]** : Search menu items\n" +
          "**orders** : Today's orders\n" +
          "**config** : Restaurant configuration\n" +
          "**status** : Authentication status\n\n" +
          "**Reports:**\n" +
          "**test sales** : Yesterday's sales summary\n" +
          "**test marketplace** : Platform breakdown\n" +
          "**test morning/lunch/afternoon** : Rush recaps\n" +
          "**test alerts** : Check for active alerts\n" +
          "**test drivethru** : Drive-thru speed report\n" +
          "**test eod** : End of day summary with comparisons\n" +
          "**test all** : Run all reports\n" +
          "**reset alerts** : Clear alert state\n\n" +
          "**Admin:**\n" +
          "**register [channel]** : Register this channel for reports\n" +
          "**channels** : List registered channels\n\n" +
          "Or just ask me anything in plain English!"
        );
        return;
      }

      // Register
      const registerMatch = lower.match(/^register\s+(\S+)$/);
      if (registerMatch) {
        const channelName = registerMatch[1];
        const conversationId = activity.conversation?.id ?? "";
        const serviceUrl = String((activity as unknown as Record<string, unknown>).serviceUrl ?? "");
        const userName = activity.from?.name ?? "unknown";
        if (!conversationId) { await send("Could not detect conversation ID."); return; }
        const reg = registerChannel(channelName, conversationId, serviceUrl, userName);
        await send(
          `**Channel Registered**\n\n` +
          `Name: **${reg.name}**\n` +
          `Conversation ID: \`${reg.conversationId}\`\n` +
          `Registered by: ${reg.registeredBy}\n\n` +
          `This channel will now receive scheduled reports targeted to **#${channelName}**.`
        );
        return;
      }

      // Channels
      if (lower === "channels") {
        const channels = getAllChannels();
        const entries = Object.entries(channels);
        if (entries.length === 0) { await send("No channels registered."); return; }
        let msg = `**Registered Channels (${entries.length})**\n\n`;
        for (const [name, reg] of entries) {
          msg += `**${name}**: registered by ${reg.registeredBy}\n`;
        }
        await send(msg);
        return;
      }

      // Test reports: run a specific report and post the result here
      const testMatch = lower.match(/^test\s+(sales|marketplace|morning|lunch|afternoon|roster|alerts|drive-?thru|eod|all)$/);
      if (testMatch) {
        const report = testMatch[1].replace("-", "");
        await send(`Running **${report}** report...`);
        try {
          if (report === "sales" || report === "all") {
            await send(await dailySalesSummary(mcp, config.timezone));
          }
          if (report === "marketplace" || report === "all") {
            await send(await marketplaceBreakdown(mcp, config.timezone));
          }
          if (report === "morning" || report === "all") {
            await send(await rushRecap(mcp, "Morning Rush Recap", 6, 10, config.timezone));
          }
          if (report === "lunch" || report === "all") {
            await send(await rushRecap(mcp, "Lunch Rush Recap", 11, 14, config.timezone));
          }
          if (report === "afternoon" || report === "all") {
            await send(await rushRecap(mcp, "Afternoon Recap", 14, 18, config.timezone));
          }
          if (report === "roster" || report === "all") {
            await send(await shiftRoster(mcp));
          }
          if (report === "alerts" || report === "all") {
            const alerts = await pollAlerts(mcp, config);
            const count = alerts.largeOrders.length +
              (alerts.voidAlert ? 1 : 0) +
              (alerts.longOpenAlert ? 1 : 0) +
              (alerts.driveThruAlert ? 1 : 0);
            if (count === 0) {
              await send("**Alert Check**: No active alerts right now.");
            } else {
              for (const msg of alerts.largeOrders) await send(msg);
              if (alerts.voidAlert) await send(alerts.voidAlert);
              if (alerts.longOpenAlert) await send(alerts.longOpenAlert);
              if (alerts.driveThruAlert) await send(alerts.driveThruAlert);
            }
          }
          if (report === "drivethru" || report === "all") {
            const dateStr = todayDateStr(config.timezone);
            const raw = await mcp.callToolText("toast_list_orders", { businessDate: dateStr, detailCount: 200 });
            let data: { orders?: Array<{ diningOptionName?: string; openedDate?: string; closedDate?: string; voided?: boolean; displayNumber?: string; guid?: string }> } | null = null;
            try { data = JSON.parse(raw); } catch { /* text */ }
            const DT = ["drive thru", "drive-thru", "drivethru", "drive through"];
            const dtOrders = (data?.orders ?? []).filter((o) => {
              if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
              return DT.some((n) => o.diningOptionName!.toLowerCase().includes(n));
            });
            if (dtOrders.length === 0) {
              await send("**Drive-Thru Speed**: No completed drive-thru orders today.");
            } else {
              let total = 0;
              let count2 = 0;
              const lines: string[] = [];
              for (const o of dtOrders) {
                const sec = Math.round((new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000);
                if (sec > 0 && sec < 3600) {
                  total += sec;
                  count2++;
                  const m = Math.floor(sec / 60);
                  const s = sec % 60;
                  const num = o.displayNumber ?? o.guid?.slice(0, 8) ?? "?";
                  lines.push(`#${num}: ${m}:${String(s).padStart(2, "0")}`);
                }
              }
              const avg = count2 > 0 ? Math.round(total / count2) : 0;
              const avgM = Math.floor(avg / 60);
              const avgS = avg % 60;
              const status = avg <= 90 ? "ON TARGET" : `${avg - 90}s OVER`;
              let msg = `**Drive-Thru Speed Report**\n\n`;
              msg += `Average: **${avgM}:${String(avgS).padStart(2, "0")}** (target: 1:30) ${status}\n`;
              msg += `Completed: **${count2}** orders\n\n`;
              for (const line of lines.slice(-10)) {
                msg += `${line}\n`;
              }
              msg += `\n**Every order through in 1:30. That's the standard.**`;
              await send(msg);
            }
          }
          if (report === "eod" || report === "all") {
            const dateStr = todayDateStr(config.timezone);
            await send("Building end of day summary...");
            const summary = await buildDailySummary(mcp, dateStr, config.timezone);
            saveSummary(summary);
            await send(await endOfDaySummary(mcp, config.timezone, summary));
          }
        } catch (err) {
          await send(`Report error: ${(err as Error).message.slice(0, 200)}`);
        }
        return;
      }

      // Reset alerts: clear persisted alert state
      if (lower === "reset alerts") {
        resetAlertState();
        await send("**Alert state reset.** All seen orders cleared. Next poll will evaluate fresh.");
        return;
      }

      // Health
      if (/^health(check)?$/.test(lower)) {
        await send("Running health check...");
        const data = await mcp.callToolJson<Record<string, unknown>>("toast_healthcheck");
        if (!data) { await send(await mcp.callToolText("toast_healthcheck")); return; }
        const checks = data.checks as Record<string, { status: string; message: string; durationMs?: number }>;
        let reply = `**Health: ${data.overall}**\n\n`;
        if (checks) {
          for (const [name, check] of Object.entries(checks)) {
            reply += `${check.status === "pass" ? "Pass" : "FAIL"} **${name}**: ${check.message}\n`;
          }
        }
        await send(reply);
        return;
      }

      // Orders
      if (/^orders?/.test(lower)) {
        await send("Fetching today's orders...");
        const today = todayDateStr(config.timezone);
        const rawText = await mcp.callToolText("toast_list_orders", { businessDate: today });
        await send(rawText.slice(0, 3000));
        return;
      }

      // Menus
      if (/^menus?$/.test(lower)) {
        const rawText = await mcp.callToolText("toast_get_menu_metadata");
        await send(rawText.slice(0, 3000));
        return;
      }

      // Menu search
      const searchMatch = lower.match(/^(?:menu search|search)\s+(.+)/);
      if (searchMatch) {
        const query = searchMatch[1];
        await send(`Searching for "${query}"...`);
        const rawText = await mcp.callToolText("toast_search_menu_items", { query });
        await send(rawText.slice(0, 3000));
        return;
      }

      // Natural language fallback
      if (prompt) {
        // Use channel ID without message suffix as stable key
        const convKey = (activity.conversation?.id ?? "default").split(";")[0];
        const memory = getMemory(convKey);
        await memory.push({ role: "user" as const, content: text });
        const response = await prompt.send(text, { messages: memory });
        await memory.push(response);
        await send(response.content ?? "No response. Try a direct command.");
        return;
      }

      await send(`Command not recognized: "${text}". Type **help** for commands.`);
    } catch (err) {
      logToFile("CHANNEL_ERROR: " + (err as Error).message);
      await send(`Error: ${(err as Error).message.slice(0, 200)}`);
    }
  }
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
app.message(/^(help|\?)$/i, async ({ send, activity }) => {
  logToFile("HELP handler fired. convType=" + activity.conversation?.conversationType + " from=" + activity.from?.name);
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
    const today = todayDateStr(config.timezone);
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
  logToFile("FALLBACK: convType=" + activity.conversation?.conversationType + " raw=" + JSON.stringify(raw).slice(0, 150) + " stripped=" + text.slice(0, 80));

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
    const convKey = (activity.conversation?.id ?? "default").split(";")[0];
    const memory = getMemory(convKey);
    await memory.push({ role: "user" as const, content: text });

    const response = await prompt.send(text, { messages: memory });
    await memory.push(response);

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
app.start(config.port).then(() => {
  log("Toast Teams Bot v0.2.0 listening on port", config.port);
  log("AI:", config.openaiModel, "| Timezone:", config.timezone);
  log("MCP:", config.mcpServerUrl);

  // Start the scheduler for automated reports and real-time alerts
  startScheduler(app, mcp, config.timezone, config);
}).catch((err) => {
  log("Fatal:", err.message);
  process.exit(1);
});
