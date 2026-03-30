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
import {
  getState,
  getCurrentHour,
  getCurrentDow,
  getDayName,
  formatSeconds,
  formatHourLabel,
  windowAverage,
  windowCount,
  getCurrentBaseline,
  getCurrentTimeStr,
  getBaselineForHour,
} from "./intelligence/stats.js";
import {
  formatHourlyPulse,
  formatShiftPerformance,
} from "./alerts/formatters.js";
import { sendCard } from "./cards/send.js";
import {
  helpCard,
  healthCard,
  menusCard,
  menuSearchCard,
  ordersCard,
  configCard,
  statusCard,
  capabilitiesCard,
  channelRegisteredCard,
  channelsListCard,
  simpleMessageCard,
  reportCard,
  driveThruCard,
  errorCard,
} from "./cards/templates.js";

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

// -- Help sections for the helpCard --
const HELP_SECTIONS = [
  {
    heading: "Commands",
    commands: [
      { name: "health", description: "System health check" },
      { name: "menus", description: "Menu overview" },
      { name: "menu search [term]", description: "Search menu items" },
      { name: "orders", description: "Today's orders" },
      { name: "config", description: "Restaurant configuration" },
      { name: "status", description: "Authentication status" },
      { name: "capabilities", description: "Available API features" },
    ],
  },
  {
    heading: "Reports",
    commands: [
      { name: "test sales", description: "Yesterday's sales summary" },
      { name: "test marketplace", description: "Platform breakdown" },
      { name: "test morning/lunch/afternoon", description: "Rush recaps" },
      { name: "test alerts", description: "Check for active alerts" },
      { name: "test drivethru", description: "Drive thru speed report" },
      { name: "test eod", description: "End of day summary with comparisons" },
      { name: "test baselines", description: "Hourly baselines for today" },
      { name: "test pulse", description: "Hourly pulse for current hour" },
      { name: "test shift", description: "Server performance breakdown" },
      { name: "test stats", description: "Operational state dump" },
      { name: "test rush", description: "Rush detection status" },
      { name: "test all", description: "Run all reports" },
      { name: "reset alerts", description: "Clear alert state" },
    ],
  },
  {
    heading: "Admin",
    commands: [
      { name: "register [channel]", description: "Register this channel for reports" },
      { name: "channels", description: "List registered channels" },
      { name: "unregister [channel]", description: "Remove a channel registration" },
    ],
  },
];

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
        await sendCard(send, helpCard("Toast Operations Bot", HELP_SECTIONS));
        return;
      }

      // Register
      const registerMatch = lower.match(/^register\s+(\S+)$/);
      if (registerMatch) {
        const channelName = registerMatch[1];
        const conversationId = activity.conversation?.id ?? "";
        const serviceUrl = String((activity as unknown as Record<string, unknown>).serviceUrl ?? "");
        const userName = activity.from?.name ?? "unknown";
        if (!conversationId) { await sendCard(send, errorCard("Registration Failed", "Could not detect conversation ID.")); return; }
        const reg = registerChannel(channelName, conversationId, serviceUrl, userName);
        await sendCard(send, channelRegisteredCard(reg));
        return;
      }

      // Channels
      if (lower === "channels") {
        const channels = getAllChannels();
        const entries = Object.entries(channels);
        await sendCard(send, channelsListCard(entries));
        return;
      }

      // Test reports: run a specific report and post the result here
      const testMatch = lower.match(/^test\s+(sales|marketplace|morning|lunch|afternoon|roster|alerts|drive-?thru|eod|baselines?|pulse|shift|stats|rush|all)$/);
      if (testMatch) {
        const report = testMatch[1].replace("-", "");
        await sendCard(send, simpleMessageCard("Running Report", `Generating ${report} report...`));
        try {
          if (report === "sales" || report === "all") {
            await sendCard(send, reportCard("Daily Sales Summary", await dailySalesSummary(mcp, config.timezone)));
          }
          if (report === "marketplace" || report === "all") {
            await sendCard(send, reportCard("Marketplace Breakdown", await marketplaceBreakdown(mcp, config.timezone)));
          }
          if (report === "morning" || report === "all") {
            await sendCard(send, reportCard("Morning Rush Recap", await rushRecap(mcp, "Morning Rush Recap", 6, 10, config.timezone)));
          }
          if (report === "lunch" || report === "all") {
            await sendCard(send, reportCard("Lunch Rush Recap", await rushRecap(mcp, "Lunch Rush Recap", 11, 14, config.timezone)));
          }
          if (report === "afternoon" || report === "all") {
            await sendCard(send, reportCard("Afternoon Recap", await rushRecap(mcp, "Afternoon Recap", 14, 18, config.timezone)));
          }
          if (report === "roster" || report === "all") {
            await sendCard(send, reportCard("Shift Roster", await shiftRoster(mcp)));
          }
          if (report === "alerts" || report === "all") {
            const alerts = await pollAlerts(mcp, config);
            const alertCount = alerts.largeOrders.length +
              (alerts.voidAlert ? 1 : 0) +
              (alerts.longOpenAlert ? 1 : 0) +
              (alerts.driveThruAlert ? 1 : 0);
            if (alertCount === 0) {
              await sendCard(send, simpleMessageCard("Alert Check", "No active alerts right now.", "Good"));
            } else {
              for (const alertMsg of alerts.largeOrders) await sendCard(send, reportCard("Alert", alertMsg));
              if (alerts.voidAlert) await sendCard(send, reportCard("Void Alert", alerts.voidAlert));
              if (alerts.longOpenAlert) await sendCard(send, reportCard("Long Open Alert", alerts.longOpenAlert));
              if (alerts.driveThruAlert) await sendCard(send, reportCard("Drive Thru Alert", alerts.driveThruAlert));
            }
          }
          if (report === "drivethru" || report === "all") {
            const dateStr = todayDateStr(config.timezone);
            const raw = await mcp.callToolText("toast_list_orders", { businessDate: dateStr, fetchAll: true });
            let dtData: { orders?: Array<{ diningOptionName?: string; openedDate?: string; closedDate?: string; voided?: boolean; displayNumber?: string; guid?: string }> } | null = null;
            try { dtData = JSON.parse(raw); } catch { /* text */ }
            const DT = ["drive thru", "drive-thru", "drivethru", "drive through"];
            const dtOrders = (dtData?.orders ?? []).filter((o) => {
              if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
              return DT.some((n) => o.diningOptionName!.toLowerCase().includes(n));
            });
            if (dtOrders.length === 0) {
              await sendCard(send, simpleMessageCard("Drive Thru Speed", "No completed drive thru orders today."));
            } else {
              let dtTotal = 0;
              let dtCount = 0;
              const recentOrders: Array<{ label: string; time: string }> = [];
              for (const o of dtOrders) {
                const sec = Math.round((new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000);
                if (sec > 0 && sec < 3600) {
                  dtTotal += sec;
                  dtCount++;
                  const m = Math.floor(sec / 60);
                  const s = sec % 60;
                  const num = o.displayNumber ?? o.guid?.slice(0, 8) ?? "?";
                  recentOrders.push({ label: `#${num}`, time: `${m}:${String(s).padStart(2, "0")}` });
                }
              }
              const avg = dtCount > 0 ? Math.round(dtTotal / dtCount) : 0;
              const avgM = Math.floor(avg / 60);
              const avgS = avg % 60;
              const onTarget = avg <= 150;
              const statusText = onTarget ? "ON TARGET" : `${avg - 150}s OVER`;
              await sendCard(send, driveThruCard({
                avgMinutes: avgM,
                avgSeconds: avgS,
                completedCount: dtCount,
                target: "2:30",
                statusText,
                onTarget,
                recentOrders: recentOrders.slice(-10),
              }));
            }
          }
          if (report === "eod" || report === "all") {
            const dateStr = todayDateStr(config.timezone);
            await sendCard(send, simpleMessageCard("End of Day", "Building end of day summary..."));
            const summary = await buildDailySummary(mcp, dateStr, config.timezone);
            saveSummary(summary);
            await sendCard(send, reportCard("End of Day Summary", await endOfDaySummary(mcp, config.timezone, summary)));
          }
          if (report === "baselines" || report === "baseline") {
            const st = getState();
            const dow = getCurrentDow(config.timezone);
            const dayName = getDayName(config.timezone);
            let baselineBody = "";
            let hasData = false;
            for (let h = 5; h <= 18; h++) {
              const b = st.hourlyBaselines.get(`${dow}:${h}`);
              if (!b) continue;
              hasData = true;
              const hLabel = formatHourLabel(h);
              baselineBody += `${hLabel}: ${b.avgOrders.toFixed(1)} orders, $${b.avgSales.toFixed(0)}`;
              if (b.avgDriveThruSeconds > 0) baselineBody += `, DT ${formatSeconds(b.avgDriveThruSeconds)}`;
              baselineBody += ` (${b.sampleCount} samples)\n`;
            }
            if (!hasData) {
              baselineBody = "No baseline data available. Baselines build from 14 days of history.";
            }
            await sendCard(send, reportCard(`Baselines for ${dayName}`, baselineBody));
          }
          if (report === "pulse") {
            const st = getState();
            const hour = getCurrentHour(config.timezone);
            const prevHour = hour - 1;
            const hourLabel = formatHourLabel(hour);
            const pulseOrders = st.todayOrdersByHour.get(prevHour) ?? 0;
            const pulseSales = st.todaySalesByHour.get(prevHour) ?? 0;
            const prevHourDt = st.todayDriveThruAll.filter((e) => {
              const eH = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, hour: "numeric", hour12: false }).format(new Date(e.timestamp)), 10);
              return eH === prevHour;
            });
            const dtAvg = prevHourDt.length > 0 ? prevHourDt.reduce((s, e) => s + e.seconds, 0) / prevHourDt.length : null;
            const baseline = getBaselineForHour(st, config.timezone, prevHour);
            const dayName = getDayName(config.timezone);
            const pulseMsg = formatHourlyPulse(hourLabel, pulseOrders, pulseSales, dtAvg, prevHourDt.length, baseline, dayName, config.hourlyPulseDeviation);
            await sendCard(send, reportCard(`${hourLabel} Pulse`, pulseMsg ?? "Everything tracking normal. No deviations to report."));
          }
          if (report === "shift") {
            const st = getState();
            const servers: Array<{ name: string; dtAvg: number; dtOrders: number; voids: number }> = [];
            for (const [name, stats] of st.todayServerStats) {
              if (name === "Unknown") continue;
              if (stats.dtOrders < config.shiftPerfMinOrders) continue;
              servers.push({
                name,
                dtAvg: Math.round(stats.dtTotalSeconds / stats.dtOrders),
                dtOrders: stats.dtOrders,
                voids: stats.totalVoids,
              });
            }
            if (servers.length === 0) {
              await sendCard(send, simpleMessageCard("Shift Performance", `No servers with enough drive thru orders yet. Need ${config.shiftPerfMinOrders}+ DT orders per server.`));
            } else {
              servers.sort((a, b) => a.dtAvg - b.dtAvg);
              const teamTotal = servers.reduce((s, srv) => s + srv.dtAvg * srv.dtOrders, 0);
              const teamOrders = servers.reduce((s, srv) => s + srv.dtOrders, 0);
              const teamAvg = teamOrders > 0 ? Math.round(teamTotal / teamOrders) : 150;
              await sendCard(send, reportCard("Shift Performance", formatShiftPerformance(getCurrentTimeStr(config.timezone), servers, teamAvg, 150)));
            }
          }
          if (report === "stats") {
            const st = getState();
            const statsDtAvg = windowAverage(st.driveThruTimes);
            let statsBody = `Orders today: ${st.todayOrderCount}, Sales: $${st.todaySales.toFixed(2)}\n`;
            statsBody += `DT orders today: ${st.todayDriveThruAll.length}\n`;
            statsBody += `Rolling window (30 min): ${windowCount(st.orderVolume)} orders, `;
            statsBody += `DT avg: ${statsDtAvg ? formatSeconds(Math.round(statsDtAvg)) : "N/A"} (${windowCount(st.driveThruTimes)} DT orders)\n`;
            statsBody += `In rush: ${st.inRush ? "Yes" : "No"}\n`;
            statsBody += `Platforms today: ${Array.from(st.todayPlatformOrders.entries()).map(([p, s]) => `${p}: ${s.count}`).join(", ") || "none"}\n`;
            statsBody += `Baseline slots: ${st.hourlyBaselines.size}\n`;
            statsBody += `Active cooldowns: ${st.lastAlertTimes.size}`;
            await sendCard(send, reportCard("Operational State", statsBody));
          }
          if (report === "rush") {
            const st = getState();
            if (st.inRush) {
              const duration = Date.now() - (st.rushStartTime ?? 0);
              const mins = Math.round(duration / 60000);
              await sendCard(send, reportCard("Rush Active", `Started ${mins} min ago. Peak rate: ${st.rushPeakRate} per 15 min. Orders since rush start: ${st.todayOrderCount - st.rushStartOrders}.`));
            } else {
              const rushBaseline = getCurrentBaseline(st, config.timezone);
              const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
              const recent = st.orderVolume.entries.filter((e) => e.timestamp >= fifteenMinAgo).length;
              const baseRate = rushBaseline ? (rushBaseline.avgOrders / 4).toFixed(1) : "N/A";
              await sendCard(send, reportCard("No Rush Active", `Current 15 min rate: ${recent} orders. Baseline: ${baseRate} per 15 min.`));
            }
          }
        } catch (err) {
          await sendCard(send, errorCard("Report Error", (err as Error).message.slice(0, 200)));
        }
        return;
      }

      // Control Tower: run all rules on demand and post to this channel
      if (lower === "test tower" || lower === "test control tower" || lower === "test control-tower") {
        await sendCard(send, simpleMessageCard("Control Tower", "Running all control tower rules..."));
        try {
          const { runControlTowerNow } = await import("./control-tower/scheduler.js");
          const results = await runControlTowerNow();
          if (results.length === 0) {
            await sendCard(send, simpleMessageCard("Control Tower", "All rules evaluated. No alerts fired.", "Good"));
          } else {
            for (const msg of results) {
              await send(msg);
            }
          }
        } catch (err) {
          await sendCard(send, errorCard("Control Tower Error", (err as Error).message.slice(0, 300)));
        }
        return;
      }

      // Reset alerts: clear persisted alert state
      if (lower === "reset alerts") {
        resetAlertState();
        await sendCard(send, simpleMessageCard("Alert State Reset", "All seen orders cleared. Next poll will evaluate fresh.", "Good"));
        return;
      }

      // Health
      if (/^health(check)?$/.test(lower)) {
        await sendCard(send, simpleMessageCard("Health Check", "Running health check..."));
        const hcData = await mcp.callToolJson<Record<string, unknown>>("toast_healthcheck");
        if (!hcData) { await send(await mcp.callToolText("toast_healthcheck")); return; }
        await sendCard(send, healthCard(hcData));
        return;
      }

      // Orders
      if (/^orders?/.test(lower)) {
        await sendCard(send, simpleMessageCard("Orders", "Fetching today's orders..."));
        const today = todayDateStr(config.timezone);
        const rawText = await mcp.callToolText("toast_list_orders", { businessDate: today });
        let orderData: {
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
        try { orderData = JSON.parse(rawText); } catch { /* plain text */ }
        if (!orderData || !orderData.orders) {
          await sendCard(send, simpleMessageCard("Orders", "No orders found for today."));
        } else {
          await sendCard(send, ordersCard(orderData, today));
        }
        return;
      }

      // Menus
      if (/^menus?$/.test(lower)) {
        const menuRaw = await mcp.callToolText("toast_get_menu_metadata");
        let menuData: { menuCount: number; menus: Array<{ guid: string; name: string; groupCount: number }> } | null = null;
        try { menuData = JSON.parse(menuRaw); } catch { /* plain text */ }
        if (!menuData || !menuData.menus) {
          await send(menuRaw.slice(0, 3000));
        } else {
          await sendCard(send, menusCard(menuData));
        }
        return;
      }

      // Menu search
      const searchMatch = lower.match(/^(?:menu search|search)\s+(.+)/);
      if (searchMatch) {
        const query = searchMatch[1];
        await sendCard(send, simpleMessageCard("Menu Search", `Searching for "${query}"...`));
        const searchRaw = await mcp.callToolText("toast_search_menu_items", { query });
        let searchData: { results?: Array<{ item: { name: string; price?: number }; menuName: string; groupName: string }> } | null = null;
        try { searchData = JSON.parse(searchRaw); } catch { /* plain text */ }
        if (!searchData || !searchData.results || searchData.results.length === 0) {
          await sendCard(send, simpleMessageCard("Menu Search", `No items found matching "${query}".`));
        } else {
          await sendCard(send, menuSearchCard(query, searchData.results));
        }
        return;
      }

      // Natural language fallback (keep as plain text since LLM formats its own response)
      if (prompt) {
        const convKey = (activity.conversation?.id ?? "default").split(";")[0];
        const memory = getMemory(convKey);
        await memory.push({ role: "user" as const, content: text });
        const response = await prompt.send(text, { messages: memory });
        await memory.push(response);
        await send(response.content ?? "No response. Try a direct command.");
        return;
      }

      await sendCard(send, simpleMessageCard("Unknown Command", `Command not recognized: "${text}". Type help for commands.`));
    } catch (err) {
      logToFile("CHANNEL_ERROR: " + (err as Error).message);
      await sendCard(send, errorCard("Error", (err as Error).message.slice(0, 200)));
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
  await sendCard(send, helpCard("Toast Operations Bot", HELP_SECTIONS));
});

