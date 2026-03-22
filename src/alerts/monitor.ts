/**
 * Real-time alert monitor.
 * Polls Toast orders on a 90-second interval and fires alerts
 * for large orders, high void rates, long open orders, and
 * drive-thru speed violations.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import {
  formatLargeOrderAlert,
  formatHighVoidAlert,
  formatLongOpenOrderAlert,
  type OrderInfo,
} from "./formatters.js";

/** Persisted state so restarts don't re-fire alerts for already seen orders. */
interface AlertState {
  seenOrderGuids: string[];
  alertedVoidWindows: string[];
  alertedLongOpenGuids: string[];
  lastPollTime: string;
}

interface OrderSummary {
  guid: string;
  displayNumber?: string;
  openedDate?: string;
  closedDate?: string;
  total: number;
  itemCount: number;
  voided?: boolean;
  serverName?: string;
  diningOptionName?: string;
}

export interface AlertResult {
  largeOrders: string[];
  voidAlert: string | null;
  longOpenAlert: string | null;
  driveThruAlert: string | null;
}

const STATE_DIR = process.env.ALERT_STATE_DIR ?? resolve(process.cwd(), "data");
const STATE_FILE = resolve(STATE_DIR, "alert-state.json");

function loadState(): AlertState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    console.log("[Alerts] Failed to load state, starting fresh");
  }
  return {
    seenOrderGuids: [],
    alertedVoidWindows: [],
    alertedLongOpenGuids: [],
    lastPollTime: new Date().toISOString(),
  };
}

function saveState(state: AlertState): void {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.log("[Alerts] Failed to save state:", (err as Error).message);
  }
}

