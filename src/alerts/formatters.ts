/**
 * Alert message formatters for Teams channel posts.
 * All intelligence and existing alert formatters.
 */

import { formatSeconds } from "../intelligence/stats.js";

export interface OrderInfo {
  guid: string;
  displayNumber?: string;
  total: number;
  itemCount: number;
  serverName?: string;
  diningOptionName?: string;
  openedDate?: string;
}

// --- Existing Formatters ---

export function formatLargeOrderAlert(order: OrderInfo): string {
  const num = order.displayNumber ?? order.guid.slice(0, 8);
  let text = `**Large Order Alert**\n\n`;
  text += `Order #${num} just came in: **$${order.total.toFixed(2)}**, **${order.itemCount} items**\n`;
  if (order.serverName) {
    text += `Server: ${order.serverName}\n`;
  }
  if (order.diningOptionName) {
    text += `Dining Option: ${order.diningOptionName}\n`;
  }
  return text;
}

export function formatHighVoidAlert(voidCount: number, windowMinutes: number): string {
  return (
    `**High Void Alert**\n\n` +
    `**${voidCount}** orders voided in the last ${windowMinutes} minutes. ` +
    `Check with the floor team to see if there's an issue.`
  );
}

export function formatLongOpenOrderAlert(
  orders: Array<{
    displayNumber?: string;
    guid: string;
    minutesOpen: number;
    serverName?: string;
  }>
): string {
  let text = `**Long Open Order Alert**\n\n`;
  text += `The following orders have been open 30+ minutes with no close time:\n\n`;
  for (const o of orders) {
    const num = o.displayNumber ?? o.guid.slice(0, 8);
    text += `Order #${num}: **${o.minutesOpen} min** open`;
    if (o.serverName) text += ` (${o.serverName})`;
    text += `\n`;
  }
  text += `\nThese may need attention or may be stuck in the POS.`;
  return text;
}

// --- Drive Thru Prep Note (large order enhancement) ---

export function formatDriveThruPrepNote(itemCount: number): string {
  return (
    `\n**${itemCount} items through drive thru** will take extra time. ` +
    `Consider having a second person assemble while the window keeps moving.`
  );
}

// --- Intelligence Formatters ---

export function formatDtOutlierAlert(
  orderNum: string,
  orderSeconds: number,
  rollingAvg: number,
  windowSize: number
): string {
  return (
    `**Drive Thru Outlier**\n\n` +
    `Order #${orderNum} took **${formatSeconds(orderSeconds)}**. ` +
    `Rolling avg is **${formatSeconds(Math.round(rollingAvg))}** ` +
    `(${windowSize} orders, last 30 min). ` +
    `If this was a complex order, no action needed. If it's a pattern, check the window.`
  );
}

export function formatDtTrendAlert(
  rollingAvg: number,
  windowSize: number,
  dailyAvg: number,
  dailyCount: number
): string {
  return (
    `**Drive Thru Trend Shift**\n\n` +
    `Last 30 min averaging **${formatSeconds(Math.round(rollingAvg))}** (${windowSize} orders). ` +
    `Today's overall: **${formatSeconds(Math.round(dailyAvg))}** (${dailyCount} orders). ` +
    `The window is slowing down. Check if someone is on break or if orders are more complex this hour.`
  );
}

export function formatCombinedDtAlert(
  outlierMsg: string | null,
  trendMsg: string | null
): string {
  if (outlierMsg && trendMsg) {
    return (
      `**Drive Thru Alert**\n\n` +
      outlierMsg.replace("**Drive Thru Outlier**\n\n", "") +
      `\n\n` +
      trendMsg.replace("**Drive Thru Trend Shift**\n\n", "")
    );
  }
  return outlierMsg ?? trendMsg ?? "";
}

export function formatSlowPeriodAlert(
  timeStr: string,
  actualOrders: number,
  expectedOrders: number,
  dayName: string
): string {
  return (
    `**Slow Period**\n\n` +
    `It's ${timeStr} and we've had **${actualOrders} orders** this hour. ` +
    `On a typical ${dayName}, we'd expect **${expectedOrders}** by now. ` +
    `If you're fully staffed, consider having someone prep for the next push.`
  );
}

export function formatPlatformDroughtAlert(
  platform: string,
  minutesSince: number,
  baselineCount: number,
  dayName: string
): string {
  return (
    `**Platform Drought**\n\n` +
    `No ${platform} orders in the last ${minutesSince} minutes. ` +
    `On a typical ${dayName} at this hour, we usually see ${baselineCount} to ${baselineCount + 1}. ` +
    `Check: Is the tablet on? Is the store showing as open on the app?`
  );
}