// ---- Command: health ----
app.message(/^health(check)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "health")) { await send(denyMessage("health")); return; }

  await sendCard(send, simpleMessageCard("Health Check", "Running health check..."));
  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_healthcheck");
    if (!data) { await send(await mcp.callToolText("toast_healthcheck")); return; }
    await sendCard(send, healthCard(data));
  } catch (err) {
    await sendCard(send, errorCard("Health Check Failed", (err as Error).message));
  }
});

// ---- Command: menu search ----
app.message(/^(menu search|search menu)\s+(.+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "search")) { await send(denyMessage("search")); return; }

  const match = activity.text?.match(/(menu search|search menu)\s+(.+)/i);
  const query = match?.[2]?.trim() ?? "";
  if (!query) {
    await sendCard(send, simpleMessageCard("Menu Search", "Please provide a search term. Example: menu search espresso"));
    return;
  }

  await sendCard(send, simpleMessageCard("Menu Search", `Searching for "${query}"...`));
  try {
    const rawText = await mcp.callToolText("toast_search_menu_items", { query });
    let data: { results?: Array<{ item: { name: string; price?: number }; menuName: string; groupName: string }> } | null = null;
    try { data = JSON.parse(rawText); } catch { /* plain text */ }

    if (!data || !data.results || data.results.length === 0) {
      await sendCard(send, simpleMessageCard("Menu Search", `No items found matching "${query}".`));
      return;
    }

    await sendCard(send, menuSearchCard(query, data.results));
  } catch (err) {
    await sendCard(send, errorCard("Menu Search Failed", (err as Error).message));
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

    await sendCard(send, menusCard(data));
  } catch (err) {
    await sendCard(send, errorCard("Menus Failed", (err as Error).message));
  }
});

