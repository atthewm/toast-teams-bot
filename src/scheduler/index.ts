/**
 * Scheduler for automated reports and alerts.
 * Uses node-cron to fire reports at configured times in Central Time.
 * Posts results to registered Teams channels via proactive messaging.
 * Manages historical cache: loads on boot, saves daily summary at close.
 */

import cron from "node-cron";
import type { App } from "@microsoft/teams.apps";
import type { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import { getChannel, CHANNEL_NAMES } from "../proactive/store.js";
import {
  dailySalesSummary,
  marketplaceBreakdown,
  rushRecap,
  shiftRoster,
  check86d,
  endOfDaySummary,
} from "../reports/index.js";
import { pollAlerts } from "../alerts/monitor.js";
import {
  loadHistory,
  buildDailySummary,
  saveSummary,
} from "../cache/history.js";

// Track 86'd items across polls
let previous86d = new Set<string>();

async function sendToChannel(
  app: App,
  channelName: string,
  message: string
): Promise<void> {
  const channel = getChannel(channelName);
  if (!channel) {
    console.log(
      `[Scheduler] Channel "${channelName}" not registered. Run "register ${channelName}" in that channel.`
    );
    return;
  }

  try {
    await app.send(channel.conversationId, { type: "message", text: message });
    console.log(
      `[Scheduler] Sent report to #${channelName}`
    );
  } catch (err) {
    console.log(
      `[Scheduler] Failed to send to #${channelName}: ${(err as Error).message}`
    );
  }
}

/** Get today's date string in the configured timezone. */
function todayInTz(tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}${m}${d}`;
}

export function startScheduler(
  app: App,
  mcp: ToastMcpClient,
  timezone: string,
  config?: BotConfig
): void {
  console.log(`[Scheduler] Starting with timezone: ${timezone}`);

  // Load historical cache into memory on boot
  loadHistory();

  const opts = { timezone };

  // 6:00 AM: Previous day sales summary → #finance
  cron.schedule(
    "0 6 * * *",
    async () => {
      const report = await dailySalesSummary(mcp);
      await sendToChannel(app, CHANNEL_NAMES.FINANCE, report);
    },
    opts
  );

  // 6:00 AM: Shift roster → #ops
  cron.schedule(
    "0 6 * * *",
    async () => {
      const report = await shiftRoster(mcp);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 7:00 AM: Marketplace breakdown → #marketplace
  cron.schedule(
    "0 7 * * *",
    async () => {
      const report = await marketplaceBreakdown(mcp);
      await sendToChannel(app, CHANNEL_NAMES.MARKETING, report);
    },
    opts
  );

  // 10:30 AM: Morning rush recap → #ops
  cron.schedule(
    "30 10 * * *",
    async () => {
      const report = await rushRecap(mcp, "Morning Rush Recap", 6, 10, timezone);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 2:30 PM: Lunch rush recap → #ops
  cron.schedule(
    "30 14 * * *",
    async () => {
      const report = await rushRecap(mcp, "Lunch Rush Recap", 11, 14, timezone);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 6:30 PM: Afternoon recap + End of Day Summary + save daily cache
  cron.schedule(
    "30 18 * * *",
    async () => {
      // Afternoon recap
      const afternoonReport = await rushRecap(mcp, "Afternoon Recap", 14, 18, timezone);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, afternoonReport);

      // Build and save today's summary to the history cache
      try {
        const dateStr = todayInTz(timezone);
        console.log(`[Scheduler] Building daily summary for ${dateStr}...`);
        const summary = await buildDailySummary(mcp, dateStr, timezone);
        saveSummary(summary);

        // End of Day Summary → #finance and #ops
        const eodReport = await endOfDaySummary(mcp, timezone, summary);
        await sendToChannel(app, CHANNEL_NAMES.FINANCE, eodReport);
        await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, eodReport);
      } catch (err) {
        console.log(`[Scheduler] EOD summary error: ${(err as Error).message}`);
      }
    },
    opts
  );

  // Every 5 minutes: check for 86'd items → #ops
  cron.schedule(
    "*/5 * * * *",
    async () => {
      const result = await check86d(mcp, previous86d);
      previous86d = result.current86d;
      if (result.message) {
        await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, result.message);
      }
    },
    opts
  );

  // Every 2 minutes: real-time alert polling (large orders, voids, long open, drive-thru speed)
  if (config) {
    cron.schedule(
      "*/2 * * * *",
      async () => {
        try {
          const alerts = await pollAlerts(mcp, config);

          for (const msg of alerts.largeOrders) {
            await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, msg);
          }
          if (alerts.voidAlert) {
            await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, alerts.voidAlert);
          }
          if (alerts.longOpenAlert) {
            await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, alerts.longOpenAlert);
          }
          if (alerts.driveThruAlert) {
            await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, alerts.driveThruAlert);
          }
        } catch (err) {
          console.log("[Alerts] Poll cycle error:", (err as Error).message);
        }
      },
      opts
    );
  }

  console.log("[Scheduler] All jobs registered:");
  console.log("  6:00 AM  Daily sales summary → #finance");
  console.log("  6:00 AM  Shift roster → #ops");
  console.log("  7:00 AM  Marketplace breakdown → #marketplace");
  console.log("  10:30 AM Morning rush recap → #ops");
  console.log("  2:30 PM  Lunch rush recap → #ops");
  console.log("  6:30 PM  Afternoon recap + End of Day Summary → #ops + #finance");
  console.log("  Every 5m 86'd item check → #ops");
  if (config) {
    console.log("  Every 2m Alert polling (large orders, voids, long open, drive-thru) → #ops");
  }
}