export function formatRevenuePacingAlert(
  timeStr: string,
  actualSales: number,
  expectedSales: number,
  pctBehind: number,
  dayName: string,
  projectedSales: number | null,
  typicalTotal: number | null
): string {
  let text = `**Revenue Pacing**\n\n`;
  text += `At ${timeStr}, we're at **$${Math.round(actualSales).toLocaleString()}**. `;
  text += `A typical ${dayName} is at **$${Math.round(expectedSales).toLocaleString()}** by now `;
  text += `(**${Math.round(pctBehind * 100)}% behind pace**).`;
  if (projectedSales !== null && typicalTotal !== null) {
    text += ` Projected end of day: ~$${Math.round(projectedSales).toLocaleString()}`;
    text += ` (typical: ~$${Math.round(typicalTotal).toLocaleString()}).`;
  }
  return text;
}

export function formatVoidClusterAlert(
  serverName: string,
  voidCount: number,
  windowSize: number,
  minutesSpan: number
): string {
  return (
    `**Void Cluster**\n\n` +
    `${serverName} has voided **${voidCount} of their last ${windowSize} orders** ` +
    `in the past ${minutesSpan} minutes. ` +
    `This might be training related, a POS issue, or customer changes. Worth a quick check in.`
  );
}

export function formatRushStartAlert(
  rate15min: number,
  baselineRate: number
): string {
  return (
    `**Rush Starting**\n\n` +
    `Order rate just jumped to **${rate15min} per 15 min** (baseline: ${baselineRate.toFixed(1)}). ` +
    `Get ahead of it: pre stage cups, clear the prep area.`
  );
}

export function formatRushEndAlert(
  durationMinutes: number,
  rushOrders: number,
  rushSales: number,
  dtAvgDuringRush: number | null
): string {
  const hours = Math.floor(durationMinutes / 60);
  const mins = durationMinutes % 60;
  const durationStr = hours > 0 ? `${hours} hr ${mins} min` : `${mins} min`;

  let text = `**Rush Winding Down**\n\n`;
  text += `Lasted ~${durationStr}. ${rushOrders} orders, $${Math.round(rushSales).toLocaleString()}.`;
  if (dtAvgDuringRush !== null) {
    text += ` DT avg during rush: ${formatSeconds(dtAvgDuringRush)}.`;
  }
  text += ` Use this downtime to restock and prep.`;
  return text;
}

// --- Proactive Report Formatters ---

export function formatHourlyPulse(
  hourLabel: string,
  orders: number,
  sales: number,
  dtAvg: number | null,
  dtCount: number,
  baseline: {
    avgOrders: number;
    avgSales: number;
    avgDriveThruSeconds: number;
    sampleCount: number;
  } | null,
  dayName: string,
  deviationThreshold: number
): string | null {
  if (!baseline || baseline.sampleCount < 2) {
    if (orders === 0) return null;
    let msg = `**${hourLabel} Pulse**: ${orders} orders, $${Math.round(sales)}.`;
    if (dtAvg !== null && dtCount > 0) {
      msg += ` DT avg ${formatSeconds(Math.round(dtAvg))} (${dtCount} orders).`;
    }
    msg += ` No baseline data yet for comparison.`;
    return msg;
  }

  const orderDev =
    baseline.avgOrders > 0
      ? (orders - baseline.avgOrders) / baseline.avgOrders
      : 0;

  if (Math.abs(orderDev) < deviationThreshold) return null;

  const pct = Math.round(Math.abs(orderDev) * 100);
  const direction = orderDev > 0 ? "above" : "below";

  let msg = `**${hourLabel} Pulse**: ${orders} orders, $${Math.round(sales)}.`;
  if (dtAvg !== null && dtCount > 0) {
    msg += ` DT avg ${formatSeconds(Math.round(dtAvg))} (${dtCount} orders).`;
  }
  msg += ` Tracking ${pct}% ${direction} a typical ${dayName}.`;

  if (orderDev >= 0.2) {
    msg += ` Strong hour.`;
  } else if (orderDev <= -0.2) {
    msg += ` Lighter than usual.`;
  } else if (orderDev > 0) {
    msg += ` Solid.`;
  } else {
    msg += ` Keep an eye on it.`;
  }

  return msg;
}

export function formatShiftPerformance(
  timeLabel: string,
  servers: Array<{
    name: string;
    dtAvg: number;
    dtOrders: number;
    voids: number;
  }>,
  teamAvg: number,
  target: number
): string {
  let text = `**Shift Performance** (${timeLabel})\n\n`;

  for (const s of servers) {
    text += `${s.name}: ${formatSeconds(s.dtAvg)} avg DT (${s.dtOrders} orders), ${s.voids} void${s.voids === 1 ? "" : "s"}\n`;
  }

  const diff = teamAvg - target;
  let commentary: string;
  if (teamAvg <= target) {
    commentary = `Team avg: ${formatSeconds(teamAvg)}. Target: ${formatSeconds(target)}. On target. Keep it up.`;
  } else if (diff <= 15) {
    commentary = `Team avg: ${formatSeconds(teamAvg)}. Target: ${formatSeconds(target)}. Close. Let's tighten it up.`;
  } else {
    commentary = `Team avg: ${formatSeconds(teamAvg)}. Target: ${formatSeconds(target)}. ${diff}s over. Focus on speed this next stretch.`;
  }

  text += `\n${commentary}`;
  return text;
}