// ---- Command: orders ----
app.message(/^orders?(\s+today)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "orders")) { await send(denyMessage("orders")); return; }

  await sendCard(send, simpleMessageCard("Orders", "Fetching today's orders..."));
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
      await sendCard(send, simpleMessageCard("Orders", "No orders found for today."));
      return;
    }

    await sendCard(send, ordersCard(data, today));
  } catch (err) {
    await sendCard(send, errorCard("Orders Failed", (err as Error).message));
  }
});

// ---- Command: config ----
app.message(/^config(uration)?$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "config")) { await send(denyMessage("config")); return; }

  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_get_config_summary");
    if (!data) { await send(await mcp.callToolText("toast_get_config_summary")); return; }
    await sendCard(send, configCard(data));
  } catch (err) {
    await sendCard(send, errorCard("Config Failed", (err as Error).message));
  }
});

// ---- Command: status ----
app.message(/^(status|auth)$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "status")) { await send(denyMessage("status")); return; }

  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_auth_status");
    if (!data) { await send(await mcp.callToolText("toast_auth_status")); return; }
    await sendCard(send, statusCard(data));
  } catch (err) {
    await sendCard(send, errorCard("Status Check Failed", (err as Error).message));
  }
});

// ---- Command: capabilities ----
app.message(/^capabilities$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "capabilities")) { await send(denyMessage("capabilities")); return; }

  try {
    const data = await mcp.callToolJson<Record<string, unknown>>("toast_api_capabilities");
    await sendCard(send, capabilitiesCard(data ?? {}));
  } catch (err) {
    await sendCard(send, errorCard("Capabilities Failed", (err as Error).message));
  }
});

