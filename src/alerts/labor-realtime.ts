/**
 * Real time labor and sales projection checks.
 * Calls toast_list_shifts and toast_list_orders via MCP,
 * then returns formatted alert strings for the scheduler.
 */

import type { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import { getRecentDays } from "../cache/history.js";

// ---- Types mirroring MCP responses ----

interface ShiftResponse {
  scheduled?: {
    shifts?: Array<{
      employee?: string;
      job?: string;
      scheduledIn?: string;
      scheduledOut?: string;
    }>;
  };
  actual?: {
    timeEntries?: Array<{
      employee?: string;
      job?: string;
      clockIn?: string;
      clockOut?: string | null;
      regularHours?: number;
      overtimeHours?: number;
      laborCost?: number;
      tips?: number;
    }>;
  };
  laborSummary?: {
    totalHours?: number;
    totalLaborCost?: number;
    totalOvertimeHours?: number;
    employeesWorked?: number;
  };
}

interface OrderCountResponse {
  totalOrders?: number;
  totalSales?: number;
}

// ---- Helpers ----

function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTimeInTz(isoDate: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(isoDate));
}

function getCurrentHourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
    10
  );
}

function getDayOfWeekInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[wd] ?? 0;
}

// ---- Exported check functions ----

/**
 * At store close (7 PM), find employees still clocked in with no clock out.
 */
export async function checkMissedClockOuts(
  mcp: ToastMcpClient,
  dateStr: string,
  timezone: string
): Promise<string | null> {
  try {
    const raw = await mcp.callToolText("toast_list_shifts", { businessDate: dateStr });
    let data: ShiftResponse | null = null;
    try { data = JSON.parse(raw); } catch { /* ignore */ }

    if (!data?.actual?.timeEntries) return null;

    const stillIn = data.actual.timeEntries.filter((e) => !e.clockOut);
    if (stillIn.length === 0) return null;

    let text = `**Missed Clock Out Alert**\n\n`;
    text += `The following employees are still clocked in after close:\n\n`;
    for (const entry of stillIn) {
      const name = entry.employee ?? "Unknown";
      const job = entry.job ?? "N/A";
      const inTime = entry.clockIn ? formatTimeInTz(entry.clockIn, timezone) : "?";
      text += `${name} (${job}): clocked in at ${inTime}, no clock out recorded\n`;
    }
    text += `\nPlease have them clock out or correct their time entries.`;
    return text;
  } catch (err) {
    console.log("[Labor] Missed clock out check failed:", (err as Error).message);
    return null;
  }
}

/**
 * Hourly check: is labor cost exceeding the configured threshold % of sales?
 */
export async function checkLaborBreach(
  mcp: ToastMcpClient,
  dateStr: string,
  timezone: string,
  config: BotConfig
): Promise<string | null> {
  try {
    // Fetch labor data
    const shiftRaw = await mcp.callToolText("toast_list_shifts", { businessDate: dateStr });
    let shiftData: ShiftResponse | null = null;
    try { shiftData = JSON.parse(shiftRaw); } catch { /* ignore */ }

    const laborCost = shiftData?.laborSummary?.totalLaborCost ?? 0;
    if (laborCost === 0) return null;

    // Fetch current sales total
    const orderRaw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 1,
    });
    let orderData: OrderCountResponse | null = null;
    try { orderData = JSON.parse(orderRaw); } catch { /* ignore */ }

    const totalSales = orderData?.totalSales ?? 0;
    if (totalSales === 0) return null;

    const laborPct = laborCost / totalSales;
    if (laborPct <= config.laborBreachPercent) return null;

    const currentHour = getCurrentHourInTz(timezone);
    const pctDisplay = (laborPct * 100).toFixed(1);
    const thresholdDisplay = (config.laborBreachPercent * 100).toFixed(0);

    let text = `**Labor Cost Alert**\n\n`;
    text += `As of ${currentHour}:00, labor is at **${pctDisplay}%** of sales `;
    text += `(threshold: ${thresholdDisplay}%).\n`;
    text += `Labor: ${formatDollars(laborCost)} | Sales: ${formatDollars(totalSales)}\n\n`;

    const totalHours = shiftData?.laborSummary?.totalHours ?? 0;
    const otHours = shiftData?.laborSummary?.totalOvertimeHours ?? 0;
    text += `Total hours: ${totalHours.toFixed(1)}`;
    if (otHours > 0) {
      text += ` (${otHours.toFixed(1)} OT)`;
    }
    text += `\n`;

    text += `Review staffing levels. If the sales pace stays low, consider sending someone home early.`;
    return text;
  } catch (err) {
    console.log("[Labor] Breach check failed:", (err as Error).message);
    return null;
  }
}

/**
 * At noon, project if daily sales will miss the trailing 4 week same day average.
 * Uses fraction of the operating day elapsed (6 AM to 6 PM = 12h).
 */
