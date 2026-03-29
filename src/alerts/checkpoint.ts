/**
 * Unified checkpoint builder.
 * Combines rush recap, labor status, weather context, and
 * Tier 2 watches into a single operations checkpoint message.
 */

import type { ToastMcpClient } from "../mcp/client.js";
import type { BotConfig } from "../config/index.js";
import { rushRecap } from "../reports/index.js";
import { checkLaborStatus } from "./labor-realtime.js";
import { formatWeatherContext } from "./weather.js";

/**
 * Build a comprehensive checkpoint message combining multiple data sources.
 *
 * @param mcp       Toast MCP client instance
 * @param label     Checkpoint label (e.g. "Morning Checkpoint", "Afternoon Checkpoint")
 * @param startHour Start of the rush window to recap
 * @param endHour   End of the rush window to recap
 * @param timezone  IANA timezone string
 * @param config    Bot configuration
 */
export async function buildCheckpoint(
  mcp: ToastMcpClient,
  label: string,
  startHour: number,
  endHour: number,
  timezone: string,
  config: BotConfig
): Promise<string> {
  const dateStr = businessDateInTz(timezone);

  // Gather all sections in parallel
  const [rushReport, laborStatus, weatherCtx] = await Promise.all([
    rushRecap(mcp, `${label}: Rush Recap`, startHour, endHour, timezone),
    checkLaborStatus(mcp, dateStr, timezone),
    formatWeatherContext(),
  ]);

  let text = `**${label}**\n\n`;

  // Rush recap section
  text += rushReport;

  // Labor section
  if (laborStatus) {
    text += `\n\n**Labor Status**\n${laborStatus}`;
  }

  // Weather section
  if (weatherCtx) {
    text += `\n\n${weatherCtx}`;
  }

  // Tier 2 watch summary: flag overtime and breach conditions
  const tier2Notes: string[] = [];

  // Check if labor is approaching breach threshold
  try {
    const shiftRaw = await mcp.callToolText("toast_list_shifts", { businessDate: dateStr });
    let shiftData: {
      laborSummary?: {
        totalLaborCost?: number;
        totalOvertimeHours?: number;
      };
    } | null = null;
    try { shiftData = JSON.parse(shiftRaw); } catch { /* ignore */ }

    const orderRaw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 1,
    });
    let orderData: { totalSales?: number } | null = null;
    try { orderData = JSON.parse(orderRaw); } catch { /* ignore */ }

    const laborCost = shiftData?.laborSummary?.totalLaborCost ?? 0;
    const totalSales = orderData?.totalSales ?? 0;
    const otHours = shiftData?.laborSummary?.totalOvertimeHours ?? 0;

    if (totalSales > 0 && laborCost > 0) {
      const laborPct = laborCost / totalSales;
      const warningThreshold = config.laborBreachPercent * 0.9; // 90% of breach
      if (laborPct >= warningThreshold) {
        const pctDisplay = (laborPct * 100).toFixed(1);
        tier2Notes.push(
          `Labor at ${pctDisplay}% of sales (breach threshold: ${(config.laborBreachPercent * 100).toFixed(0)}%)`
        );
      }
    }

    if (otHours > 1) {
      tier2Notes.push(`${otHours.toFixed(1)} hours of overtime accumulated`);
    }
  } catch {
    // Non critical; skip tier 2 notes if data unavailable
  }

  if (tier2Notes.length > 0) {
    text += `\n\n**Watch Items**\n`;
    for (const note of tier2Notes) {
      text += `• ${note}\n`;
    }
  }

  return text;
}

// ---- Helper ----

function businessDateInTz(tz: string): string {
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
