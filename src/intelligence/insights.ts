/**
 * Operational intelligence engine.
 * Turns raw order/sales data into actionable insights and recommendations.
 * Every insight answers: What happened? Is it good or bad? What should we do?
 */

import type { DailySummary } from "../cache/history.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---- Sales Performance ----

export interface SalesContext {
  totalOrders: number;
  totalSales: number;
  avgOrder: number;
  voidCount: number;
  yesterday?: DailySummary | null;
  lastWeek?: DailySummary | null;
  dowAvg?: { avgOrders: number; avgSales: number } | null;
  dayOfWeek?: number;
}

export function analyzeSales(ctx: SalesContext): string[] {
  const insights: string[] = [];
  const dayName = ctx.dayOfWeek != null ? DAY_NAMES[ctx.dayOfWeek] : null;

  // Baseline insights when no history is available yet
  const hasHistory = ctx.yesterday || ctx.lastWeek || ctx.dowAvg;
  if (!hasHistory) {
    if (ctx.totalOrders > 0) {
      insights.push(`${ctx.totalOrders} orders at $${ctx.avgOrder.toFixed(2)} average ticket. History is building. Comparisons start tomorrow.`);
    }
    if (ctx.voidCount > 0 && ctx.totalOrders > 0) {
      const voidPct = (ctx.voidCount / ctx.totalOrders) * 100;
      if (voidPct >= 3) {
        insights.push(`${ctx.voidCount} voids (${voidPct.toFixed(1)}%). Worth a quick check with the team.`);
      }
    }
    return insights;
  }

  // vs yesterday
  if (ctx.yesterday) {
    const orderDelta = ctx.totalOrders - ctx.yesterday.totalOrders;
    const orderPct = ctx.yesterday.totalOrders > 0
      ? Math.round((orderDelta / ctx.yesterday.totalOrders) * 100)
      : 0;
    const salesDelta = ctx.totalSales - ctx.yesterday.totalSales;
    const salesPct = ctx.yesterday.totalSales > 0
      ? Math.round((salesDelta / ctx.yesterday.totalSales) * 100)
      : 0;

    if (Math.abs(orderPct) >= 15) {
      if (orderPct > 0) {
        insights.push(`Orders jumped ${orderPct}% vs yesterday. ${salesPct > orderPct ? "Average ticket is up too, so customers are spending more per visit." : "Volume is up but average ticket held steady."}`);
      } else {
        insights.push(`Orders dropped ${Math.abs(orderPct)}% vs yesterday.${Math.abs(orderPct) >= 25 ? " That's a significant dip. Check if anything unusual happened (weather, staffing, POS issues)." : ""}`);
      }
    }

    // Average ticket trend
    if (ctx.yesterday.averageOrderValue > 0) {
      const ticketDelta = ctx.avgOrder - ctx.yesterday.averageOrderValue;
      const ticketPct = Math.round((ticketDelta / ctx.yesterday.averageOrderValue) * 100);
      if (ticketPct >= 10) {
        insights.push(`Average ticket is up ${ticketPct}% to $${ctx.avgOrder.toFixed(2)}. Upselling is working or larger orders are coming in.`);
      } else if (ticketPct <= -10) {
        insights.push(`Average ticket dropped ${Math.abs(ticketPct)}% to $${ctx.avgOrder.toFixed(2)}. Smaller orders are dominating. Consider suggesting add-ons at the register.`);
      }
    }
  }

  // vs day-of-week average
  if (ctx.dowAvg && dayName) {
    const orderDiff = ctx.totalOrders - ctx.dowAvg.avgOrders;
    const orderPct = ctx.dowAvg.avgOrders > 0
      ? Math.round((orderDiff / ctx.dowAvg.avgOrders) * 100)
      : 0;

    if (orderPct >= 10) {
      insights.push(`Running ${orderPct}% above your typical ${dayName}. This is a strong day.`);
    } else if (orderPct <= -10) {
      insights.push(`${Math.abs(orderPct)}% below your typical ${dayName}. If this trend holds, consider adjusting prep levels.`);
    } else {
      insights.push(`Tracking right in line with a normal ${dayName}.`);
    }
  }

  // vs same day last week
  if (ctx.lastWeek && dayName) {
    const orderPct = ctx.lastWeek.totalOrders > 0
      ? Math.round(((ctx.totalOrders - ctx.lastWeek.totalOrders) / ctx.lastWeek.totalOrders) * 100)
      : 0;
    const salesPct = ctx.lastWeek.totalSales > 0
      ? Math.round(((ctx.totalSales - ctx.lastWeek.totalSales) / ctx.lastWeek.totalSales) * 100)
      : 0;

    if (Math.abs(orderPct) >= 5) {
      const dir = orderPct > 0 ? "up" : "down";
      insights.push(`vs last ${dayName}: orders ${dir} ${Math.abs(orderPct)}%, sales ${salesPct >= 0 ? "up" : "down"} ${Math.abs(salesPct)}%.`);
    }
  }

  // Void analysis
  if (ctx.voidCount > 0 && ctx.totalOrders > 0) {
    const voidPct = (ctx.voidCount / ctx.totalOrders) * 100;
    if (voidPct >= 5) {
      insights.push(`Void rate is ${voidPct.toFixed(1)}% (${ctx.voidCount} orders). That's high. Check if it's training issues, POS mistakes, or actual refunds.`);
    } else if (voidPct >= 3) {
      insights.push(`${ctx.voidCount} voids today (${voidPct.toFixed(1)}%). Worth a quick check with the team.`);
    }
  }

  return insights;
}

