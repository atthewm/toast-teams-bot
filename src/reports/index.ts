/**
 * Report generators for scheduled posting to Teams channels.
 * Each function pulls data from the MCP server and formats a Teams message.
 * Reports include historical comparisons when cache data is available.
 */

import { ToastMcpClient } from "../mcp/client.js";
import {
  getYesterday,
  getSameDayLastWeek,
  getDayOfWeekAverage,
  getRecentDays,
  type DailySummary,
} from "../cache/history.js";

/** Format YYYYMMDD for Toast API businessDate param */
function businessDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Get the hour (0..23) of an ISO date string in a given timezone. */
function getHourInTimezone(isoDate: string, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  return parseInt(formatter.format(new Date(isoDate)), 10);
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function formatDollars(n: number | undefined | null): string {
  if (n == null) return "N/A";
  return `$${n.toFixed(2)}`;
}

/** Format a comparison: "108 (yesterday: 95, +13.7% up)" */
function compareNum(current: number, previous: number | undefined, label: string): string {
  if (previous == null || previous === 0) return "";
  const pctChange = ((current - previous) / previous) * 100;
  const direction = pctChange >= 0 ? "up" : "down";
  const sign = pctChange >= 0 ? "+" : "";
  return ` (${label}: ${previous}, ${sign}${pctChange.toFixed(1)}% ${direction})`;
}

function compareDollars(current: number, previous: number | undefined, label: string): string {
  if (previous == null || previous === 0) return "";
  const pctChange = ((current - previous) / previous) * 100;
  const direction = pctChange >= 0 ? "up" : "down";
  const sign = pctChange >= 0 ? "+" : "";
  return ` (${label}: ${formatDollars(previous)}, ${sign}${pctChange.toFixed(1)}% ${direction})`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Previous day sales summary for #finance with historical comparisons.
 */
export async function dailySalesSummary(mcp: ToastMcpClient): Promise<string> {
  const date = yesterday();
  const dateStr = businessDate(date);
  const display = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 200,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        diningOption?: string;
        openedDate?: string;
        closedDate?: string;
        diningOptionName?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.totalOrders) {
      return `**Daily Sales Summary** (${display})\n\nNo order data available for yesterday.`;
    }

    const validOrders = data.orders?.filter((o) => !o.voided) ?? [];
    const voidCount = data.orders?.filter((o) => o.voided).length ?? 0;
    const avgOrder =
      validOrders.length > 0 && data.totalSales
        ? data.totalSales / validOrders.length
        : 0;
    const voidPct = data.totalOrders > 0 ? ((voidCount / data.totalOrders) * 100).toFixed(1) : "0";

    // Historical comparisons
    const twoDaysAgo = getYesterday(dateStr);
    const lastWeek = getSameDayLastWeek(dateStr);

    let text = `**Daily Sales Summary** (${display})\n\n`;
    text += `Total Orders: **${data.totalOrders}**${compareNum(data.totalOrders, twoDaysAgo?.totalOrders, "prev day")}\n`;
    text += `Total Sales: **${formatDollars(data.totalSales)}**${compareDollars(data.totalSales!, twoDaysAgo?.totalSales, "prev day")}\n`;
    text += `Average Order: **${formatDollars(avgOrder)}**\n`;
    text += `Voided: ${voidCount} (${voidPct}%)\n`;

    if (lastWeek) {
      const orderPct = lastWeek.totalOrders > 0
        ? (((data.totalOrders - lastWeek.totalOrders) / lastWeek.totalOrders) * 100).toFixed(0)
        : "N/A";
      const salesPct = lastWeek.totalSales > 0
        ? (((data.totalSales! - lastWeek.totalSales) / lastWeek.totalSales) * 100).toFixed(0)
        : "N/A";
      text += `\nvs. Same Day Last Week: Orders ${orderPct}%, Sales ${salesPct}%`;
    }

    // Drive-thru speed for yesterday
    const DT_NAMES = ["drive thru", "drive-thru", "drivethru", "drive through"];
    const dtOrders = (data.orders ?? []).filter((o) => {
      if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
      return DT_NAMES.some((n) => o.diningOptionName!.toLowerCase().includes(n));
    });
    if (dtOrders.length > 0) {
      let dtTotal = 0;
      let dtCount = 0;
      for (const o of dtOrders) {
        const sec = Math.round((new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000);
        if (sec > 0 && sec < 3600) { dtTotal += sec; dtCount++; }
      }
      if (dtCount > 0) {
        const avgSec = Math.round(dtTotal / dtCount);
        const status = avgSec <= 90 ? "ON TARGET" : `**${avgSec - 90}s OVER**`;
        text += `\n\n**Drive-Thru**: avg **${formatTime(avgSec)}** across ${dtCount} orders (target: 1:30) ${status}`;
      }
    }

    return text;
  } catch (err) {
    return `**Daily Sales Summary** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Marketplace breakdown (DoorDash, Uber Eats, Grubhub) for #marketplace.
 */
export async function marketplaceBreakdown(mcp: ToastMcpClient): Promise<string> {
  const date = yesterday();
  const dateStr = businessDate(date);
  const display = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

  const PLATFORMS: Record<string, string[]> = {
    DoorDash: ["DoorDash", "DoorDash Delivery", "DoorDash Takeout"],
    "Uber Eats": [
      "Uber Eats Delivery",
      "Uber Eats Takeout",
      "UberEats",
      "UberEats Delivery",
    ],
    Grubhub: ["Grubhub", "Grubhub Delivery"],
  };

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 200,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        diningOption?: string;
        diningOptionName?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.orders) {
      return `**Marketplace Breakdown** (${display})\n\nNo order data available.`;
    }

    const validOrders = data.orders.filter((o) => !o.voided);

    // Group orders by platform
    const platformTotals: Record<string, { orders: number; sales: number }> = {};
    let inHouseOrders = 0;
    let inHouseSales = 0;

    for (const order of validOrders) {
      const optionName = order.diningOptionName ?? order.diningOption ?? "";
      let matched = false;

      for (const [platform, names] of Object.entries(PLATFORMS)) {
        if (names.some((n) => optionName.includes(n))) {
          if (!platformTotals[platform]) {
            platformTotals[platform] = { orders: 0, sales: 0 };
          }
          platformTotals[platform].orders++;
          platformTotals[platform].sales += order.total ?? 0;
          matched = true;
          break;
        }
      }

      if (!matched) {
        inHouseOrders++;
        inHouseSales += order.total ?? 0;
      }
    }

    // Historical comparison for platform breakdown
    const lastWeek = getSameDayLastWeek(dateStr);
    const lastWeekPlats = lastWeek?.platformBreakdown ?? [];

    let text = `**Marketplace Breakdown** (${display})\n\n`;

    for (const [platform, totals] of Object.entries(platformTotals)) {
      const lwMatch = lastWeekPlats.find((p) => p.platform === platform);
      const comp = lwMatch ? compareNum(totals.orders, lwMatch.orders, "last wk") : "";
      text += `**${platform}**: ${totals.orders} orders, ${formatDollars(totals.sales)}${comp}\n`;
    }

    text += `**In House**: ${inHouseOrders} orders, ${formatDollars(inHouseSales)}\n`;
    text += `\nTotal: **${validOrders.length}** orders, **${formatDollars(data.totalSales)}**`;

    return text;
  } catch (err) {
    return `**Marketplace Breakdown** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Rush recap: orders within a time window for today, with comparisons.
 */
export async function rushRecap(
  mcp: ToastMcpClient,
  label: string,
  startHour: number,
  endHour: number,
  timezone = "America/Chicago"
): Promise<string> {
  const today = new Date();
  const dateStr = businessDate(today);
  const display = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 200,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        openedDate?: string;
        closedDate?: string;
        diningOptionName?: string;
        displayNumber?: string;
        guid?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.orders) {
      return `**${label}** (${display})\n\nNo order data available.`;
    }

    // Filter orders within the time window using timezone-aware hour
    const windowOrders = data.orders.filter((o) => {
      if (o.voided || !o.openedDate) return false;
      const hour = getHourInTimezone(o.openedDate, timezone);
      return hour >= startHour && hour < endHour;
    });

    const windowSales = windowOrders.reduce(
      (sum, o) => sum + (o.total ?? 0),
      0
    );

    // Compare to yesterday's same window from history
    const ySummary = getYesterday(dateStr);
    let yWindowOrders: number | undefined;
    let yWindowSales: number | undefined;
    if (ySummary) {
      const yHours = ySummary.ordersByHour.filter(
        (h) => h.hour >= startHour && h.hour < endHour
      );
      yWindowOrders = yHours.reduce((s, h) => s + h.orders, 0);
      yWindowSales = yHours.reduce((s, h) => s + h.sales, 0);
    }

    // Find peak 15-min window (group by quarter-hour)
    const quarterMap = new Map<string, number>();
    for (const o of windowOrders) {
      if (!o.openedDate) continue;
      const d = new Date(o.openedDate);
      const hourFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });
      const parts = hourFormatter.formatToParts(d);
      const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
      const q = Math.floor(min / 15) * 15;
      const key = `${h}:${String(q).padStart(2, "0")}`;
      quarterMap.set(key, (quarterMap.get(key) ?? 0) + 1);
    }

    let peakWindow = "";
    let peakCount = 0;
    for (const [key, count] of quarterMap) {
      if (count > peakCount) {
        peakCount = count;
        peakWindow = key;
      }
    }

    let text = `**${label}** (${display})\n\n`;
    text += `Orders: **${windowOrders.length}**${compareNum(windowOrders.length, yWindowOrders, "yesterday")}\n`;
    text += `Sales: **${formatDollars(windowSales)}**${compareDollars(windowSales, yWindowSales, "yesterday")}\n`;

    if (windowOrders.length > 0) {
      const avg = windowSales / windowOrders.length;
      text += `Average: **${formatDollars(avg)}**\n`;
    }

    if (peakWindow && peakCount > 0) {
      // Calculate end of peak window
      const [ph, pm] = peakWindow.split(":").map(Number);
      const endMin = pm + 15;
      const endH = endMin >= 60 ? ph + 1 : ph;
      const endM = endMin >= 60 ? endMin - 60 : endMin;
      text += `Peak Window: ${peakWindow} to ${endH}:${String(endM).padStart(2, "0")} (${peakCount} orders)\n`;
    }

    // Drive-thru speed section (uses ALL orders for the day, not just the rush window)
    const DT_NAMES = ["drive thru", "drive-thru", "drivethru", "drive through"];
    const dtOrders = (data.orders ?? []).filter((o) => {
      if (!o.diningOptionName || !o.openedDate || !o.closedDate || o.voided) return false;
      return DT_NAMES.some((n) => o.diningOptionName!.toLowerCase().includes(n));
    });

    if (dtOrders.length > 0) {
      let dtTotal = 0;
      let dtCount = 0;
      for (const o of dtOrders) {
        const sec = Math.round(
          (new Date(o.closedDate!).getTime() - new Date(o.openedDate!).getTime()) / 1000
        );
        if (sec > 0 && sec < 3600) {
          dtTotal += sec;
          dtCount++;
        }
      }
      if (dtCount > 0) {
        const avgSec = Math.round(dtTotal / dtCount);
        const status = avgSec <= 90 ? "ON TARGET" : `**${avgSec - 90}s OVER**`;
        // Compare to yesterday's drive-thru if available
        let dtComp = "";
        if (ySummary?.driveThru) {
          const diff = avgSec - ySummary.driveThru.avgSeconds;
          const direction = diff <= 0 ? "faster" : "slower";
          dtComp = ` (yesterday: ${formatTime(ySummary.driveThru.avgSeconds)}, ${Math.abs(diff)}s ${direction})`;
        }
        text += `\n**Drive-Thru**: avg **${formatTime(avgSec)}** across ${dtCount} orders (target: 1:30) ${status}${dtComp}`;
      }
    }

    return text;
  } catch (err) {
    return `**${label}** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * End of Day Summary: comprehensive day-in-review for #finance and #ops at 6:30 PM.
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

  const voidPct = todaySummary.totalOrders > 0
    ? ((todaySummary.voidCount / todaySummary.totalOrders) * 100).toFixed(1)
    : "0";

  let text = `**End of Day Summary** (${dayName}, ${display})\n\n`;

  // Revenue and orders
  text += `**Revenue**: ${formatDollars(todaySummary.totalSales)}${compareDollars(todaySummary.totalSales, prev?.totalSales, "yesterday")}\n`;
  text += `**Orders**: ${todaySummary.totalOrders}${compareNum(todaySummary.totalOrders, prev?.totalOrders, "yesterday")}\n`;
  text += `**Average Order**: ${formatDollars(todaySummary.averageOrderValue)}\n`;
  text += `**Voided**: ${todaySummary.voidCount} (${voidPct}%)\n`;

  // Week-over-week
  if (lastWeek) {
    const orderPct = lastWeek.totalOrders > 0
      ? `${(((todaySummary.totalOrders - lastWeek.totalOrders) / lastWeek.totalOrders) * 100).toFixed(0)}%`
      : "N/A";
    const salesPct = lastWeek.totalSales > 0
      ? `${(((todaySummary.totalSales - lastWeek.totalSales) / lastWeek.totalSales) * 100).toFixed(0)}%`
      : "N/A";
    text += `\nvs. Last ${dayName}: Orders ${orderPct}, Sales ${salesPct}\n`;
  }

  // Day-of-week average
  if (dowAvg) {
    const orderDiff = todaySummary.totalOrders - dowAvg.avgOrders;
    const salesDiff = todaySummary.totalSales - dowAvg.avgSales;
    text += `vs. ${dayName} Average: Orders ${orderDiff >= 0 ? "+" : ""}${orderDiff}, Sales ${salesDiff >= 0 ? "+" : ""}${formatDollars(salesDiff)}\n`;
  }

  // Platform breakdown
  if (todaySummary.platformBreakdown.length > 0) {
    text += `\n**By Channel**:\n`;
    for (const p of todaySummary.platformBreakdown) {
      const lwMatch = lastWeek?.platformBreakdown.find((lp) => lp.platform === p.platform);
      const comp = lwMatch ? compareNum(p.orders, lwMatch.orders, "last wk") : "";
      text += `${p.platform}: ${p.orders} orders, ${formatDollars(p.sales)}${comp}\n`;
    }
  }

  // Peak hour
  if (todaySummary.peakHourOrders > 0) {
    const endHour = todaySummary.peakHour + 1;
    text += `\n**Peak Hour**: ${todaySummary.peakHour}:00 to ${endHour}:00 (${todaySummary.peakHourOrders} orders)\n`;
  }

  // Drive-thru
  if (todaySummary.driveThru) {
    const dt = todaySummary.driveThru;
    const status = dt.avgSeconds <= 90 ? "ON TARGET" : `**${dt.avgSeconds - 90}s OVER**`;
    let dtComp = "";
    if (prev?.driveThru) {
      const diff = dt.avgSeconds - prev.driveThru.avgSeconds;
      const direction = diff <= 0 ? "faster" : "slower";
      dtComp = ` (yesterday: ${formatTime(prev.driveThru.avgSeconds)}, ${Math.abs(diff)}s ${direction})`;
    }
    text += `\n**Drive-Thru**: avg **${formatTime(dt.avgSeconds)}** across ${dt.count} orders (target: 1:30) ${status}${dtComp}`;
    text += `\n**Every order through in 1:30. That's the standard.**`;
  }

  // Tomorrow forecast based on day-of-week history
  const tomorrow = new Date(d);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDow = tomorrow.getDay();
  const tomorrowName = DAY_NAMES[tomorrowDow];

  // Look for same day-of-week in recent history
  const recent = getRecentDays(dateStr, 28);
  const tomorrowMatches = recent.filter((r) => r.dayOfWeek === tomorrowDow);
  if (tomorrowMatches.length > 0) {
    const avgOrders = Math.round(
      tomorrowMatches.reduce((s, r) => s + r.totalOrders, 0) / tomorrowMatches.length
    );
    const avgSales = Math.round(
      tomorrowMatches.reduce((s, r) => s + r.totalSales, 0) / tomorrowMatches.length * 100
    ) / 100;
    text += `\n\n**Tomorrow Forecast** (${tomorrowName}, based on ${tomorrowMatches.length} week avg): ~${avgOrders} orders, ~${formatDollars(avgSales)}`;
  }

  return text;
}

