/**
 * Report generators for scheduled posting to Teams channels.
 * Each report pulls data from the MCP server, runs it through
 * the intelligence engine, and formats an actionable Teams message.
 */

import { ToastMcpClient } from "../mcp/client.js";
import {
  getYesterday,
  getSameDayLastWeek,
  getDayOfWeekAverage,
  getRecentDays,
  type DailySummary,
} from "../cache/history.js";
import {
  analyzeSales,
  analyzeRush,
  analyzeDriveThru,
  analyzeMarketplace,
  analyzeEndOfDay,
  generateForecast,
  type PlatformData,
} from "../intelligence/insights.js";

const DEFAULT_TZ = "America/Chicago";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- Timezone-aware date utilities ----

/** Get YYYYMMDD in a given timezone. */
function businessDateInTz(tz: string, offsetDays = 0): string {
  const now = new Date();
  if (offsetDays !== 0) {
    now.setTime(now.getTime() + offsetDays * 86400000);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}${m}${d}`;
}

/** Get display date string in a given timezone. */
function displayDateInTz(tz: string, offsetDays = 0): string {
  const now = new Date();
  if (offsetDays !== 0) {
    now.setTime(now.getTime() + offsetDays * 86400000);
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

/** Get the day of week (0=Sun) in a given timezone. */
function dayOfWeekInTz(tz: string, offsetDays = 0): number {
  const now = new Date();
  if (offsetDays !== 0) {
    now.setTime(now.getTime() + offsetDays * 86400000);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

/** Format YYYYMMDD for Toast API (legacy, used by shift roster) */
function businessDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Get the hour (0..23) of an ISO date string in a given timezone. */
function getHourInTimezone(isoDate: string, tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false })
      .format(new Date(isoDate)),
    10
  );
}

function formatDollars(n: number | undefined | null): string {
  if (n == null) return "N/A";
  return `$${n.toFixed(2)}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pctStr(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

const DT_NAMES = ["drive thru", "drive-thru", "drivethru", "drive through"];

/** Compute drive-thru stats from raw order data. */
function computeDriveThru(orders: Array<{
  diningOptionName?: string;
  openedDate?: string;
  closedDate?: string;
  voided?: boolean;
  displayNumber?: string;
  guid?: string;
}>): { avgSeconds: number; count: number; orderTimes: Array<{ num: string; seconds: number }> } | null {
  const dtOrders = orders.filter((o) => {
    if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
    return DT_NAMES.some((n) => o.diningOptionName!.toLowerCase().includes(n));
  });
  if (dtOrders.length === 0) return null;

  let total = 0;
  let count = 0;
  const orderTimes: Array<{ num: string; seconds: number }> = [];

  for (const o of dtOrders) {
    const sec = Math.round((new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000);
    if (sec > 0 && sec < 3600) {
      total += sec;
      count++;
      orderTimes.push({ num: o.displayNumber ?? o.guid?.slice(0, 8) ?? "?", seconds: sec });
    }
  }
  if (count === 0) return null;
  return { avgSeconds: Math.round(total / count), count, orderTimes };
}

// ---- Standard order type used across reports ----

interface OrderData {
  guid?: string;
  displayNumber?: string;
  total?: number;
  voided?: boolean;
  openedDate?: string;
  closedDate?: string;
  diningOption?: string;
  diningOptionName?: string;
  itemCount?: number;
  serverName?: string;
  source?: string;
}

interface OrderResponse {
  totalOrders?: number;
  totalSales?: number;
  detailsFetched?: number;
  orders?: OrderData[];
}

// ======================================================================
// REPORTS
// ======================================================================

/**
 * Previous day sales summary for #finance.
 */
export async function dailySalesSummary(
  mcp: ToastMcpClient,
  timezone = DEFAULT_TZ
): Promise<string> {
  const dateStr = businessDateInTz(timezone, -1);
  const display = displayDateInTz(timezone, -1);
  const dow = dayOfWeekInTz(timezone, -1);
  const dayName = DAY_NAMES[dow];

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      fetchAll: true,
    });

    if (!raw) {
      return `**Daily Sales Summary** (${display})\n\nFailed to connect to Toast MCP server. Check server status.`;
    }

    let data: OrderResponse | null = null;
    try { data = JSON.parse(raw); } catch { /* */ }

    if (!data) {
      return `**Daily Sales Summary** (${display})\n\nInvalid response from Toast MCP server.`;
    }

    if (!data.totalOrders) {
      return `**Daily Sales Summary** (${display})\n\nNo orders recorded for yesterday.`;
    }

    const orders = data.orders ?? [];
    const validOrders = orders.filter((o) => !o.voided);
    const voidCount = orders.filter((o) => o.voided).length;
    const totalSales = data.totalSales ?? 0;
    const avgOrder = validOrders.length > 0 ? totalSales / validOrders.length : 0;

    // Historical context
    const prev = getYesterday(dateStr);
    const lastWeek = getSameDayLastWeek(dateStr);
    const dowAvg = getDayOfWeekAverage(dateStr);

    // --- Build report ---
    let text = `**Daily Sales Summary** (${dayName}, ${display})\n\n`;

    // Core numbers with comparisons
    text += `**Revenue**: ${formatDollars(totalSales)}`;
    if (prev) text += ` (prev day: ${formatDollars(prev.totalSales)}, ${pctStr(totalSales, prev.totalSales)})`;
    text += `\n`;

    text += `**Orders**: ${data.totalOrders}`;
    if (prev) text += ` (prev day: ${prev.totalOrders}, ${pctStr(data.totalOrders, prev.totalOrders)})`;
    text += `\n`;

    text += `**Average Ticket**: ${formatDollars(avgOrder)}\n`;

    if (voidCount > 0) {
      const voidPct = ((voidCount / data.totalOrders) * 100).toFixed(1);
      text += `**Voided**: ${voidCount} (${voidPct}%)\n`;
    }

    if (lastWeek) {
      text += `**vs Last ${dayName}**: Orders ${pctStr(data.totalOrders, lastWeek.totalOrders)}, Sales ${pctStr(totalSales, lastWeek.totalSales)}\n`;
    }

    // Drive-thru
    const dt = computeDriveThru(orders);
    if (dt) {
      const status = dt.avgSeconds <= 150 ? "ON TARGET" : `**${dt.avgSeconds - 150}s OVER**`;
      text += `\n**Drive-Thru**: ${formatTime(dt.avgSeconds)} avg across ${dt.count} orders (target: 2:30) ${status}\n`;
    }

    // Intelligence layer
    const insights = analyzeSales({
      totalOrders: data.totalOrders,
      totalSales,
      avgOrder,
      voidCount,
      yesterday: prev,
      lastWeek,
      dowAvg,
      dayOfWeek: dow,
    });

    if (dt) {
      insights.push(...analyzeDriveThru({
        avgSeconds: dt.avgSeconds,
        count: dt.count,
        yesterdayAvg: prev?.driveThru?.avgSeconds,
      }));
    }

    if (insights.length > 0) {
      text += `\n**What This Means**:\n`;
      for (const insight of insights) {
        text += `${insight}\n`;
      }
    }

    return text;
  } catch (err) {
    return `**Daily Sales Summary** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Marketplace breakdown for #marketplace.
 */
export async function marketplaceBreakdown(
  mcp: ToastMcpClient,
  timezone = DEFAULT_TZ
): Promise<string> {
  const dateStr = businessDateInTz(timezone, -1);
  const display = displayDateInTz(timezone, -1);

  // Matches the actual dining option names from Toast config
  const PLATFORMS: Record<string, string[]> = {
    DoorDash: ["DoorDash", "DoorDash Delivery", "DoorDash Takeout", "DoorDash - Delivery", "DoorDash - Takeout"],
    "Uber Eats": ["Uber Eats", "Uber Eats - Delivery", "Uber Eats - Takeout", "UberEats", "UberEats Delivery"],
    Grubhub: ["Grubhub", "Grubhub Delivery"],
    Google: ["Google Delivery", "Google Take Out"],
    "Online Ordering": ["Online Ordering", "Online Ordering - Takeout", "Online Ordering - Delivery", "PX Online Ordering", "PX Take Out"],
    "Craver App": ["Craver App"],
    "Toast Delivery": ["Toast Delivery Services"],
  };

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      fetchAll: true,
    });

    if (!raw) {
      return `**Marketplace Breakdown** (${display})\n\nFailed to connect to Toast MCP server. Check server status.`;
    }

    let data: OrderResponse | null = null;
    try { data = JSON.parse(raw); } catch { /* */ }

    if (!data || !data.orders || data.orders.length === 0) {
      return `**Marketplace Breakdown** (${display})\n\nNo orders recorded for this date.`;
    }

    const validOrders = data.orders.filter((o) => !o.voided);
    const lastWeek = getSameDayLastWeek(dateStr);
    const lastWeekPlats = lastWeek?.platformBreakdown ?? [];

    // Group orders by platform
    const platformTotals: Record<string, { orders: number; sales: number }> = {};

    for (const order of validOrders) {
      const optionName = order.diningOptionName ?? order.diningOption ?? "";
      let matched = false;

      for (const [platform, names] of Object.entries(PLATFORMS)) {
        if (names.some((n) => optionName.includes(n))) {
          if (!platformTotals[platform]) platformTotals[platform] = { orders: 0, sales: 0 };
          platformTotals[platform].orders++;
          platformTotals[platform].sales += order.total ?? 0;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Check for drive-thru
        if (DT_NAMES.some((n) => optionName.toLowerCase().includes(n))) {
          if (!platformTotals["Drive Thru"]) platformTotals["Drive Thru"] = { orders: 0, sales: 0 };
          platformTotals["Drive Thru"].orders++;
          platformTotals["Drive Thru"].sales += order.total ?? 0;
        } else {
          if (!platformTotals["In House"]) platformTotals["In House"] = { orders: 0, sales: 0 };
          platformTotals["In House"].orders++;
          platformTotals["In House"].sales += order.total ?? 0;
        }
      }
    }

    let text = `**Marketplace Breakdown** (${display})\n\n`;

    const platformDataList: PlatformData[] = [];

    for (const [platform, totals] of Object.entries(platformTotals)) {
      const lwMatch = lastWeekPlats.find((p) => p.platform === platform);
      let comp = "";
      if (lwMatch && lwMatch.orders > 0) {
        comp = ` (last wk: ${lwMatch.orders}, ${pctStr(totals.orders, lwMatch.orders)})`;
      }
      text += `**${platform}**: ${totals.orders} orders, ${formatDollars(totals.sales)}${comp}\n`;
      platformDataList.push({
        platform,
        orders: totals.orders,
        sales: totals.sales,
        lastWeekOrders: lwMatch?.orders,
      });
    }

    text += `\n**Total**: ${validOrders.length} orders, ${formatDollars(data.totalSales)}\n`;

    // Intelligence
    const insights = analyzeMarketplace(platformDataList, validOrders.length);
    if (insights.length > 0) {
      text += `\n**What This Means**:\n`;
      for (const insight of insights) {
        text += `${insight}\n`;
      }
    }

    return text;
  } catch (err) {
    return `**Marketplace Breakdown** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Rush recap with peak window analysis and actionable insights.
 */
export async function rushRecap(
  mcp: ToastMcpClient,
  label: string,
  startHour: number,
  endHour: number,
  timezone = DEFAULT_TZ
): Promise<string> {
  const dateStr = businessDateInTz(timezone);
  const display = displayDateInTz(timezone);

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      fetchAll: true,
    });

    if (!raw) {
      return `**${label}** (${display})\n\nFailed to connect to Toast MCP server. Check server status.`;
    }

    let data: OrderResponse | null = null;
    try { data = JSON.parse(raw); } catch { /* */ }

    if (!data || !data.orders || data.orders.length === 0) {
      return `**${label}** (${display})\n\nNo orders recorded yet for today.`;
    }

    // Filter orders within the time window using timezone-aware hour
    const windowOrders = data.orders.filter((o) => {
      if (o.voided || !o.openedDate) return false;
      const hour = getHourInTimezone(o.openedDate, timezone);
      return hour >= startHour && hour < endHour;
    });

    const windowSales = windowOrders.reduce((sum, o) => sum + (o.total ?? 0), 0);

    // Compare to yesterday's same window from history
    const ySummary = getYesterday(dateStr);
    let yWindowOrders: number | undefined;
    let yWindowSales: number | undefined;
    if (ySummary) {
      const yHours = ySummary.ordersByHour.filter((h) => h.hour >= startHour && h.hour < endHour);
      yWindowOrders = yHours.reduce((s, h) => s + h.orders, 0);
      yWindowSales = yHours.reduce((s, h) => s + h.sales, 0);
    }

    // Find peak 15-min window
    const quarterMap = new Map<string, number>();
    for (const o of windowOrders) {
      if (!o.openedDate) continue;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(new Date(o.openedDate));
      const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const q = Math.floor(min / 15) * 15;
      const key = `${h}:${String(q).padStart(2, "0")}`;
      quarterMap.set(key, (quarterMap.get(key) ?? 0) + 1);
    }

    let peakWindow = "";
    let peakCount = 0;
    for (const [key, count] of quarterMap) {
      if (count > peakCount) { peakCount = count; peakWindow = key; }
    }

    // Format peak window end time
    let peakWindowDisplay = "";
    if (peakWindow && peakCount > 0) {
      const [ph, pm] = peakWindow.split(":").map(Number);
      const endMin = pm + 15;
      const endH = endMin >= 60 ? ph + 1 : ph;
      const endM = endMin >= 60 ? endMin - 60 : endMin;
      peakWindowDisplay = `${peakWindow} to ${endH}:${String(endM).padStart(2, "0")}`;
    }

    // --- Build report ---
    let text = `**${label}** (${display})\n\n`;

    text += `**Orders**: ${windowOrders.length}`;
    if (yWindowOrders != null) text += ` (yesterday: ${yWindowOrders}, ${pctStr(windowOrders.length, yWindowOrders)})`;
    text += `\n`;

    text += `**Sales**: ${formatDollars(windowSales)}`;
    if (yWindowSales != null) text += ` (yesterday: ${formatDollars(yWindowSales)}, ${pctStr(windowSales, yWindowSales)})`;
    text += `\n`;

    if (windowOrders.length > 0) {
      text += `**Average**: ${formatDollars(windowSales / windowOrders.length)}\n`;
    }

    if (peakWindowDisplay) {
      text += `**Peak**: ${peakWindowDisplay} (${peakCount} orders)\n`;
    }

    // Drive-thru section (all day, not just rush window)
    const dt = computeDriveThru(data.orders);
    if (dt) {
      const status = dt.avgSeconds <= 150 ? "ON TARGET" : `**${dt.avgSeconds - 150}s OVER**`;
      text += `\n**Drive-Thru Today**: ${formatTime(dt.avgSeconds)} avg across ${dt.count} orders ${status}\n`;
    }

    // Intelligence
    const rushInsights = analyzeRush({
      label,
      orders: windowOrders.length,
      sales: windowSales,
      peakWindow: peakWindowDisplay,
      peakCount,
      yesterdayOrders: yWindowOrders,
      yesterdaySales: yWindowSales,
    });

    if (dt) {
      rushInsights.push(...analyzeDriveThru({
        avgSeconds: dt.avgSeconds,
        count: dt.count,
        yesterdayAvg: ySummary?.driveThru?.avgSeconds,
      }));
    }

    if (rushInsights.length > 0) {
      text += `\n**What This Means**:\n`;
      for (const insight of rushInsights) {
        text += `${insight}\n`;
      }
    }

    return text;
  } catch (err) {
    return `**${label}** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * End of Day Summary with full analysis and tomorrow forecast.
 */
export async function endOfDaySummary(
  _mcp: ToastMcpClient,
  _timezone: string,
  todaySummary: DailySummary
): Promise<string> {
  const dateStr = todaySummary.date;
  const d = new Date(
    parseInt(dateStr.slice(0, 4)),
    parseInt(dateStr.slice(4, 6)) - 1,
    parseInt(dateStr.slice(6, 8))
  );
  const display = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const dayName = DAY_NAMES[d.getDay()];

  const prev = getYesterday(dateStr);
  const lastWeek = getSameDayLastWeek(dateStr);
  const dowAvg = getDayOfWeekAverage(dateStr);

  // --- Build report ---
  let text = `**End of Day Summary** (${dayName}, ${display})\n\n`;

  // Core numbers
  text += `**Revenue**: ${formatDollars(todaySummary.totalSales)}`;
  if (prev) text += ` (yesterday: ${formatDollars(prev.totalSales)}, ${pctStr(todaySummary.totalSales, prev.totalSales)})`;
  text += `\n`;

  text += `**Orders**: ${todaySummary.totalOrders}`;
  if (prev) text += ` (yesterday: ${prev.totalOrders}, ${pctStr(todaySummary.totalOrders, prev.totalOrders)})`;
  text += `\n`;

  text += `**Average Ticket**: ${formatDollars(todaySummary.averageOrderValue)}\n`;

  if (todaySummary.voidCount > 0) {
    const voidPct = ((todaySummary.voidCount / todaySummary.totalOrders) * 100).toFixed(1);
    text += `**Voided**: ${todaySummary.voidCount} (${voidPct}%)\n`;
  }

  if (lastWeek) {
    text += `**vs Last ${dayName}**: Orders ${pctStr(todaySummary.totalOrders, lastWeek.totalOrders)}, Sales ${pctStr(todaySummary.totalSales, lastWeek.totalSales)}\n`;
  }

  if (dowAvg) {
    text += `**vs ${dayName} Avg**: Orders ${pctStr(todaySummary.totalOrders, dowAvg.avgOrders)}, Sales ${pctStr(todaySummary.totalSales, dowAvg.avgSales)}\n`;
  }

  // Platform breakdown
  if (todaySummary.platformBreakdown.length > 0) {
    text += `\n**By Channel**:\n`;
    for (const p of todaySummary.platformBreakdown) {
      text += `${p.platform}: ${p.orders} orders, ${formatDollars(p.sales)}\n`;
    }
  }

  // Peak hour
  if (todaySummary.peakHourOrders > 0) {
    text += `\n**Peak Hour**: ${todaySummary.peakHour}:00 to ${todaySummary.peakHour + 1}:00 (${todaySummary.peakHourOrders} orders)\n`;
  }

  // Drive-thru
  if (todaySummary.driveThru) {
    const dt = todaySummary.driveThru;
    const status = dt.avgSeconds <= 150 ? "ON TARGET" : `**${dt.avgSeconds - 150}s OVER**`;
    text += `\n**Drive-Thru**: ${formatTime(dt.avgSeconds)} avg across ${dt.count} orders ${status}\n`;
  }

  // Intelligence layer
  const insights = analyzeEndOfDay({
    summary: todaySummary,
    yesterday: prev,
    lastWeek,
    dowAvg,
  });

  // Tomorrow forecast
  const tomorrowDow = (d.getDay() + 1) % 7;
  const recent = getRecentDays(dateStr, 28);
  const tomorrowMatches = recent.filter((r) => r.dayOfWeek === tomorrowDow);
  const forecastInsights = generateForecast(tomorrowDow, tomorrowMatches);
  insights.push(...forecastInsights);

  if (insights.length > 0) {
    text += `\n**What This Means**:\n`;
    for (const insight of insights) {
      text += `${insight}\n`;
    }
  }

  return text;
}

/**
 * Shift roster (placeholder until toast_list_shifts is added).
 */
export async function shiftRoster(mcp: ToastMcpClient): Promise<string> {
  const today = new Date();
  const display = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  const tools = mcp.getTools();
  const hasLabor = tools.some((t) => t.name.includes("labor") || t.name.includes("shift"));

  if (!hasLabor) {
    return (
      `**Shift Roster** (${display})\n\n` +
      `Labor tools not yet available on the MCP server. ` +
      `Add toast_list_shifts to enable this report.`
    );
  }

  try {
    const raw = await mcp.callToolText("toast_list_shifts", { businessDate: businessDate(today) });
    return `**Shift Roster** (${display})\n\n${raw}`;
  } catch (err) {
    return `**Shift Roster** (${display})\n\nFailed: ${(err as Error).message}`;
  }
}

/**
 * 86'd item check.
 */
export async function check86d(
  mcp: ToastMcpClient,
  previous86d: Set<string>
): Promise<{ message: string | null; current86d: Set<string> }> {
  const tools = mcp.getTools();
  const hasStock = tools.some((t) => t.name.includes("stock") || t.name.includes("inventory"));

  if (!hasStock) {
    return { message: null, current86d: previous86d };
  }

  try {
    const raw = await mcp.callToolText("toast_get_stock");
    let data: { items?: Array<{ name: string; guid: string; quantity?: number; status?: string }> } | null = null;
    try { data = JSON.parse(raw); } catch { /* */ }

    if (!data?.items) return { message: null, current86d: previous86d };

    const current86d = new Set<string>();
    const newly86d: string[] = [];

    for (const item of data.items) {
      if (item.status === "OUT_OF_STOCK" || (item.quantity != null && item.quantity <= 0)) {
        current86d.add(item.guid);
        if (!previous86d.has(item.guid)) {
          newly86d.push(item.name);
        }
      }
    }

    if (newly86d.length === 0) return { message: null, current86d };

    const text =
      `**86'd Alert**\n\n` +
      `The following items are now out of stock:\n` +
      newly86d.map((name) => `**${name}**`).join("\n") +
      `\n\nUpdate the POS and let the team know so they stop promising these to customers.`;

    return { message: text, current86d };
  } catch {
    return { message: null, current86d: previous86d };
  }
}
