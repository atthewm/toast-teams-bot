/**
 * Statistical engine for proactive operational intelligence.
 * Pure functions, no side effects, fully testable.
 * Manages rolling windows, hourly baselines, and operational state.
 */

import type { DailySummary } from "../cache/history.js";

// --- Data Structures ---

export interface RollingWindow {
  entries: Array<{ value: number; timestamp: number }>;
  maxAgeMs: number;
}

export interface DriveThruEntry {
  guid: string;
  seconds: number;
  serverName: string;
  timestamp: number;
}

export interface ServerStats {
  dtOrders: number;
  dtTotalSeconds: number;
  totalOrders: number;
  totalVoids: number;
  recentOrders: Array<{ guid: string; voided: boolean; timestamp: number }>;
}

export interface PlatformStats {
  count: number;
  lastSeenTimestamp: number;
}

export interface HourlyBaseline {
  avgOrders: number;
  stdDevOrders: number;
  avgSales: number;
  avgDriveThruSeconds: number;
  platformCounts: Map<string, number>;
  sampleCount: number;
}

export interface OperationalState {
  driveThruTimes: RollingWindow;
  orderVolume: RollingWindow;
  todayDriveThruAll: DriveThruEntry[];
  todayOrderCount: number;
  todaySales: number;
  todayOrdersByHour: Map<number, number>;
  todaySalesByHour: Map<number, number>;
  todayPlatformOrders: Map<string, PlatformStats>;
  todayServerStats: Map<string, ServerStats>;
  inRush: boolean;
  rushStartTime: number | null;
  rushPeakRate: number;
  rushStartOrders: number;
  rushStartSales: number;
  lastAlertTimes: Map<string, number>;
  hourlyBaselines: Map<string, HourlyBaseline>;
}

// --- Singleton ---

let state: OperationalState | null = null;

export function getState(): OperationalState {
  if (!state) {
    state = createEmptyState();
  }
  return state;
}

function createEmptyState(): OperationalState {
  return {
    driveThruTimes: createWindow(30 * 60 * 1000),
    orderVolume: createWindow(30 * 60 * 1000),
    todayDriveThruAll: [],
    todayOrderCount: 0,
    todaySales: 0,
    todayOrdersByHour: new Map(),
    todaySalesByHour: new Map(),
    todayPlatformOrders: new Map(),
    todayServerStats: new Map(),
    inRush: false,
    rushStartTime: null,
    rushPeakRate: 0,
    rushStartOrders: 0,
    rushStartSales: 0,
    lastAlertTimes: new Map(),
    hourlyBaselines: new Map(),
  };
}

// --- Rolling Window Functions ---

export function createWindow(maxAgeMs: number): RollingWindow {
  return { entries: [], maxAgeMs };
}

export function pushToWindow(window: RollingWindow, value: number, timestamp?: number): void {
  const ts = timestamp ?? Date.now();
  window.entries.push({ value, timestamp: ts });
  pruneWindow(window, ts);
}

function pruneWindow(window: RollingWindow, now?: number): void {
  const cutoff = (now ?? Date.now()) - window.maxAgeMs;
  window.entries = window.entries.filter((e) => e.timestamp >= cutoff);
}

export function windowAverage(window: RollingWindow): number | null {
  pruneWindow(window);
  if (window.entries.length === 0) return null;
  const sum = window.entries.reduce((s, e) => s + e.value, 0);
  return sum / window.entries.length;
}

export function windowStdDev(window: RollingWindow): number | null {
  pruneWindow(window);
  if (window.entries.length < 2) return null;
  const avg = windowAverage(window)!;
  const variance =
    window.entries.reduce((s, e) => s + (e.value - avg) ** 2, 0) / window.entries.length;
  return Math.sqrt(variance);
}

export function windowCount(window: RollingWindow): number {
  pruneWindow(window);
  return window.entries.length;
}

// --- Cooldown Functions ---