// ---- Command: register [channel-name] ----
app.message(/^register\s+(\S+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("register")); return; }

  const match = activity.text?.match(/register\s+(\S+)/i);
  const channelName = match?.[1]?.toLowerCase();
  if (!channelName) {
    await sendCard(send, simpleMessageCard("Register", "Usage: register [channel name]\n\nExamples: register ops, register finance, register marketing"));
    return;
  }

  const conversationId = activity.conversation?.id ?? "";
  const serviceUrl = (activity as unknown as Record<string, unknown>).serviceUrl as string ?? "";
  const teamId = activity.conversation?.tenantId ?? "";
  const userName = activity.from?.name ?? activity.from?.id ?? "unknown";

  if (!conversationId) {
    await sendCard(send, errorCard("Registration Failed", "Could not detect conversation ID. Make sure you run this in a Teams channel."));
    return;
  }

  const reg = registerChannel(channelName, conversationId, serviceUrl, userName, teamId);
  await sendCard(send, channelRegisteredCard(reg));
});

// ---- Command: channels ----
app.message(/^channels$/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("channels")); return; }

  const channels = getAllChannels();
  const entries = Object.entries(channels);
  await sendCard(send, channelsListCard(entries));
});

// ---- Command: unregister [channel-name] ----
app.message(/^unregister\s+(\S+)/i, async ({ send, activity }) => {
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "register")) { await send(denyMessage("unregister")); return; }

  const match = activity.text?.match(/unregister\s+(\S+)/i);
  const channelName = match?.[1]?.toLowerCase();
  if (!channelName) {
    await sendCard(send, simpleMessageCard("Unregister", "Usage: unregister [channel name]"));
    return;
  }

  if (removeChannel(channelName)) {
    await sendCard(send, simpleMessageCard("Channel Unregistered", `Channel ${channelName} unregistered. It will no longer receive reports.`, "Good"));
  } else {
    await sendCard(send, simpleMessageCard("Not Found", `Channel ${channelName} was not registered.`, "Warning"));
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
    await sendCard(send, simpleMessageCard("Toast Ops", "Type help to see commands, or ask me anything."));
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
      await sendCard(send, errorCard("Registration Failed", "Could not detect conversation ID. Make sure you run this in a Teams channel."));
      return;
    }

    const reg = registerChannel(channelName, conversationId, serviceUrl, userName, teamId);
    await sendCard(send, channelRegisteredCard(reg));
    return;
  }

  // ---- channels (fallback) ----
  if (lower === "channels") {
    const role = await getUserRole(activity.from?.id ?? "");
    if (!hasPermission(role, "register")) { await send(denyMessage("channels")); return; }

    const channels = getAllChannels();
    const entries = Object.entries(channels);
    await sendCard(send, channelsListCard(entries));
    return;
  }

  // ---- unregister [channel-name] (fallback) ----
  const unregisterMatch = lower.match(/^unregister\s+(\S+)$/);
  if (unregisterMatch) {
    const role = await getUserRole(activity.from?.id ?? "");
    if (!hasPermission(role, "register")) { await send(denyMessage("unregister")); return; }

    const channelName = unregisterMatch[1];
    if (removeChannel(channelName)) {
      await sendCard(send, simpleMessageCard("Channel Unregistered", `Channel ${channelName} unregistered. It will no longer receive reports.`, "Good"));
    } else {
      await sendCard(send, simpleMessageCard("Not Found", `Channel ${channelName} was not registered.`, "Warning"));
    }
    return;
  }

  // ---- Natural language: route through ChatPrompt + OpenAI + MCP ----
  // Keep AI responses as plain text since the LLM formats its own response
  const role = await getUserRole(activity.from?.id ?? "");
  if (!hasPermission(role, "ai")) {
    await sendCard(send, simpleMessageCard("Permission Denied", "You don't have permission to use the AI assistant. Type help for available commands.", "Attention"));
    return;
  }

  if (!prompt) {
    await sendCard(send, simpleMessageCard("AI Unavailable", "AI mode is not available (initialization failed). Use direct commands instead. Type help."));
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

    // AI responses stay as plain text since the LLM formats its own markdown
    await send(reply);
  } catch (err) {
    const errMsg = (err as Error).message;
    log("AI error:", errMsg);

    if (errMsg.includes("401") || errMsg.includes("auth")) {
      await sendCard(send, errorCard("AI Authentication Error", "Check the OPENAI_API_KEY configuration."));
    } else if (errMsg.includes("429") || errMsg.includes("rate")) {
      await sendCard(send, errorCard("AI Rate Limited", "Try again in a moment, or use a direct command."));
    } else {
      await sendCard(send, errorCard("AI Error", `${errMsg.slice(0, 200)}\n\nTry using a direct command instead (type help).`));
    }
  }
});

// ---- Start ----
app.start(config.port).then(() => {
  log("Toast Teams Bot v0.2.0 listening on port", config.port);
  log("AI:", config.openaiModel, "| Timezone:", config.timezone);
  log("MCP:", config.mcpServerUrl);

  startScheduler(app, mcp, config.timezone, config);
  console.log("[Bot] Scheduler started. Reports and alerts active.");
}).catch((err) => {
  log("Fatal:", err.message);
  process.exit(1);
});
