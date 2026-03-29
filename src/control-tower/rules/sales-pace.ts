/**
 * Sales Pace alert rule.
 *
 * Fetches today's partial day orders from Toast, computes the
 * current sales pace, and compares it to the configured daily
 * target and/or trailing average. Alerts if materially off track.
 *
 * Note: this duplicates the existing revenue_pacing alert in
 * the real time monitor. Marked accordingly so the dispatcher
 * can choose which system takes precedence.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';
import type { Severity } from '../models.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface OrderEntry {
  guid?: string;
  totalAmount?: number;
  amount?: number;
  total?: number;
  voided?: boolean;
  deleted?: boolean;
  openedDate?: string;
}

function getHourInTimezone(tz: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

function getMinuteInTimezone(tz: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    minute: 'numeric',
  });
  return parseInt(formatter.format(new Date()), 10);
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class SalesPaceRule implements RuleHandler {
  id = 'sales_pace';
  name = 'Sales Pace Monitor';
  family = 'salesPace';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };
    const thresholds = ctx.config.thresholds.salesPace;
    const primeCostThresholds = ctx.config.thresholds.primeCost;

    /* Only run during business hours */
    const currentHour = getHourInTimezone(ctx.timezone);
    if (currentHour < 7 || currentHour >= 18) {
      return { ...nonFiring, note: 'Outside business hours. Skipping sales pace check.' };
    }

    /* Only run at configured check hours */
    if (!thresholds.checkHours.includes(currentHour)) {
      return { ...nonFiring, note: `Current hour (${currentHour}) is not a configured check hour.` };
    }

    try {
      /* 1. Fetch today's orders */
      const ordersData = await ctx.toastMcp.callToolJson<{ orders?: OrderEntry[]; totalOrders?: number }>(
        'toast_list_orders',
        { businessDate: ctx.todayStr, fetchAll: true }
      );
      const orders = ordersData?.orders ?? [];
      const valid = orders.filter(o => !o.voided && !o.deleted);
      const currentSales = valid.reduce((sum, o) => sum + (o.totalAmount ?? o.amount ?? o.total ?? 0), 0);
      const orderCount = valid.length;

      if (orderCount === 0) {
        return { ...nonFiring, note: 'No orders yet today. Skipping pace check.' };
      }

      /* 2. Compute pace */
      // Assume business day runs 6 AM to 6 PM (12 hours)
      const openHour = 6;
      const closeHour = 18;
      const totalBusinessHours = closeHour - openHour;

      const currentMinute = getMinuteInTimezone(ctx.timezone);
      const hoursElapsed = (currentHour - openHour) + (currentMinute / 60);

      if (hoursElapsed <= 0) {
        return { ...nonFiring, note: 'Business day has not started yet.' };
      }

      const fractionOfDay = hoursElapsed / totalBusinessHours;
      const projectedDaySales = currentSales / fractionOfDay;

      /* 3. Compare to daily target */
      const dailyTarget = primeCostThresholds.dailySalesTarget;
      let salesDeviation = 0;
      let behindTarget = false;

      if (dailyTarget > 0) {
        const expectedAtThisPoint = dailyTarget * fractionOfDay;
        salesDeviation = (expectedAtThisPoint - currentSales) / expectedAtThisPoint;
        behindTarget = salesDeviation > 0;
      }

      /* 4. Determine severity */
      let severity: Severity = 'green';
      if (behindTarget && salesDeviation >= thresholds.belowPaceRed) {
        severity = 'red';
      } else if (behindTarget && salesDeviation >= thresholds.belowPaceYellow) {
        severity = 'yellow';
      } else if (!behindTarget && Math.abs(salesDeviation) >= thresholds.abovePaceNotable) {
        // Notably above pace is still a green alert (positive news)
        severity = 'green';
      }

      if (severity === 'green' && !(!behindTarget && Math.abs(salesDeviation) >= thresholds.abovePaceNotable)) {
        // On track, no alert needed
        console.log(`[ControlTower] SalesPace: $${currentSales.toFixed(2)} at ${currentHour}:${String(currentMinute).padStart(2, '0')}. On pace (${(salesDeviation * 100).toFixed(1)}% deviation).`);
        return nonFiring;
      }

      /* 5. Build alert */
      const expectedNow = dailyTarget > 0 ? dailyTarget * fractionOfDay : 0;
      const keyMetrics: Record<string, string | number> = {
        currentSales: `$${currentSales.toFixed(2)}`,
        orderCount,
        expectedAtThisPoint: `$${expectedNow.toFixed(2)}`,
        projectedDaySales: `$${projectedDaySales.toFixed(2)}`,
        dailyTarget: `$${dailyTarget.toFixed(2)}`,
        deviation: `${(salesDeviation * 100).toFixed(1)}%`,
        fractionOfDay: `${(fractionOfDay * 100).toFixed(0)}%`,
        hoursElapsed: `${hoursElapsed.toFixed(1)}`,
      };

      let whatHappened: string;
      if (behindTarget) {
        whatHappened = `Sales are $${currentSales.toFixed(2)} at ${currentHour}:${String(currentMinute).padStart(2, '0')}, which is ${(salesDeviation * 100).toFixed(1)}% behind expected pace of $${expectedNow.toFixed(2)}.`;
      } else {
        whatHappened = `Sales are $${currentSales.toFixed(2)} at ${currentHour}:${String(currentMinute).padStart(2, '0')}, running ${(Math.abs(salesDeviation) * 100).toFixed(1)}% ahead of expected pace.`;
      }
      whatHappened += ` Projected end of day: $${projectedDaySales.toFixed(2)}.`;

      const recommendedAction = behindTarget
        ? 'Check for operational issues (long ticket times, staffing gaps, equipment problems). Review if any marketing or promotions could boost afternoon traffic.'
        : 'Great pace today. Ensure staffing is adequate for sustained volume and prep levels are keeping up.';

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Sales pace',
        storeId: 'remote_coffee',
        dateWindow: ctx.todayStr,
        whatHappened,
        whyItMatters: 'Real time sales pacing shows whether the day is tracking to target. Early detection of shortfalls gives time to course correct.',
        keyMetrics,
        recommendedAction,
        owner: ctx.config.ownerDefaults.salesPace,
        fingerprint: `sales_pace_${ctx.todayStr}_${currentHour}`,
        shadowMode: ctx.config.mode === 'shadow',
        duplicatesExisting: 'revenue_pacing',
        sourceSystem: 'toast',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] SalesPace rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