/** Get the hour in the configured timezone. */
function getHourInTimezone(tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

/** Format YYYYMMDD for today in the given timezone. */
function todayBusinessDate(tz: string): string {
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

/** Compute drive-thru average time and alert if above target. */
function checkDriveThruSpeed(
  orders: OrderSummary[],
  seenGuids: Set<string>
): { avgSeconds: number | null; count: number; alert: string | null } {
  const DRIVE_THRU_NAMES = ["Drive Thru", "Drive-Thru", "DriveThru", "Drive Through"];
  const TARGET_SECONDS = 90; // 1:30

  const dtOrders = orders.filter((o) => {
    if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
    return DRIVE_THRU_NAMES.some((n) =>
      o.diningOptionName!.toLowerCase().includes(n.toLowerCase())
    );
  });

  if (dtOrders.length === 0) {
    return { avgSeconds: null, count: 0, alert: null };
  }

  let totalSeconds = 0;
  let counted = 0;
  const slowOrders: Array<{ num: string; seconds: number }> = [];

  for (const o of dtOrders) {
    const opened = new Date(o.openedDate!).getTime();
    const closed = new Date(o.closedDate!).getTime();
    const seconds = Math.round((closed - opened) / 1000);
    if (seconds > 0 && seconds < 3600) {
      totalSeconds += seconds;
      counted++;
      // Only alert on new orders we haven't seen before that are slow
      if (seconds > TARGET_SECONDS && !seenGuids.has(o.guid)) {
        slowOrders.push({
          num: o.displayNumber ?? o.guid.slice(0, 8),
          seconds,
        });
      }
    }
  }

  const avgSeconds = counted > 0 ? Math.round(totalSeconds / counted) : null;

  // Only fire alert if the rolling average is above target
  if (avgSeconds !== null && avgSeconds > TARGET_SECONDS && slowOrders.length > 0) {
    const avgMin = Math.floor(avgSeconds / 60);
    const avgSec = avgSeconds % 60;
    const avgStr = `${avgMin}:${String(avgSec).padStart(2, "0")}`;
    const targetStr = "1:30";
    const delta = avgSeconds - TARGET_SECONDS;

    let text = `**Drive-Thru Speed Alert**\n\n`;
    text += `Today's average: **${avgStr}** (target: ${targetStr}, **${delta}s over**)\n`;
    text += `Completed drive-thru orders today: **${counted}**\n\n`;

    if (slowOrders.length > 0) {
      text += `Recent slow orders:\n`;
      for (const s of slowOrders.slice(0, 5)) {
        const m = Math.floor(s.seconds / 60);
        const sec = s.seconds % 60;
        text += `Order #${s.num}: ${m}:${String(sec).padStart(2, "0")}\n`;
      }
    }

    text += `\n**Every order through in 1:30. That's the standard.**`;

    return { avgSeconds, count: counted, alert: text };
  }

  return { avgSeconds, count: counted, alert: null };
}

/**
 * Run a single poll cycle. Returns alert messages to send.
 */
export async function pollAlerts(
  mcp: ToastMcpClient,
  config: BotConfig
): Promise<AlertResult> {
  const result: AlertResult = {
    largeOrders: [],
    voidAlert: null,
    longOpenAlert: null,
    driveThruAlert: null,
  };

  // Only poll during operating hours (5 AM to 7 PM)
  const currentHour = getHourInTimezone(config.timezone);
  if (currentHour < 5 || currentHour >= 19) {
    return result;
  }

  const state = loadState();
  const seenGuids = new Set(state.seenOrderGuids);

  try {
    const dateStr = todayBusinessDate(config.timezone);
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 200,
    });

    let data: {
      totalOrders?: number;
      orders?: OrderSummary[];
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text fallback */ }

    if (!data?.orders) {
      return result;
    }

    const now = Date.now();

    // --- Large order alerts ---
    for (const order of data.orders) {
      if (seenGuids.has(order.guid)) continue;
      if (order.voided) continue;

      const isLargeDollars = order.total >= config.largeOrderDollars;
      const isLargeItems = order.itemCount >= config.largeOrderItems;

      if (isLargeDollars || isLargeItems) {
        const info: OrderInfo = {
          guid: order.guid,
          displayNumber: order.displayNumber,
          total: order.total,
          itemCount: order.itemCount,
          serverName: order.serverName,
          diningOptionName: order.diningOptionName,
          openedDate: order.openedDate,
        };
        result.largeOrders.push(formatLargeOrderAlert(info));
      }
    }

    // --- High void rate alert ---
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentVoids = data.orders.filter((o) => {
      if (!o.voided || !o.openedDate) return false;
      return new Date(o.openedDate).getTime() > oneHourAgo;
    });

    const voidWindowKey = new Date().toISOString().slice(0, 13); // hourly window
    if (
      recentVoids.length >= config.highVoidCount &&
      !state.alertedVoidWindows.includes(voidWindowKey)
    ) {
      result.voidAlert = formatHighVoidAlert(recentVoids.length, 60);
      state.alertedVoidWindows.push(voidWindowKey);
      // Keep only last 24 window keys
      if (state.alertedVoidWindows.length > 24) {
        state.alertedVoidWindows = state.alertedVoidWindows.slice(-24);
      }
    }

    // --- Long open order alert ---
    const longOpenThreshold = config.longOpenMinutes * 60 * 1000;
    const longOpen = data.orders
      .filter((o) => {
        if (o.voided || o.closedDate || !o.openedDate) return false;
        const openTime = new Date(o.openedDate).getTime();
        return now - openTime > longOpenThreshold;
      })
      .map((o) => ({
        guid: o.guid,
        displayNumber: o.displayNumber,
        minutesOpen: Math.round((now - new Date(o.openedDate!).getTime()) / 60000),
        serverName: o.serverName,
      }));

    // Only alert for orders we haven't already alerted on
    const newLongOpen = longOpen.filter(
      (o) => !state.alertedLongOpenGuids.includes(o.guid)
    );

    if (newLongOpen.length > 0) {
      result.longOpenAlert = formatLongOpenOrderAlert(newLongOpen);
      for (const o of newLongOpen) {
        state.alertedLongOpenGuids.push(o.guid);
      }
    }

    // --- Drive-thru speed check ---
    const dtResult = checkDriveThruSpeed(data.orders, seenGuids);
    result.driveThruAlert = dtResult.alert;

    // Update seen GUIDs (keep manageable size)
    for (const order of data.orders) {
      seenGuids.add(order.guid);
    }
    state.seenOrderGuids = Array.from(seenGuids).slice(-500);
    state.lastPollTime = new Date().toISOString();

    // Clean up long-open alerts for orders that are now closed
    const openGuids = new Set(
      data.orders.filter((o) => !o.closedDate && !o.voided).map((o) => o.guid)
    );
    state.alertedLongOpenGuids = state.alertedLongOpenGuids.filter((g) =>
      openGuids.has(g)
    );

    saveState(state);
  } catch (err) {
    console.log("[Alerts] Poll error:", (err as Error).message);
  }

  return result;
}

/**
 * Reset alert state. Useful for testing.
 */
export function resetAlertState(): void {
  saveState({
    seenOrderGuids: [],
    alertedVoidWindows: [],
    alertedLongOpenGuids: [],
    lastPollTime: new Date().toISOString(),
  });
}