// ---- Rush Performance ----

export interface RushContext {
  label: string;
  orders: number;
  sales: number;
  peakWindow: string;
  peakCount: number;
  yesterdayOrders?: number;
  yesterdaySales?: number;
}

export function analyzeRush(ctx: RushContext): string[] {
  const insights: string[] = [];

  if (ctx.orders === 0) {
    insights.push(`No orders during the ${ctx.label.toLowerCase()} window. If the shop was open, something may be off.`);
    return insights;
  }

  // vs yesterday's same window
  if (ctx.yesterdayOrders != null && ctx.yesterdayOrders > 0) {
    const pct = Math.round(((ctx.orders - ctx.yesterdayOrders) / ctx.yesterdayOrders) * 100);
    if (pct >= 20) {
      insights.push(`${pct}% busier than yesterday's ${ctx.label.toLowerCase()}. The team is handling volume well.`);
    } else if (pct <= -20) {
      insights.push(`${Math.abs(pct)}% slower than yesterday. If staffing is the same, consider whether some team members could prep for the next rush.`);
    }
  }

  // Peak window insight
  if (ctx.peakWindow && ctx.peakCount > 0) {
    const ordersPerMin = (ctx.peakCount / 15).toFixed(1);
    insights.push(`Busiest 15 minutes: ${ctx.peakWindow} with ${ctx.peakCount} orders (${ordersPerMin}/min). ${ctx.peakCount >= 10 ? "That's heavy. Make sure someone is expediting." : ""}`);
  }

  return insights;
}

// ---- Drive-Thru Speed ----

export interface DriveThruContext {
  avgSeconds: number;
  count: number;
  yesterdayAvg?: number | null;
  slowestWindow?: string;
  slowestWindowAvg?: number;
}

export function analyzeDriveThru(ctx: DriveThruContext): string[] {
  const insights: string[] = [];
  const TARGET = 90;

  if (ctx.count === 0) {
    return ["No completed drive-thru orders to analyze."];
  }

  const overBy = ctx.avgSeconds - TARGET;

  if (overBy <= 0) {
    insights.push(`Crew is hitting the 1:30 standard. Average is ${formatTime(ctx.avgSeconds)}. Keep this energy.`);
  } else if (overBy <= 15) {
    insights.push(`Close but not there yet. Average is ${formatTime(ctx.avgSeconds)}, ${overBy}s over the 1:30 target. Tighten up handoffs and pre-staging.`);
  } else if (overBy <= 45) {
    insights.push(`Average ${formatTime(ctx.avgSeconds)} is ${overBy}s over the 1:30 target. That's a noticeable wait for drive-thru customers. Focus on: start the next drink before the current one leaves the window.`);
  } else {
    insights.push(`Average ${formatTime(ctx.avgSeconds)} is significantly over the 1:30 target. Consider adding a second person to the window during peak, or identify the bottleneck (prep, payment, handoff).`);
  }

  // Trend vs yesterday
  if (ctx.yesterdayAvg != null && ctx.yesterdayAvg > 0) {
    const diff = ctx.avgSeconds - ctx.yesterdayAvg;
    if (diff <= -10) {
      insights.push(`${Math.abs(diff)}s faster than yesterday. The crew is improving.`);
    } else if (diff >= 10) {
      insights.push(`${diff}s slower than yesterday. If it's a staffing issue, tomorrow's schedule should account for it.`);
    }
  }

  return insights;
}

// ---- Marketplace ----

