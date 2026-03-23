/**
 * Real-time alert monitor.
 * Polls Toast orders and fires alerts for large orders, high void rates,
 * long open orders, drive-thru speed violations, and proactive
 * intelligence alerts (outliers, trends, pacing, droughts, rush detection).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import {
  formatLargeOrderAlert,
  formatHighVoidAlert,
  formatLongOpenOrderAlert,
  formatDriveThruPrepNote,
  formatDtOutlierAlert,
  formatDtTrendAlert,
  formatCombinedDtAlert,
  formatSlowPeriodAlert,
  formatPlatformDroughtAlert,
  formatRevenuePacingAlert,
  formatVoidClusterAlert,
  formatRushStartAlert,
  formatRushEndAlert,
  type OrderInfo,
} from "./formatters.js";
import {
  getState,
  windowAverage,
  windowCount,
  isOnCooldown,
  recordAlert,
  getCurrentBaseline,
  getCumulativeBaseline,
  getEndOfDayProjection,
  getCurrentHour,
  getCurrentMinute,
  getCurrentTimeStr,
  getDayName,
  formatSeconds,
  type OperationalState,
} from "../intelligence/stats.js";

// --- Persisted state (survives restarts) ---

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
  // Intelligence alerts
  dtIntelAlert: string | null;
  slowPeriodAlert: string | null;
  platformDroughtAlerts: string[];
  revenuePacingAlert: string | null;
  voidClusterAlert: string | null;
  rushTransition: string | null;
}

// --- Constants ---

const STATE_DIR = process.env.ALERT_STATE_DIR ?? resolve(process.cwd(), "data");
const STATE_FILE = resolve(STATE_DIR, "alert-state.json");
const DRIVE_THRU_NAMES = [
  "drive thru",
  "drive-thru",
  "drivethru",
  "drive through",
];

const PLATFORM_MAP: Record<string, string[]> = {
  DoorDash: ["doordash"],
  "Uber Eats": ["uber eats", "ubereats"],
  Grubhub: ["grubhub"],
  Google: ["google delivery", "google take out"],
  "Online Ordering": ["online ordering", "px online", "px take out"],
  "Craver App": ["craver app"],
  "Toast Delivery": ["toast delivery"],
  "Drive Thru": ["drive thru", "drive-thru", "drivethru", "drive through"],
};

// --- Helpers ---

function isDriveThruName(name?: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return DRIVE_THRU_NAMES.some((n) => lower.includes(n));
}

function classifyPlatform(diningOptionName: string): string {
  const lower = diningOptionName.toLowerCase();
  for (const [platform, keywords] of Object.entries(PLATFORM_MAP)) {
    if (keywords.some((k) => lower.includes(k))) return platform;
  }
  return "In House";
}

// --- State persistence ---

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

// --- Time helpers ---

function getHourInTimezone(tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

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

// --- Existing: drive-thru speed check ---

function checkDriveThruSpeed(
  orders: OrderSummary[],
  seenGuids: Set<string>
): { avgSeconds: number | null; count: number; alert: string | null } {
  const TARGET_SECONDS = 90;

  const dtOrders = orders.filter((o) => {
    if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided)
      return false;
    return isDriveThruName(o.diningOptionName);
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
      if (seconds > TARGET_SECONDS && !seenGuids.has(o.guid)) {
        slowOrders.push({
          num: o.displayNumber ?? o.guid.slice(0, 8),
          seconds,
        });
      }
    }
  }

  const avgSeconds = counted > 0 ? Math.round(totalSeconds / counted) : null;

  if (
    avgSeconds !== null &&
    avgSeconds > TARGET_SECONDS &&
    slowOrders.length > 0
  ) {
    const avgStr = formatSeconds(avgSeconds);
    const delta = avgSeconds - TARGET_SECONDS;

    let text = `**Drive Thru Speed Alert**\n\n`;
    text += `Today's average: **${avgStr}** (target: 1:30, **${delta}s over**)\n`;
    text += `Completed drive thru orders today: **${counted}**\n\n`;

    if (slowOrders.length > 0) {
      text += `Recent slow orders:\n`;
      for (const s of slowOrders.slice(0, 5)) {
        text += `Order #${s.num}: ${formatSeconds(s.seconds)}\n`;
      }
    }

    text += `\n**Every order through in 1:30. That's the standard.**`;

    return { avgSeconds, count: counted, alert: text };
  }

  return { avgSeconds, count: counted, alert: null };
}

// --- Operational State Update ---

function updateOperationalState(
  orders: OrderSummary[],
  _config: BotConfig,
  tz: string
): void {
  const st = getState();
  const now = Date.now();
  const windowCutoff = now - st.driveThruTimes.maxAgeMs;

  const valid = orders.filter((o) => !o.voided);

  // Rebuild today's totals
  st.todayOrderCount = valid.length;
  st.todaySales = valid.reduce((s, o) => s + o.total, 0);

  // Rebuild hourly buckets
  st.todayOrdersByHour.clear();
  st.todaySalesByHour.clear();
  const hourFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });

  for (const o of valid) {
    if (!o.openedDate) continue;
    const hour = parseInt(hourFormatter.format(new Date(o.openedDate)), 10);
    st.todayOrdersByHour.set(
      hour,
      (st.todayOrdersByHour.get(hour) ?? 0) + 1
    );
    st.todaySalesByHour.set(
      hour,
      (st.todaySalesByHour.get(hour) ?? 0) + o.total
    );
  }

  // Rebuild platform stats
  st.todayPlatformOrders.clear();
  for (const o of valid) {
    const platform = classifyPlatform(o.diningOptionName ?? "");
    const stats = st.todayPlatformOrders.get(platform) ?? {
      count: 0,
      lastSeenTimestamp: 0,
    };
    stats.count++;
    if (o.openedDate) {
      const ts = new Date(o.openedDate).getTime();
      if (ts > stats.lastSeenTimestamp) stats.lastSeenTimestamp = ts;
    }
    st.todayPlatformOrders.set(platform, stats);
  }

  // Rebuild server stats
  st.todayServerStats.clear();
  for (const o of orders) {
    const server = o.serverName ?? "Unknown";
    const stats = st.todayServerStats.get(server) ?? {
      dtOrders: 0,
      dtTotalSeconds: 0,
      totalOrders: 0,
      totalVoids: 0,
      recentOrders: [],
    };

    if (!o.voided) {
      stats.totalOrders++;
    } else {
      stats.totalVoids++;
    }

    if (o.openedDate) {
      stats.recentOrders.push({
        guid: o.guid,
        voided: o.voided ?? false,
        timestamp: new Date(o.openedDate).getTime(),
      });
    }

    if (
      isDriveThruName(o.diningOptionName) &&
      o.openedDate &&
      o.closedDate &&
      !o.voided
    ) {
      const sec = Math.round(
        (new Date(o.closedDate).getTime() -
          new Date(o.openedDate).getTime()) /
          1000
      );
      if (sec > 0 && sec < 3600) {
        stats.dtOrders++;
        stats.dtTotalSeconds += sec;
      }
    }

    st.todayServerStats.set(server, stats);
  }

  // Sort recent orders by time (newest first) and limit per server
  for (const [, stats] of st.todayServerStats) {
    stats.recentOrders.sort((a, b) => b.timestamp - a.timestamp);
    stats.recentOrders = stats.recentOrders.slice(0, 20);
  }

  // Rebuild DT today all
  st.todayDriveThruAll = [];
  for (const o of valid) {
    if (isDriveThruName(o.diningOptionName) && o.openedDate && o.closedDate) {
      const sec = Math.round(
        (new Date(o.closedDate).getTime() -
          new Date(o.openedDate).getTime()) /
          1000
      );
      if (sec > 0 && sec < 3600) {
        st.todayDriveThruAll.push({
          guid: o.guid,
          seconds: sec,
          serverName: o.serverName ?? "Unknown",
          timestamp: new Date(o.openedDate).getTime(),
        });
      }
    }
  }

  // Rebuild rolling windows from recent orders
  st.driveThruTimes.entries = [];
  st.orderVolume.entries = [];

  for (const o of valid) {
    if (!o.openedDate) continue;
    const ts = new Date(o.openedDate).getTime();
    if (ts < windowCutoff) continue;

    st.orderVolume.entries.push({ value: 1, timestamp: ts });

    if (isDriveThruName(o.diningOptionName) && o.closedDate) {
      const sec = Math.round(
        (new Date(o.closedDate).getTime() - ts) / 1000
      );
      if (sec > 0 && sec < 3600) {
        st.driveThruTimes.entries.push({ value: sec, timestamp: ts });
      }
    }
  }
}

// --- Intelligence Detection Functions ---

function detectDtOutlier(
  st: OperationalState,
  newDtOrders: Array<{
    guid: string;
    seconds: number;
    displayNumber: string;
  }>,
  config: BotConfig
): string | null {
  if (isOnCooldown(st, "dt_outlier", 10 * 60 * 1000)) return null;

  const rollingAvg = windowAverage(st.driveThruTimes);
  if (rollingAvg === null || windowCount(st.driveThruTimes) < 3) return null;

  const threshold = rollingAvg * config.dtOutlierMultiplier;

  for (const entry of newDtOrders) {
    if (entry.seconds > threshold) {
      recordAlert(st, "dt_outlier");
      return formatDtOutlierAlert(
        entry.displayNumber,
        entry.seconds,
        rollingAvg,
        windowCount(st.driveThruTimes)
      );
    }
  }

  return null;
}

function detectDtTrend(
  st: OperationalState,
  config: BotConfig
): string | null {
  if (isOnCooldown(st, "dt_trend", 15 * 60 * 1000)) return null;

  const rollingAvg = windowAverage(st.driveThruTimes);
  if (rollingAvg === null || windowCount(st.driveThruTimes) < 5) return null;

  if (st.todayDriveThruAll.length === 0) return null;
  const dailyAvg =
    st.todayDriveThruAll.reduce((s, e) => s + e.seconds, 0) /
    st.todayDriveThruAll.length;

  const percentAbove = (rollingAvg - dailyAvg) / dailyAvg;
  const absoluteAbove = rollingAvg - dailyAvg;

  if (percentAbove >= config.dtTrendThreshold && absoluteAbove >= 15) {
    recordAlert(st, "dt_trend");
    return formatDtTrendAlert(
      rollingAvg,
      windowCount(st.driveThruTimes),
      dailyAvg,
      st.todayDriveThruAll.length
    );
  }

  return null;
}

function detectSlowPeriod(
  st: OperationalState,
  config: BotConfig,
  tz: string
): string | null {
  if (isOnCooldown(st, "slow_period", 30 * 60 * 1000)) return null;

  const currentMinute = getCurrentMinute(tz);
  if (currentMinute < 30) return null;

  const baseline = getCurrentBaseline(st, tz);
  if (!baseline || baseline.sampleCount < 2) return null;

  const currentHour = getCurrentHour(tz);
  const thisHourOrders = st.todayOrdersByHour.get(currentHour) ?? 0;
  const expectedSoFar = baseline.avgOrders * (currentMinute / 60);

  if (
    expectedSoFar > 0 &&
    thisHourOrders < expectedSoFar * config.slowPeriodThreshold
  ) {
    recordAlert(st, "slow_period");
    return formatSlowPeriodAlert(
      getCurrentTimeStr(tz),
      thisHourOrders,
      Math.round(expectedSoFar),
      getDayName(tz)
    );
  }

  return null;
}

function detectPlatformDrought(
  st: OperationalState,
  config: BotConfig,
  tz: string
): string[] {
  const results: string[] = [];
  const now = Date.now();

  const MARKETPLACE = ["DoorDash", "Uber Eats", "Grubhub"];
  const baseline = getCurrentBaseline(st, tz);

  for (const platform of MARKETPLACE) {
    const cooldownKey = `platform_drought_${platform}`;
    if (isOnCooldown(st, cooldownKey, 60 * 60 * 1000)) continue;

    const stats = st.todayPlatformOrders.get(platform);
    const lastSeen = stats?.lastSeenTimestamp ?? 0;

    // Skip if never seen today
    if (lastSeen === 0) continue;

    const minutesSince = Math.round((now - lastSeen) / 60000);
    const baselineCount = baseline?.platformCounts.get(platform) ?? 0;

    if (baselineCount < 2) continue;

    if (minutesSince >= config.platformDroughtMinutes) {
      recordAlert(st, cooldownKey);
      results.push(
        formatPlatformDroughtAlert(
          platform,
          minutesSince,
          baselineCount,
          getDayName(tz)
        )
      );
    }
  }

  return results;
}

function detectRevenuePacing(
  st: OperationalState,
  config: BotConfig,
  tz: string
): string | null {
  if (isOnCooldown(st, "revenue_pacing", 60 * 60 * 1000)) return null;

  const currentHour = getCurrentHour(tz);
  if (currentHour < 9) return null;

  const cumBaseline = getCumulativeBaseline(st, tz);
  if (!cumBaseline || cumBaseline.expectedSales === 0) return null;

  const pctBehind =
    (cumBaseline.expectedSales - st.todaySales) / cumBaseline.expectedSales;

  if (pctBehind >= config.revenuePacingThreshold) {
    const projection = getEndOfDayProjection(st, tz);
    recordAlert(st, "revenue_pacing");
    return formatRevenuePacingAlert(
      getCurrentTimeStr(tz),
      st.todaySales,
      cumBaseline.expectedSales,
      pctBehind,
      getDayName(tz),
      projection?.projectedSales ?? null,
      projection?.typicalSales ?? null
    );
  }

  return null;
}

function detectVoidCluster(
  st: OperationalState,
  config: BotConfig
): string | null {
  if (isOnCooldown(st, "void_cluster", 30 * 60 * 1000)) return null;

  for (const [serverName, stats] of st.todayServerStats) {
    if (serverName === "Unknown") continue;

    const recent = stats.recentOrders.slice(0, config.voidClusterWindow);
    if (recent.length < config.voidClusterWindow) continue;

    const voidCount = recent.filter((o) => o.voided).length;
    if (voidCount >= config.voidClusterCount) {
      const newest = recent[0]?.timestamp ?? 0;
      const oldest = recent[recent.length - 1]?.timestamp ?? 0;
      const minutesSpan = Math.round((newest - oldest) / 60000);

      recordAlert(st, "void_cluster");
      return formatVoidClusterAlert(
        serverName,
        voidCount,
        recent.length,
        minutesSpan
      );
    }
  }

  return null;
}

function detectRushTransition(
  st: OperationalState,
  config: BotConfig,
  tz: string
): string | null {
  if (isOnCooldown(st, "rush_transition", 15 * 60 * 1000)) return null;

  const baseline = getCurrentBaseline(st, tz);
  if (!baseline || baseline.sampleCount < 2 || baseline.avgOrders === 0)
    return null;

  // Calculate 15 min order rate
  const now = Date.now();
  const fifteenMinAgo = now - 15 * 60 * 1000;
  const recentOrders = st.orderVolume.entries.filter(
    (e) => e.timestamp >= fifteenMinAgo
  );
  const rate15min = recentOrders.length;
  const baselineRate15min = baseline.avgOrders / 4;

  if (!st.inRush) {
    // Check for rush start
    if (
      rate15min >= baselineRate15min * config.rushEntryMultiplier &&
      rate15min >= 3
    ) {
      st.inRush = true;
      st.rushStartTime = now;
      st.rushPeakRate = rate15min;
      st.rushStartOrders = st.todayOrderCount;
      st.rushStartSales = st.todaySales;
      recordAlert(st, "rush_transition");
      return formatRushStartAlert(
        rate15min,
        Math.round(baselineRate15min * 10) / 10
      );
    }
  } else {
    // Update peak
    if (rate15min > st.rushPeakRate) st.rushPeakRate = rate15min;

    // Check for rush end
    if (rate15min <= baselineRate15min * config.rushExitMultiplier) {
      const rushDuration = now - (st.rushStartTime ?? now);
      const rushMinutes = Math.round(rushDuration / 60000);
      const rushOrders = st.todayOrderCount - st.rushStartOrders;
      const rushSales = st.todaySales - st.rushStartSales;

      // DT avg during rush
      const rushDtEntries = st.todayDriveThruAll.filter(
        (e) => e.timestamp >= (st.rushStartTime ?? 0)
      );
      const rushDtAvg =
        rushDtEntries.length > 0
          ? Math.round(
              rushDtEntries.reduce((s, e) => s + e.seconds, 0) /
                rushDtEntries.length
            )
          : null;

      st.inRush = false;
      recordAlert(st, "rush_transition");
      return formatRushEndAlert(
        rushMinutes,
        rushOrders,
        rushSales,
        rushDtAvg
      );
    }
  }

  return null;
}

// --- Main Poll ---

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
    dtIntelAlert: null,
    slowPeriodAlert: null,
    platformDroughtAlerts: [],
    revenuePacingAlert: null,
    voidClusterAlert: null,
    rushTransition: null,
  };

  // Only poll during operating hours (5 AM to 7 PM)
  const currentHour = getHourInTimezone(config.timezone);
  if (currentHour < 5 || currentHour >= 19) {
    return result;
  }

  const alertState = loadState();
  const seenGuids = new Set(alertState.seenOrderGuids);

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
    try {
      data = JSON.parse(raw);
    } catch {
      /* plain text fallback */
    }

    if (!data?.orders) {
      return result;
    }

    const now = Date.now();

    // --- Update operational state from full order list ---
    updateOperationalState(data.orders, config, config.timezone);

    // --- Large order alerts (with DT prep note enhancement) ---
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
        let alert = formatLargeOrderAlert(info);
        // Enhancement: prep note for large drive thru orders
        if (order.itemCount >= 8 && isDriveThruName(order.diningOptionName)) {
          alert += formatDriveThruPrepNote(order.itemCount);
        }
        result.largeOrders.push(alert);
      }
    }

    // --- High void rate alert ---
    const oneHourAgo = now - 60 * 60 * 1000;
    const recentVoids = data.orders.filter((o) => {
      if (!o.voided || !o.openedDate) return false;
      return new Date(o.openedDate).getTime() > oneHourAgo;
    });

    const voidWindowKey = new Date().toISOString().slice(0, 13);
    if (
      recentVoids.length >= config.highVoidCount &&
      !alertState.alertedVoidWindows.includes(voidWindowKey)
    ) {
      result.voidAlert = formatHighVoidAlert(recentVoids.length, 60);
      alertState.alertedVoidWindows.push(voidWindowKey);
      if (alertState.alertedVoidWindows.length > 24) {
        alertState.alertedVoidWindows =
          alertState.alertedVoidWindows.slice(-24);
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
        minutesOpen: Math.round(
          (now - new Date(o.openedDate!).getTime()) / 60000
        ),
        serverName: o.serverName,
      }));

    const newLongOpen = longOpen.filter(
      (o) => !alertState.alertedLongOpenGuids.includes(o.guid)
    );

    if (newLongOpen.length > 0) {
      result.longOpenAlert = formatLongOpenOrderAlert(newLongOpen);
      for (const o of newLongOpen) {
        alertState.alertedLongOpenGuids.push(o.guid);
      }
    }

    // --- Drive-thru speed check (existing) ---
    const dtResult = checkDriveThruSpeed(data.orders, seenGuids);
    result.driveThruAlert = dtResult.alert;

    // --- Intelligence alerts ---
    const opState = getState();

    // Collect new DT orders for outlier detection
    const newDtOrders: Array<{
      guid: string;
      seconds: number;
      displayNumber: string;
    }> = [];
    for (const o of data.orders) {
      if (seenGuids.has(o.guid)) continue;
      if (o.voided || !isDriveThruName(o.diningOptionName)) continue;
      if (!o.openedDate || !o.closedDate) continue;
      const sec = Math.round(
        (new Date(o.closedDate).getTime() -
          new Date(o.openedDate).getTime()) /
          1000
      );
      if (sec > 0 && sec < 3600) {
        newDtOrders.push({
          guid: o.guid,
          seconds: sec,
          displayNumber: o.displayNumber ?? o.guid.slice(0, 8),
        });
      }
    }

    // DT Outlier + Trend (batched into one message if both fire)
    const dtOutlier = detectDtOutlier(opState, newDtOrders, config);
    const dtTrend = detectDtTrend(opState, config);
    if (dtOutlier || dtTrend) {
      result.dtIntelAlert = formatCombinedDtAlert(dtOutlier, dtTrend);
    }

    // Slow period
    result.slowPeriodAlert = detectSlowPeriod(
      opState,
      config,
      config.timezone
    );

    // Platform drought
    result.platformDroughtAlerts = detectPlatformDrought(
      opState,
      config,
      config.timezone
    );

    // Revenue pacing
    result.revenuePacingAlert = detectRevenuePacing(
      opState,
      config,
      config.timezone
    );

    // Void cluster
    result.voidClusterAlert = detectVoidCluster(opState, config);

    // Rush transition
    result.rushTransition = detectRushTransition(
      opState,
      config,
      config.timezone
    );

    // --- Update persisted state ---
    for (const order of data.orders) {
      seenGuids.add(order.guid);
    }
    alertState.seenOrderGuids = Array.from(seenGuids).slice(-500);
    alertState.lastPollTime = new Date().toISOString();

    // Clean up long-open alerts for closed orders
    const openGuids = new Set(
      data.orders
        .filter((o) => !o.closedDate && !o.voided)
        .map((o) => o.guid)
    );
    alertState.alertedLongOpenGuids =
      alertState.alertedLongOpenGuids.filter((g) => openGuids.has(g));

    saveState(alertState);
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
