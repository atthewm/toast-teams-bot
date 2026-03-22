/**
 * Scheduler for automated reports and alerts.
 * Uses node-cron to fire reports at configured times in Central Time.
 * Posts results to registered Teams channels via proactive messaging.
 */

import cron from "node-cron";
import type { App } from "@microsoft/teams.apps";
import type { ToastMcpClient } from "../mcp/client.js";
import { getChannel, CHANNEL_NAMES } from "../proactive/store.js";
import {
  dailySalesSummary,
  marketplaceBreakdown,
  rushRecap,
  shiftRoster,
  check86d,
} from "../reports/index.js";

// Track 86'd items across polls
let previous86d = new Set<string>();

async function sendToChannel(
  app: App,
  channelName: string,
  message: string
): Promise<void> {
  const channel = getChannel(channelName);
  if (!channel) {
    console.error(
      `[Scheduler] Channel "${channelName}" not registered. Run "register ${channelName}" in that channel.`
    );
    return;
  }

  try {
    await app.send(channel.conversationId, { type: "message", text: message });
    console.error(
      `[Scheduler] Sent report to #${channelName}`
    );
  } catch (err) {
    console.error(
      `[Scheduler] Failed to send to #${channelName}: ${(err as Error).message}`
    );
  }
}

export function startScheduler(
  app: App,
  mcp: ToastMcpClient,
  timezone: string
): void {
  console.error(`[Scheduler] Starting with timezone: ${timezone}`);

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

  // 6:00 AM: Shift roster → #ops-control
  cron.schedule(
    "0 6 * * *",
    async () => {
      const report = await shiftRoster(mcp);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 7:00 AM: Marketplace breakdown → #marketing
  cron.schedule(
    "0 7 * * *",
    async () => {
      const report = await marketplaceBreakdown(mcp);
      await sendToChannel(app, CHANNEL_NAMES.MARKETING, report);
    },
    opts
  );

  // 10:30 AM: Morning rush recap → #ops-control
  cron.schedule(
    "30 10 * * *",
    async () => {
      const report = await rushRecap(mcp, "Morning Rush Recap", 6, 10);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 2:30 PM: Lunch rush recap → #ops-control
  cron.schedule(
    "30 14 * * *",
    async () => {
      const report = await rushRecap(mcp, "Lunch Rush Recap", 11, 14);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // 6:30 PM: Afternoon recap → #ops-control
  cron.schedule(
    "30 18 * * *",
    async () => {
      const report = await rushRecap(mcp, "Afternoon Recap", 14, 18);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // Every 5 minutes: check for 86'd items → #ops-control
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

  console.error("[Scheduler] All jobs registered:");
  console.error("  6:00 AM  Daily sales summary → #finance");
  console.error("  6:00 AM  Shift roster → #ops-control");
  console.error("  7:00 AM  Marketplace breakdown → #marketing");
  console.error("  10:30 AM Morning rush recap → #ops-control");
  console.error("  2:30 PM  Lunch rush recap → #ops-control");
  console.error("  6:30 PM  Afternoon recap → #ops-control");
  console.error("  Every 5m 86'd item check → #ops-control");
}