export interface PlatformData {
  platform: string;
  orders: number;
  sales: number;
  lastWeekOrders?: number;
}

export function analyzeMarketplace(
  platforms: PlatformData[],
  totalOrders: number
): string[] {
  const insights: string[] = [];

  const marketplaceOrders = platforms.filter((p) => p.platform !== "In House" && p.platform !== "Drive Thru");
  const marketplaceTotal = marketplaceOrders.reduce((s, p) => s + p.orders, 0);

  if (marketplaceTotal === 0 && totalOrders > 0) {
    insights.push("No marketplace orders today. If you have active listings on DoorDash, Uber Eats, or Grubhub, verify they're live and the store shows as open. Tablets powered on?");
    return insights;
  }

  if (totalOrders > 0) {
    const pct = Math.round((marketplaceTotal / totalOrders) * 100);
    insights.push(`Marketplace is ${pct}% of today's volume (${marketplaceTotal} of ${totalOrders} orders).`);
  }

  // Per-platform week-over-week
  for (const p of marketplaceOrders) {
    if (p.lastWeekOrders != null && p.lastWeekOrders > 0) {
      const pct = Math.round(((p.orders - p.lastWeekOrders) / p.lastWeekOrders) * 100);
      if (pct <= -30) {
        insights.push(`${p.platform} is down ${Math.abs(pct)}% vs last week. Check listing status, ratings, and whether a competitor is running a promo.`);
      } else if (pct >= 30) {
        insights.push(`${p.platform} up ${pct}% vs last week. Whatever you're doing there is working.`);
      }
    }
  }

  return insights;
}

// ---- End of Day ----

export interface EODContext {
  summary: DailySummary;
  yesterday?: DailySummary | null;
  lastWeek?: DailySummary | null;
  dowAvg?: { avgOrders: number; avgSales: number } | null;
}

export function analyzeEndOfDay(ctx: EODContext): string[] {
  const insights: string[] = [];
  const s = ctx.summary;

  // Overall assessment
  const salesInsights = analyzeSales({
    totalOrders: s.totalOrders,
    totalSales: s.totalSales,
    avgOrder: s.averageOrderValue,
    voidCount: s.voidCount,
    yesterday: ctx.yesterday,
    lastWeek: ctx.lastWeek,
    dowAvg: ctx.dowAvg,
    dayOfWeek: s.dayOfWeek,
  });
  insights.push(...salesInsights);

  // Drive-thru
  if (s.driveThru) {
    const dtInsights = analyzeDriveThru({
      avgSeconds: s.driveThru.avgSeconds,
      count: s.driveThru.count,
      yesterdayAvg: ctx.yesterday?.driveThru?.avgSeconds,
    });
    insights.push(...dtInsights);
  }

  // Tomorrow prep recommendation
  if (ctx.dowAvg) {
    const tomorrowDow = (s.dayOfWeek + 1) % 7;
    const tomorrowName = DAY_NAMES[tomorrowDow];
    // Simple heuristic: if today was above average, tomorrow might be too
    if (s.totalOrders > ctx.dowAvg.avgOrders * 1.1) {
      insights.push(`Today ran hot. If ${tomorrowName} follows suit, prep extra. Better to have it and not need it.`);
    }
  }

  return insights;
}

// ---- Forecast ----

export function generateForecast(
  tomorrowDow: number,
  recentSameDow: DailySummary[]
): string[] {
  if (recentSameDow.length === 0) return [];

  const insights: string[] = [];
  const tomorrowName = DAY_NAMES[tomorrowDow];

  const avgOrders = Math.round(
    recentSameDow.reduce((s, d) => s + d.totalOrders, 0) / recentSameDow.length
  );
  const avgSales = Math.round(
    recentSameDow.reduce((s, d) => s + d.totalSales, 0) / recentSameDow.length * 100
  ) / 100;

  insights.push(`Based on ${recentSameDow.length} week(s) of ${tomorrowName} data: expect ~${avgOrders} orders, ~$${avgSales.toFixed(2)} revenue.`);

  // Drive-thru forecast
  const dtDays = recentSameDow.filter((d) => d.driveThru);
  if (dtDays.length > 0) {
    const avgDt = Math.round(
      dtDays.reduce((s, d) => s + d.driveThru!.avgSeconds, 0) / dtDays.length
    );
    if (avgDt > 90) {
      insights.push(`${tomorrowName}s have averaged ${formatTime(avgDt)} drive-thru times. Schedule accordingly to hit the 1:30 target.`);
    }
  }

  return insights;
}

// ---- Helpers ----

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
