/**
 * Historical daily summary cache.
 * Stores one JSON file per day in /home/data/history/ (persistent on Azure)
 * or data/history/ locally. Keeps 14 days in memory for comparisons.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ToastMcpClient } from "../mcp/client.js";

export interface HourBucket {
  hour: number;
  orders: number;
  sales: number;
}

export interface PlatformBucket {
  platform: string;
  orders: number;
  sales: number;
}

export interface TopItem {
  name: string;
  count: number;
}

export interface DailyDriveThru {
  count: number;
  avgSeconds: number;
}

export interface DailySummary {
  date: string; // YYYYMMDD
  dayOfWeek: number; // 0=Sun .. 6=Sat
  totalOrders: number;
  totalSales: number;
  voidCount: number;
  averageOrderValue: number;
  ordersByHour: HourBucket[];
  salesByHour: HourBucket[];
  platformBreakdown: PlatformBucket[];
  topItems: TopItem[];
  peakHour: number;
  peakHourOrders: number;
  driveThru: DailyDriveThru | null;
}

const HISTORY_DIR = process.env.HISTORY_DIR ?? resolve(process.cwd(), "data", "history");
const MAX_DAYS = 14;

/** In-memory cache of recent daily summaries, keyed by YYYYMMDD. */
const cache = new Map<string, DailySummary>();

function ensureDir(): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function filePath(dateStr: string): string {
  return resolve(HISTORY_DIR, `${dateStr}.json`);
}

/** Load all available history files into memory on startup. */
export function loadHistory(): void {
  ensureDir();
  try {
    const files = readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort();
    // Keep only the most recent MAX_DAYS
    const recent = files.slice(-MAX_DAYS);
    for (const file of recent) {
      try {
        const data = JSON.parse(readFileSync(resolve(HISTORY_DIR, file), "utf-8")) as DailySummary;
        cache.set(data.date, data);
      } catch {
        // skip corrupt files
      }
    }
    console.log(`[History] Loaded ${cache.size} days of history`);
  } catch (err) {
    console.log(`[History] Load error: ${(err as Error).message}`);
  }
}

/** Save a daily summary to disk and memory. */
export function saveSummary(summary: DailySummary): void {
  ensureDir();
  cache.set(summary.date, summary);
  try {
    writeFileSync(filePath(summary.date), JSON.stringify(summary, null, 2), "utf-8");
    console.log(`[History] Saved summary for ${summary.date}`);
  } catch (err) {
    console.log(`[History] Save error: ${(err as Error).message}`);
  }
  // Prune old entries from memory
  const keys = Array.from(cache.keys()).sort();
  while (keys.length > MAX_DAYS) {
    cache.delete(keys.shift()!);
  }
}

/** Get a specific day's summary, or null if not cached. */
export function getSummary(dateStr: string): DailySummary | null {
  return cache.get(dateStr) ?? null;
}

/** Get yesterday's summary. */
export function getYesterday(todayStr: string): DailySummary | null {
  const d = parseDate(todayStr);
  d.setDate(d.getDate() - 1);
  return getSummary(formatDateStr(d));
}

/** Get same day last week's summary. */
export function getSameDayLastWeek(todayStr: string): DailySummary | null {
  const d = parseDate(todayStr);
  d.setDate(d.getDate() - 7);
  return getSummary(formatDateStr(d));
}

/** Get the last N days of summaries (excluding today), most recent first. */
export function getRecentDays(todayStr: string, count: number): DailySummary[] {
  const results: DailySummary[] = [];
  const d = parseDate(todayStr);
  for (let i = 1; i <= count; i++) {
    const check = new Date(d);
    check.setDate(check.getDate() - i);
    const summary = getSummary(formatDateStr(check));
    if (summary) results.push(summary);
  }
  return results;
}

/** Compute a 7-day average for a given day-of-week from history. */
export function getDayOfWeekAverage(todayStr: string): { avgOrders: number; avgSales: number } | null {
  const today = parseDate(todayStr);
  const matching: DailySummary[] = [];

  // Look back up to 28 days for same day-of-week
  for (let i = 7; i <= 28; i += 7) {
    const check = new Date(today);
    check.setDate(check.getDate() - i);
    const summary = getSummary(formatDateStr(check));
    if (summary) matching.push(summary);
  }

  if (matching.length === 0) return null;

  const avgOrders = Math.round(matching.reduce((s, d) => s + d.totalOrders, 0) / matching.length);
  const avgSales = Math.round(matching.reduce((s, d) => s + d.totalSales, 0) / matching.length * 100) / 100;

  return { avgOrders, avgSales };
}

/**
 * Build a DailySummary from raw MCP order data.
 * Call this at end of day (6:30 PM) to snapshot the day.
 */