export async function checkProjectedMiss(
  mcp: ToastMcpClient,
  dateStr: string,
  timezone: string,
  config: BotConfig
): Promise<string | null> {
  try {
    // Current sales
    const orderRaw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 1,
    });
    let orderData: OrderCountResponse | null = null;
    try { orderData = JSON.parse(orderRaw); } catch { /* ignore */ }

    const currentSales = orderData?.totalSales ?? 0;
    if (currentSales === 0) return null;

    // Trailing 4 week same day average
    const dow = getDayOfWeekInTz(timezone);
    const recent = getRecentDays(dateStr, 28);
    const sameDayRecent = recent.filter((r) => r.dayOfWeek === dow);
    if (sameDayRecent.length === 0) return null;

    const avgDailySales =
      sameDayRecent.reduce((s, r) => s + r.totalSales, 0) / sameDayRecent.length;
    if (avgDailySales === 0) return null;

    // Calculate elapsed fraction of operating day (6 AM to 6 PM = 12h)
    const OPEN_HOUR = 6;
    const CLOSE_HOUR = 18;
    const OPERATING_HOURS = CLOSE_HOUR - OPEN_HOUR;

    const currentHour = getCurrentHourInTz(timezone);
    const currentMinute = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        minute: "numeric",
      }).format(new Date()),
      10
    );
    const hoursElapsed = Math.max(0, Math.min(OPERATING_HOURS, (currentHour - OPEN_HOUR) + currentMinute / 60));
    const fractionElapsed = hoursElapsed / OPERATING_HOURS;

    if (fractionElapsed <= 0) return null;

    // Project full day sales from current pace
    const projectedSales = currentSales / fractionElapsed;
    const missPercent = (avgDailySales - projectedSales) / avgDailySales;

    if (missPercent <= config.projectedMissPercent) return null;

    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = DAY_NAMES[dow];
    const missPctDisplay = (missPercent * 100).toFixed(0);

    let text = `**Projected Daily Miss**\n\n`;
    text += `Current sales: ${formatDollars(currentSales)} (${(fractionElapsed * 100).toFixed(0)}% of day elapsed)\n`;
    text += `Projected end of day: ~${formatDollars(projectedSales)}\n`;
    text += `Trailing 4 week ${dayName} average: ${formatDollars(avgDailySales)}\n`;
    text += `Projected shortfall: **${missPctDisplay}% below average** `;
    text += `(based on ${sameDayRecent.length} ${dayName}s)\n\n`;
    text += `Consider promotions, social posts, or checking marketplace tablet status.`;
    return text;
  } catch (err) {
    console.log("[Labor] Projected miss check failed:", (err as Error).message);
    return null;
  }
}

/**
 * Returns overtime warnings, staffing gaps, and labor pacing note
 * for use in checkpoint messages.
 */
export async function checkLaborStatus(
  mcp: ToastMcpClient,
  dateStr: string,
  timezone: string
): Promise<string | null> {
  try {
    const raw = await mcp.callToolText("toast_list_shifts", { businessDate: dateStr });
    let data: ShiftResponse | null = null;
    try { data = JSON.parse(raw); } catch { /* ignore */ }

    if (!data) return null;

    const parts: string[] = [];

    // Overtime warnings
    const otHours = data.laborSummary?.totalOvertimeHours ?? 0;
    if (otHours > 0) {
      parts.push(`**Overtime**: ${otHours.toFixed(1)} hours of OT recorded today`);
    }

    // Staffing gaps: scheduled shifts with no matching clock in
    const scheduled = data.scheduled?.shifts ?? [];
    const entries = data.actual?.timeEntries ?? [];
    const clockedInNames = new Set(
      entries
        .filter((e) => e.clockIn)
        .map((e) => (e.employee ?? "").toLowerCase())
    );

    const noShows: string[] = [];
    for (const shift of scheduled) {
      const name = shift.employee ?? "";
      if (!clockedInNames.has(name.toLowerCase()) && name) {
        // Check if the shift should have started by now
        if (shift.scheduledIn) {
          const scheduledTime = new Date(shift.scheduledIn).getTime();
          const now = Date.now();
          // Only flag if scheduled start was more than 15 min ago
          if (now - scheduledTime > 15 * 60 * 1000) {
            const schedTime = formatTimeInTz(shift.scheduledIn, timezone);
            noShows.push(`${name} (${shift.job ?? "N/A"}, scheduled ${schedTime})`);
          }
        }
      }
    }

    if (noShows.length > 0) {
      parts.push(`**Staffing Gaps**: ${noShows.join(", ")}`);
    }

    // Labor pacing
    const totalHours = data.laborSummary?.totalHours ?? 0;
    const totalCost = data.laborSummary?.totalLaborCost ?? 0;
    const employeeCount = data.laborSummary?.employeesWorked ?? 0;
    if (totalHours > 0) {
      parts.push(
        `**Labor**: ${totalHours.toFixed(1)} hours, ${formatDollars(totalCost)}, ${employeeCount} employees`
      );
    }

    if (parts.length === 0) return null;
    return parts.join("\n");
  } catch (err) {
    console.log("[Labor] Status check failed:", (err as Error).message);
    return null;
  }
}