/**
 * Shift roster: who's working today. Requires labor tools on MCP server.
 * Currently a placeholder until toast_list_shifts is added.
 */
export async function shiftRoster(mcp: ToastMcpClient): Promise<string> {
  const today = new Date();
  const display = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  // Check if labor tool exists
  const tools = mcp.getTools();
  const hasLabor = tools.some(
    (t) => t.name.includes("labor") || t.name.includes("shift")
  );

  if (!hasLabor) {
    return (
      `**Shift Roster** (${display})\n\n` +
      `Labor tools not yet available on the MCP server. ` +
      `Add toast_list_shifts to enable this report.`
    );
  }

  try {
    const raw = await mcp.callToolText("toast_list_shifts", {
      businessDate: businessDate(today),
    });
    return `**Shift Roster** (${display})\n\n${raw}`;
  } catch (err) {
    return `**Shift Roster** (${display})\n\nFailed: ${(err as Error).message}`;
  }
}

/**
 * 86'd item check: polls stock endpoint for out of stock items.
 * Requires toast_get_stock tool on MCP server.
 */
export async function check86d(
  mcp: ToastMcpClient,
  previous86d: Set<string>
): Promise<{ message: string | null; current86d: Set<string> }> {
  const tools = mcp.getTools();
  const hasStock = tools.some(
    (t) => t.name.includes("stock") || t.name.includes("inventory")
  );

  if (!hasStock) {
    return { message: null, current86d: previous86d };
  }

  try {
    const raw = await mcp.callToolText("toast_get_stock");
    let data: {
      items?: Array<{
        name: string;
        guid: string;
        quantity?: number;
        status?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data?.items) {
      return { message: null, current86d: previous86d };
    }

    const current86d = new Set<string>();
    const newly86d: string[] = [];

    for (const item of data.items) {
      if (
        item.status === "OUT_OF_STOCK" ||
        (item.quantity != null && item.quantity <= 0)
      ) {
        current86d.add(item.guid);
        if (!previous86d.has(item.guid)) {
          newly86d.push(item.name);
        }
      }
    }

    if (newly86d.length === 0) {
      return { message: null, current86d };
    }

    const text =
      `**86'd Alert**\n\n` +
      `The following items are now out of stock:\n` +
      newly86d.map((name) => `**${name}**`).join("\n");

    return { message: text, current86d };
  } catch {
    return { message: null, current86d: previous86d };
  }
}
