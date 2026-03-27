/**
 * Control Tower scheduler integration.
 *
 * Plugs into the existing bot by adding cron jobs that evaluate
 * control tower rules and post formatted alerts to the shadow pilot
 * channel. This file does NOT modify any existing scheduler behavior.
 *
 * Call startControlTowerScheduler() from src/index.ts AFTER the
 * existing startScheduler() call.
 */

import cron from "node-cron";
import type { App } from "@microsoft/teams.apps";
import { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import { getChannel } from "../proactive/store.js";
import { loadControlTowerConfig } from "./config.js";
import { ControlTowerEngine } from "./engine.js";
import type { RuleContext } from "./engine.js";
import type { ControlTowerConfig } from "./config.js";
import { formatAlertMessage, formatDailyDigest } from "./formatter.js";
import { logAlert, getRecentAlerts } from "./alert-log.js";

// Rule handler classes
import { ReadinessRule } from "./rules/readiness.js";
import { PrimeCostRule } from "./rules/prime-cost.js";
import { ItemMarginRule } from "./rules/item-margin.js";
import { VendorPriceRule } from "./rules/vendor-price.js";
import { SalesPaceRule } from "./rules/sales-pace.js";
import { LaborRule } from "./rules/labor.js";
import { DiscountCompRule } from "./rules/discount-comp.js";
import { StockoutRule } from "./rules/stockout.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const PREFIX = "[ControlTower]";

/**
 * Send a plain text message to a named channel.
 * If the channel is not registered, logs a reminder.
 */
async function sendToChannel(
  app: App,
  channelName: string,
  message: string
): Promise<void> {
  const channel = getChannel(channelName);
  if (!channel) {
    console.log(
      `${PREFIX} Channel "${channelName}" not registered. ` +
        `Run "register ${channelName}" in that channel.`
    );
    return;
  }

  try {
    await app.send(channel.conversationId, {
      type: "message",
      text: message,
    });
    console.log(`${PREFIX} Sent message to #${channelName}`);
  } catch (err) {
    console.log(
      `${PREFIX} Failed to send to #${channelName}: ${(err as Error).message}`
    );
  }
}

/**
 * Get today's YYYYMMDD string in the configured timezone.
 */
function todayStr(tz: string): string {
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

/**
 * Get yesterday's YYYYMMDD string in the configured timezone.
 */
function yesterdayStr(tz: string): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(yesterday);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}${m}${d}`;
}

/**
 * Build a RuleContext for the current moment.
 */
function buildContext(
  toastMcp: ToastMcpClient,
  marginedgeMcp: ToastMcpClient | null,
  ctConfig: ControlTowerConfig,
  timezone: string
): RuleContext {
  return {
    toastMcp,
    marginedgeMcp,
    config: ctConfig,
    timezone,
    todayStr: todayStr(timezone),
    yesterdayStr: yesterdayStr(timezone),
  };
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Start the Control Tower scheduler. Registers cron jobs that evaluate
 * rules via the engine and post formatted alerts to the shadow pilot
 * channel. This is additive only; it does NOT modify existing scheduler
 * jobs.
 */
export function startControlTowerScheduler(
  app: App,
  toastMcp: ToastMcpClient,
  timezone: string,
  botConfig: BotConfig
): void {
  console.log(`${PREFIX} Initializing Control Tower scheduler...`);

  // Load the control tower config (thresholds, schedules, cooldowns)
  const ctConfig = loadControlTowerConfig();
  console.log(`${PREFIX} Mode: ${ctConfig.mode}, Pilot channel: ${ctConfig.pilotChannel}`);

  // Check for MarginEdge MCP and create a second client if configured
  let marginedgeMcp: ToastMcpClient | null = null;
  const meMcpUrl = process.env.MARGINEDGE_MCP_URL;
  if (meMcpUrl) {
    console.log(`${PREFIX} MarginEdge MCP configured at: ${meMcpUrl}`);
    marginedgeMcp = new ToastMcpClient(meMcpUrl, undefined);
    marginedgeMcp.connect().catch((err) => {
      console.log(
        `${PREFIX} MarginEdge MCP connect failed, will retry on first rule evaluation: ${(err as Error).message}`
      );
    });
  } else {
    console.log(`${PREFIX} No MARGINEDGE_MCP_URL set. MarginEdge rules will skip evaluation.`);
  }

  // Create the engine and register all rules
  const engine = new ControlTowerEngine();
  engine.registerAll([
    new ReadinessRule(),
    new PrimeCostRule(),
    new ItemMarginRule(),
    new VendorPriceRule(),
    new SalesPaceRule(),
    new LaborRule(),
    new DiscountCompRule(),
    new StockoutRule(),
  ]);

  const pilotChannel = ctConfig.pilotChannel;
  const cronOpts = { timezone };
  const schedules = ctConfig.schedules;

  /**
   * Run the engine, format each alert via OpenAI, send to shadow pilot,
   * and log to the alert file.
   */
  async function runAndPost(): Promise<void> {
    try {
      const ctx = buildContext(toastMcp, marginedgeMcp, ctConfig, timezone);
      const alerts = await engine.run(ctx);

      if (alerts.length === 0) {
        console.log(`${PREFIX} No alerts from this evaluation cycle.`);
        return;
      }

      console.log(`${PREFIX} ${alerts.length} alert(s) to format and send.`);

      for (const alert of alerts) {
        const message = await formatAlertMessage(alert, botConfig);
        await sendToChannel(app, pilotChannel, message);
        logAlert(alert);
      }
    } catch (err) {
      console.log(`${PREFIX} Run cycle error: ${(err as Error).message}`);
    }
  }

  // ---- Register cron jobs based on config schedules ----

  // Morning readiness check
  cron.schedule(schedules.morningReadiness, () => {
    console.log(`${PREFIX} Running morning readiness check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: morning readiness at ${schedules.morningReadiness}`);

  // Readiness escalation
  cron.schedule(schedules.readinessEscalation, () => {
    console.log(`${PREFIX} Running readiness escalation check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: readiness escalation at ${schedules.readinessEscalation}`);

  // Daily prime cost
  cron.schedule(schedules.dailyPrimeCost, () => {
    console.log(`${PREFIX} Running daily prime cost check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: daily prime cost at ${schedules.dailyPrimeCost}`);

  // Weekly item margin
  cron.schedule(schedules.itemMarginWeekly, () => {
    console.log(`${PREFIX} Running weekly item margin check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: item margin weekly at ${schedules.itemMarginWeekly}`);

  // Daily vendor price
  cron.schedule(schedules.vendorPriceDaily, () => {
    console.log(`${PREFIX} Running daily vendor price check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: vendor price daily at ${schedules.vendorPriceDaily}`);

  // Sales pace: mid day
  cron.schedule(schedules.salesPaceMidDay, () => {
    console.log(`${PREFIX} Running mid day sales pace check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: sales pace mid day at ${schedules.salesPaceMidDay}`);

  // Sales pace: afternoon
  cron.schedule(schedules.salesPaceAfternoon, () => {
    console.log(`${PREFIX} Running afternoon sales pace check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: sales pace afternoon at ${schedules.salesPaceAfternoon}`);

  // Labor efficiency
  cron.schedule(schedules.laborEfficiency, () => {
    console.log(`${PREFIX} Running labor efficiency check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: labor efficiency at ${schedules.laborEfficiency}`);

  // Discount, comp, void check
  cron.schedule(schedules.discountCompVoid, () => {
    console.log(`${PREFIX} Running discount/comp/void check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: discount/comp/void at ${schedules.discountCompVoid}`);

  // Stockout check
  cron.schedule(schedules.stockoutCheck, () => {
    console.log(`${PREFIX} Running stockout check...`);
    runAndPost();
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: stockout check at ${schedules.stockoutCheck}`);

  // ---- Daily ops digest ----
  cron.schedule(schedules.dailyOpsDigest, async () => {
    console.log(`${PREFIX} Generating daily ops digest...`);
    try {
      const todayAlerts = getRecentAlerts(1);
      const digest = await formatDailyDigest(todayAlerts, botConfig);
      await sendToChannel(app, pilotChannel, digest);
      console.log(`${PREFIX} Daily digest sent (${todayAlerts.length} alerts summarized).`);
    } catch (err) {
      console.log(`${PREFIX} Daily digest error: ${(err as Error).message}`);
    }
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: daily ops digest at ${schedules.dailyOpsDigest}`);

  // ---- Weekly exec summary (placeholder, uses digest format for now) ----
  cron.schedule(schedules.weeklyExecSummary, async () => {
    console.log(`${PREFIX} Generating weekly exec summary...`);
    try {
      const weekAlerts = getRecentAlerts(7);
      const digest = await formatDailyDigest(weekAlerts, botConfig);
      const header = "📊 **Weekly Executive Summary**\n\n";
      await sendToChannel(app, pilotChannel, header + digest);
      console.log(`${PREFIX} Weekly summary sent (${weekAlerts.length} alerts from past 7 days).`);
    } catch (err) {
      console.log(`${PREFIX} Weekly summary error: ${(err as Error).message}`);
    }
  }, cronOpts);
  console.log(`${PREFIX} Scheduled: weekly exec summary at ${schedules.weeklyExecSummary}`);

  console.log(`${PREFIX} All control tower jobs registered. All alerts route to #${pilotChannel}.`);

  // Store references for on demand execution
  _runState = { engine, toastMcp, marginedgeMcp, ctConfig, timezone, botConfig };
}

/* ------------------------------------------------------------------ */
/*  On demand execution (for "test tower" command)                     */
/* ------------------------------------------------------------------ */

let _runState: {
  engine: ControlTowerEngine;
  toastMcp: ToastMcpClient;
  marginedgeMcp: ToastMcpClient | null;
  ctConfig: ControlTowerConfig;
  timezone: string;
  botConfig: BotConfig;
} | null = null;

/**
 * Run all control tower rules right now and return formatted messages.
 * Does NOT post to any channel; the caller decides where to send them.
 */
export async function runControlTowerNow(): Promise<string[]> {
  if (!_runState) {
    return ["Control Tower has not been initialized. Restart the bot to initialize."];
  }

  const { engine, toastMcp, marginedgeMcp, ctConfig, timezone, botConfig } = _runState;
  const ctx = buildContext(toastMcp, marginedgeMcp, ctConfig, timezone);
  const alerts = await engine.run(ctx);

  console.log(`${PREFIX} On demand run: ${alerts.length} alert(s) fired.`);

  if (alerts.length === 0) {
    return ["🟢 **Control Tower**: All rules evaluated. No alerts fired."];
  }

  const messages: string[] = [];
  for (const alert of alerts) {
    const msg = await formatAlertMessage(alert, botConfig);
    logAlert(alert);
    messages.push(msg);
  }

  return messages;
}
