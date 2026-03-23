/**
 * Scheduler for automated reports, alerts, and proactive intelligence.
 * Uses node-cron to fire reports at configured times in Central Time.
 * Posts results to registered Teams channels via proactive messaging.
 * Manages historical cache and operational state lifecycle.
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
  getAllSummaries,
} from "../cache/history.js";
import {
  initOperationalState,
  getState,
  resetDaily,
  getCurrentHour,
  getCurrentTimeStr,
  getDayName,
  formatHourLabel,
  getBaselineForHour,
} from "../intelligence/stats.js";
import {
  formatHourlyPulse,
  formatShiftPerformance,
} from "../alerts/formatters.js";

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
    await app.send(channel.conversationId, {
      type: "message",
      text: message,
    });
    console.log(`[Scheduler] Sent report to #${channelName}`);
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

/** Build shift performance data from operational state. */
function buildShiftPerformanceMessage(
  tz: string,
  minOrders: number
): string | null {
  const st = getState();
  const servers: Array<{
    name: string;
    dtAvg: number;
    dtOrders: number;
    voids: number;
  }> = [];

  for (const [name, stats] of st.todayServerStats) {
    if (name === "Unknown") continue;
    if (stats.dtOrders < minOrders) continue;
    servers.push({
      name,
      dtAvg: Math.round(stats.dtTotalSeconds / stats.dtOrders),
      dtOrders: stats.dtOrders,
      voids: stats.totalVoids,
    });
  }

  if (servers.length === 0) return null;

  servers.sort((a, b) => a.dtAvg - b.dtAvg);

  const teamTotal = servers.reduce(
    (s, srv) => s + srv.dtAvg * srv.dtOrders,
    0
  );
  const teamOrders = servers.reduce((s, srv) => s + srv.dtOrders, 0);
  const teamAvg = teamOrders > 0 ? Math.round(teamTotal / teamOrders) : 90;

  return formatShiftPerformance(
    getCurrentTimeStr(tz),
    servers,
    teamAvg,
    90
  );
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

  // Initialize operational state with baselines from history
  const windowMinutes = config?.rollingWindowMinutes ?? 30;
  initOperationalState(getAllSummaries(), windowMinutes);

  const opts = { timezone };

  // --- 5:00 AM: Daily reset ---
  cron.schedule(
    "0 5 * * *",
    () => {
      resetDaily(getState());
    },
    opts
  );

  // --- 6:00 AM: Previous day sales summary → #finance ---
  cron.schedule(
    "0 6 * * *",
    async () => {
      const report = await dailySalesSummary(mcp, timezone);
      await sendToChannel(app, CHANNEL_NAMES.FINANCE, report);
    },
    opts
  );

  // --- 6:00 AM: Shift roster → #ops ---
  cron.schedule(
    "0 6 * * *",
    async () => {
      const report = await shiftRoster(mcp);
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // --- 7:00 AM: Marketplace breakdown → #marketplace ---
  cron.schedule(
    "0 7 * * *",
    async () => {
      const report = await marketplaceBreakdown(mcp, timezone);
      await sendToChannel(app, CHANNEL_NAMES.MARKETING, report);
    },
    opts
  );

  // --- Hourly Pulse (on the hour, 7 AM to 6 PM) → #ops ---
  cron.schedule(
    "0 7-18 * * *",
    async () => {
      try {
        const st = getState();
        const currentHour = getCurrentHour(timezone);
        const prevHour = currentHour - 1;
        const hourLabel = formatHourLabel(currentHour);

        const orders = st.todayOrdersByHour.get(prevHour) ?? 0;
        const sales = st.todaySalesByHour.get(prevHour) ?? 0;

        // DT stats for the previous hour
        const prevHourDt = st.todayDriveThruAll.filter((e) => {
          const h = parseInt(
            new Intl.DateTimeFormat("en-US", {
              timeZone: timezone,
              hour: "numeric",
              hour12: false,
            }).format(new Date(e.timestamp)),
            10
          );
          return h === prevHour;
        });
        const dtAvg =
          prevHourDt.length > 0
            ? prevHourDt.reduce((s, e) => s + e.seconds, 0) /
              prevHourDt.length
            : null;

        const baseline = getBaselineForHour(st, timezone, prevHour);
        const dayName = getDayName(timezone);
        const deviation = config?.hourlyPulseDeviation ?? 0.15;

        const msg = formatHourlyPulse(
          hourLabel,
          orders,
          sales,
          dtAvg,
          prevHourDt.length,
          baseline,
          dayName,
          deviation
        );

        if (msg) {
          await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, msg);
        }
      } catch (err) {
        console.log(
          "[Scheduler] Hourly pulse error:",
          (err as Error).message
        );
      }
    },
    opts
  );

  // --- 10:30 AM: Morning rush recap → #ops ---
  cron.schedule(
    "30 10 * * *",
    async () => {
      const report = await rushRecap(
        mcp,
        "Morning Rush Recap",
        6,
        10,
        timezone
      );
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // --- 11:00 AM and 3:00 PM: Shift performance → #ops ---
  cron.schedule(
    "0 11,15 * * *",
    async () => {
      try {
        const msg = buildShiftPerformanceMessage(
          timezone,
          config?.shiftPerfMinOrders ?? 5
        );
        if (msg) {
          await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, msg);
        }
      } catch (err) {
        console.log(
          "[Scheduler] Shift performance error:",
          (err as Error).message
        );
      }
    },
    opts
  );

  // --- 2:30 PM: Lunch rush recap → #ops ---
  cron.schedule(
    "30 14 * * *",
    async () => {
      const report = await rushRecap(
        mcp,
        "Lunch Rush Recap",
        11,
        14,
        timezone
      );
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, report);
    },
    opts
  );

  // --- 6:30 PM: Afternoon recap + Shift perf + EOD + save daily cache ---
  cron.schedule(
    "30 18 * * *",
    async () => {
      // Afternoon recap
      const afternoonReport = await rushRecap(
        mcp,
        "Afternoon Recap",
        14,
        18,
        timezone
      );
      await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, afternoonReport);

      // Shift performance (EOD)
      try {
        const shiftMsg = buildShiftPerformanceMessage(
          timezone,
          config?.shiftPerfMinOrders ?? 5
        );
        if (shiftMsg) {
          await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, shiftMsg);
        }
      } catch (err) {
        console.log(
          "[Scheduler] EOD shift perf error:",
          (err as Error).message
        );
      }

      // Build and save today's summary to the history cache
      try {
        const dateStr = todayInTz(timezone);
        console.log(
          `[Scheduler] Building daily summary for ${dateStr}...`
        );
        const summary = await buildDailySummary(mcp, dateStr, timezone);
        saveSummary(summary);

        // Rebuild baselines with new data
        initOperationalState(
          getAllSummaries(),
          config?.rollingWindowMinutes ?? 30
        );

        // End of Day Summary → #finance and #ops
        const eodReport = await endOfDaySummary(mcp, timezone, summary);
        await sendToChannel(app, CHANNEL_NAMES.FINANCE, eodReport);
        await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, eodReport);
      } catch (err) {
        console.log(
          `[Scheduler] EOD summary error: ${(err as Error).message}`
        );
      }
    },
    opts
  );

  // --- Every 5 minutes: check for 86'd items → #ops ---
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

  // --- Every 2 minutes: real-time alert polling + intelligence ---
  if (config) {
    cron.schedule(
      "*/2 * * * *",
      async () => {
        try {
          const alerts = await pollAlerts(mcp, config);

          // Existing alerts → #ops
          for (const msg of alerts.largeOrders) {
            await sendToChannel(app, CHANNEL_NAMES.OPS_CONTROL, msg);
          }
          if (alerts.voidAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.voidAlert
            );
          }
          if (alerts.longOpenAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.longOpenAlert
            );
          }
          if (alerts.driveThruAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.driveThruAlert
            );
          }

          // Intelligence alerts
          if (alerts.dtIntelAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.dtIntelAlert
            );
          }
          if (alerts.slowPeriodAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.slowPeriodAlert
            );
          }
          for (const msg of alerts.platformDroughtAlerts) {
            await sendToChannel(app, CHANNEL_NAMES.MARKETING, msg);
          }
          if (alerts.revenuePacingAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.FINANCE,
              alerts.revenuePacingAlert
            );
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.revenuePacingAlert
            );
          }
          if (alerts.voidClusterAlert) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.voidClusterAlert
            );
          }
          if (alerts.rushTransition) {
            await sendToChannel(
              app,
              CHANNEL_NAMES.OPS_CONTROL,
              alerts.rushTransition
            );
          }
        } catch (err) {
          console.log("[Alerts] Poll cycle error:", (err as Error).message);
        }
      },
      opts
    );
  }

  console.log("[Scheduler] All jobs registered:");
  console.log("  5:00 AM  Daily reset (clear state)");
  console.log("  6:00 AM  Daily sales summary → #finance");
  console.log("  6:00 AM  Shift roster → #ops");
  console.log("  7:00 AM  Marketplace breakdown → #marketplace");
  console.log("  Hourly   Pulse (7 AM to 6 PM, deviation > 15%) → #ops");
  console.log("  10:30 AM Morning rush recap → #ops");
  console.log("  11:00 AM Shift performance → #ops");
  console.log("  2:30 PM  Lunch rush recap → #ops");
  console.log("  3:00 PM  Shift performance → #ops");
  console.log(
    "  6:30 PM  Afternoon recap + Shift perf + EOD Summary → #ops + #finance"
  );
  console.log("  Every 5m 86'd item check → #ops");
  if (config) {
    console.log(
      "  Every 2m Alert polling + intelligence (DT, slow, drought, pacing, voids, rush) → #ops/#finance/#marketplace"
    );
  }
}