export async function buildDailySummary(
  mcp: ToastMcpClient,
  dateStr: string,
  timezone: string
): Promise<DailySummary> {
  const raw = await mcp.callToolText("toast_list_orders", {
    businessDate: dateStr,
    detailCount: 200,
  });

  let data: {
    totalOrders?: number;
    totalSales?: number;
    orders?: Array<{
      guid?: string;
      total?: number;
      voided?: boolean;
      openedDate?: string;
      closedDate?: string;
      diningOptionName?: string;
      displayNumber?: string;
      itemCount?: number;
      serverName?: string;
      source?: string;
      items?: Array<{ name?: string }>;
    }>;
  } | null = null;
  try { data = JSON.parse(raw); } catch { /* */ }

  const orders = data?.orders ?? [];
  const valid = orders.filter((o) => !o.voided);
  const voided = orders.filter((o) => o.voided);

  const totalOrders = data?.totalOrders ?? valid.length;
  const totalSales = data?.totalSales ?? valid.reduce((s, o) => s + (o.total ?? 0), 0);
  const averageOrderValue = valid.length > 0 ? Math.round((totalSales / valid.length) * 100) / 100 : 0;

  // Orders and sales by hour
  const hourMap = new Map<number, { orders: number; sales: number }>();
  const hourFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });

  for (const o of valid) {
    if (!o.openedDate) continue;
    const hour = parseInt(hourFormatter.format(new Date(o.openedDate)), 10);
    const bucket = hourMap.get(hour) ?? { orders: 0, sales: 0 };
    bucket.orders++;
    bucket.sales += o.total ?? 0;
    hourMap.set(hour, bucket);
  }

  const ordersByHour: HourBucket[] = [];
  const salesByHour: HourBucket[] = [];
  let peakHour = 0;
  let peakHourOrders = 0;

  for (const [hour, bucket] of Array.from(hourMap.entries()).sort((a, b) => a[0] - b[0])) {
    ordersByHour.push({ hour, orders: bucket.orders, sales: bucket.sales });
    salesByHour.push({ hour, orders: bucket.orders, sales: bucket.sales });
    if (bucket.orders > peakHourOrders) {
      peakHour = hour;
      peakHourOrders = bucket.orders;
    }
  }

  // Platform breakdown
  const PLATFORMS: Record<string, string[]> = {
    DoorDash: ["DoorDash", "DoorDash Delivery", "DoorDash Takeout", "DoorDash - Delivery", "DoorDash - Takeout"],
    "Uber Eats": ["Uber Eats", "Uber Eats - Delivery", "Uber Eats - Takeout", "UberEats", "UberEats Delivery"],
    Grubhub: ["Grubhub", "Grubhub Delivery"],
    Google: ["Google Delivery", "Google Take Out"],
    "Online Ordering": ["Online Ordering", "Online Ordering - Takeout", "Online Ordering - Delivery", "PX Online Ordering", "PX Take Out"],
    "Craver App": ["Craver App"],
    "Toast Delivery": ["Toast Delivery Services"],
    "Drive Thru": ["Drive Thru", "Drive-Thru", "DriveThru", "Drive Through"],
  };

  const platMap = new Map<string, { orders: number; sales: number }>();
  for (const o of valid) {
    const name = o.diningOptionName ?? "";
    let matched = false;
    for (const [platform, names] of Object.entries(PLATFORMS)) {
      if (names.some((n) => name.toLowerCase().includes(n.toLowerCase()))) {
        const b = platMap.get(platform) ?? { orders: 0, sales: 0 };
        b.orders++;
        b.sales += o.total ?? 0;
        platMap.set(platform, b);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const b = platMap.get("In House") ?? { orders: 0, sales: 0 };
      b.orders++;
      b.sales += o.total ?? 0;
      platMap.set("In House", b);
    }
  }

  const platformBreakdown: PlatformBucket[] = Array.from(platMap.entries())
    .map(([platform, b]) => ({ platform, orders: b.orders, sales: Math.round(b.sales * 100) / 100 }))
    .sort((a, b) => b.sales - a.sales);

  // Top items (from item names if available in the data, otherwise from selections)
  // The MCP server returns itemCount but not individual item names in the summary.
  // We'll store an empty array for now; Phase 4 can enrich this.
  const topItems: TopItem[] = [];

  // Drive-thru stats
  const DT_NAMES = ["drive thru", "drive-thru", "drivethru", "drive through"];
  const dtOrders = valid.filter((o) => {
    if (!o.diningOptionName || !o.openedDate || !o.closedDate) return false;
    return DT_NAMES.some((n) => o.diningOptionName!.toLowerCase().includes(n));
  });

  let driveThru: DailyDriveThru | null = null;
  if (dtOrders.length > 0) {
    let dtTotal = 0;
    let dtCount = 0;
    for (const o of dtOrders) {
      const sec = Math.round((new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000);
      if (sec > 0 && sec < 3600) {
        dtTotal += sec;
        dtCount++;
      }
    }
    if (dtCount > 0) {
      driveThru = { count: dtCount, avgSeconds: Math.round(dtTotal / dtCount) };
    }
  }

  const d = parseDate(dateStr);

  return {
    date: dateStr,
    dayOfWeek: d.getDay(),
    totalOrders,
    totalSales: Math.round(totalSales * 100) / 100,
    voidCount: voided.length,
    averageOrderValue,
    ordersByHour,
    salesByHour,
    platformBreakdown,
    topItems,
    peakHour,
    peakHourOrders,
    driveThru,
  };
}

// --- helpers ---

function parseDate(yyyymmdd: string): Date {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return new Date(y, m, d);
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