export function isOnCooldown(
  st: OperationalState,
  alertType: string,
  cooldownMs: number
): boolean {
  const last = st.lastAlertTimes.get(alertType);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

export function recordAlert(st: OperationalState, alertType: string): void {
  st.lastAlertTimes.set(alertType, Date.now());
}

// --- Baseline Functions ---

export function buildHourlyBaselines(
  summaries: DailySummary[]
): Map<string, HourlyBaseline> {
  const baselines = new Map<string, HourlyBaseline>();

  const groups = new Map<
    string,
    Array<{
      orders: number;
      sales: number;
      dtSeconds: number | null;
      platforms: Map<string, number>;
    }>
  >();

  for (const summary of summaries) {
    const dow = summary.dayOfWeek;

    for (const bucket of summary.ordersByHour) {
      const key = `${dow}:${bucket.hour}`;
      if (!groups.has(key)) groups.set(key, []);

      // Distribute platform counts proportionally to this hour
      const platforms = new Map<string, number>();
      if (summary.platformBreakdown.length > 0 && summary.totalOrders > 0) {
        const hourFraction = bucket.orders / summary.totalOrders;
        for (const pb of summary.platformBreakdown) {
          platforms.set(pb.platform, Math.round(pb.orders * hourFraction));
        }
      }

      groups.get(key)!.push({
        orders: bucket.orders,
        sales: bucket.sales,
        dtSeconds: summary.driveThru?.avgSeconds ?? null,
        platforms,
      });
    }
  }

  for (const [key, samples] of groups) {
    const orders = samples.map((s) => s.orders);
    const avgOrders = orders.reduce((a, b) => a + b, 0) / orders.length;
    const stdDevOrders =
      orders.length >= 2
        ? Math.sqrt(
            orders.reduce((s, o) => s + (o - avgOrders) ** 2, 0) / orders.length
          )
        : 0;
    const avgSales = samples.reduce((s, d) => s + d.sales, 0) / samples.length;

    const dtSamples = samples.filter((s) => s.dtSeconds !== null);
    const avgDtSeconds =
      dtSamples.length > 0
        ? dtSamples.reduce((s, d) => s + d.dtSeconds!, 0) / dtSamples.length
        : 90;

    const platTotals = new Map<string, number>();
    for (const sample of samples) {
      for (const [plat, count] of sample.platforms) {
        platTotals.set(plat, (platTotals.get(plat) ?? 0) + count);
      }
    }
    const platAvgs = new Map<string, number>();
    for (const [plat, total] of platTotals) {
      platAvgs.set(plat, Math.round(total / samples.length));
    }

    baselines.set(key, {
      avgOrders: Math.round(avgOrders * 10) / 10,
      stdDevOrders: Math.round(stdDevOrders * 10) / 10,
      avgSales: Math.round(avgSales * 100) / 100,
      avgDriveThruSeconds: Math.round(avgDtSeconds),
      platformCounts: platAvgs,
      sampleCount: samples.length,
    });
  }

  return baselines;
}

export function getCurrentBaseline(
  st: OperationalState,
  tz: string
): HourlyBaseline | null {
  const dow = getCurrentDow(tz);
  const hour = getCurrentHour(tz);
  return st.hourlyBaselines.get(`${dow}:${hour}`) ?? null;
}

export function getBaselineForHour(
  st: OperationalState,
  tz: string,
  hour: number
): HourlyBaseline | null {
  const dow = getCurrentDow(tz);
  return st.hourlyBaselines.get(`${dow}:${hour}`) ?? null;
}

export function getCumulativeBaseline(
  st: OperationalState,
  tz: string
): { expectedOrders: number; expectedSales: number } | null {
  const dow = getCurrentDow(tz);
  const currentHour = getCurrentHour(tz);
  const currentMinute = getCurrentMinute(tz);

  let totalOrders = 0;
  let totalSales = 0;
  let hasData = false;

  for (let h = 5; h < currentHour; h++) {
    const baseline = st.hourlyBaselines.get(`${dow}:${h}`);
    if (baseline && baseline.sampleCount >= 2) {
      totalOrders += baseline.avgOrders;
      totalSales += baseline.avgSales;
      hasData = true;
    }
  }

  const currentBaseline = st.hourlyBaselines.get(`${dow}:${currentHour}`);
  if (currentBaseline && currentBaseline.sampleCount >= 2) {
    const fraction = currentMinute / 60;
    totalOrders += currentBaseline.avgOrders * fraction;
    totalSales += currentBaseline.avgSales * fraction;
    hasData = true;
  }

  if (!hasData) return null;

  return {
    expectedOrders: Math.round(totalOrders),
    expectedSales: Math.round(totalSales * 100) / 100,
  };
}

export function getEndOfDayProjection(
  st: OperationalState,
  tz: string
): { projectedSales: number; typicalSales: number } | null {
  const dow = getCurrentDow(tz);

  let typicalTotal = 0;
  let hasBaseline = false;
  for (let h = 5; h <= 18; h++) {
    const baseline = st.hourlyBaselines.get(`${dow}:${h}`);
    if (baseline && baseline.sampleCount >= 2) {
      typicalTotal += baseline.avgSales;
      hasBaseline = true;
    }
  }

  if (!hasBaseline || typicalTotal === 0) return null;

  const cumulative = getCumulativeBaseline(st, tz);
  if (!cumulative || cumulative.expectedSales === 0) return null;

  const rate = st.todaySales / cumulative.expectedSales;
  const projected = rate * typicalTotal;

  return {
    projectedSales: Math.round(projected * 100) / 100,
    typicalSales: Math.round(typicalTotal * 100) / 100,
  };
}

// --- Statistical Functions ---

export function zScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

// --- Initialization ---

export function initOperationalState(
  summaries: DailySummary[],
  windowMinutes: number
): OperationalState {
  const st = createEmptyState();
  st.driveThruTimes = createWindow(windowMinutes * 60 * 1000);
  st.orderVolume = createWindow(windowMinutes * 60 * 1000);
  st.hourlyBaselines = buildHourlyBaselines(summaries);
  state = st;
  console.log(
    `[Stats] Initialized with ${summaries.length} days of history, ${st.hourlyBaselines.size} baseline slots`
  );
  return st;
}

// --- Daily Reset ---

export function resetDaily(st: OperationalState): void {
  st.driveThruTimes.entries = [];
  st.orderVolume.entries = [];
  st.todayDriveThruAll = [];
  st.todayOrderCount = 0;
  st.todaySales = 0;
  st.todayOrdersByHour.clear();
  st.todaySalesByHour.clear();
  st.todayPlatformOrders.clear();
  st.todayServerStats.clear();
  st.inRush = false;
  st.rushStartTime = null;
  st.rushPeakRate = 0;
  st.rushStartOrders = 0;
  st.rushStartSales = 0;
  st.lastAlertTimes.clear();
  console.log("[Stats] Daily reset complete");
}

// --- Time Helpers ---

export function formatSeconds(seconds: number): string {
  const m = Math.floor(Math.abs(seconds) / 60);
  const s = Math.round(Math.abs(seconds)) % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour > 12) return `${hour - 12} PM`;
  return `${hour} AM`;
}

export function getCurrentHour(tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

export function getCurrentMinute(tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    minute: "numeric",
  });
  return parseInt(formatter.format(new Date()), 10);
}

export function getCurrentTimeStr(tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return formatter.format(new Date());
}

export function getDayName(tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  });
  return formatter.format(new Date());
}

export function getCurrentDow(tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  });
  const name = formatter.format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}
