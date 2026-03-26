/**
 * Discount / Comp / Void Anomaly detection rule.
 *
 * Fetches yesterday's Toast orders, computes void counts and
 * amounts from voided orders, and estimates discount/comp data
 * from check level detail if available. Compares against configured
 * thresholds. Marks overlap with the existing void_cluster alert
 * in the real time monitor.
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
  closedDate?: string;
  checks?: CheckEntry[];
  discountAmount?: number;
  refundAmount?: number;
}

interface CheckEntry {
  guid?: string;
  totalAmount?: number;
  amount?: number;
  voided?: boolean;
  appliedDiscounts?: DiscountEntry[];
  appliedComps?: CompEntry[];
}

interface DiscountEntry {
  name?: string;
  amount?: number;
  discountAmount?: number;
}

interface CompEntry {
  name?: string;
  amount?: number;
  compAmount?: number;
}

function getOrderTotal(o: OrderEntry): number {
  return o.totalAmount ?? o.amount ?? o.total ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class DiscountCompRule implements RuleHandler {
  id = 'discount_comp_void';
  name = 'Discount/Comp/Void Anomaly Detection';
  family = 'discountCompVoid';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };
    const thresholds = ctx.config.thresholds.discountCompVoid;

    try {
      /* 1. Fetch yesterday's orders */
      const ordersData = await ctx.toastMcp.callToolJson<{ orders?: OrderEntry[]; totalOrders?: number }>(
        'toast_list_orders',
        { businessDate: ctx.yesterdayStr }
      );
      const orders = ordersData?.orders ?? [];

      if (orders.length === 0) {
        return { ...nonFiring, note: 'No orders found for yesterday.' };
      }

      /* 2. Compute gross sales (all orders before voids) */
      const allOrders = orders.length;
      const grossSales = orders.reduce((sum, o) => sum + getOrderTotal(o), 0);

      if (grossSales <= 0) {
        return { ...nonFiring, note: 'Zero gross sales yesterday. Skipping anomaly check.' };
      }

      /* 3. Void analysis */
      const voidedOrders = orders.filter(o => o.voided === true);
      const voidCount = voidedOrders.length;
      const voidAmount = voidedOrders.reduce((sum, o) => sum + getOrderTotal(o), 0);
      const voidPercent = voidAmount / grossSales;

      /* 4. Valid (non voided) orders */
      const validOrders = orders.filter(o => !o.voided && !o.deleted);
      const netSales = validOrders.reduce((sum, o) => sum + getOrderTotal(o), 0);

      /* 5. Discount and comp analysis from check data */
      let totalDiscounts = 0;
      let totalComps = 0;
      let totalRefunds = 0;
      let discountCount = 0;
      let compCount = 0;

      for (const order of validOrders) {
        // Check for order level discount/refund amounts
        if (order.discountAmount && order.discountAmount > 0) {
          totalDiscounts += order.discountAmount;
          discountCount++;
        }
        if (order.refundAmount && order.refundAmount > 0) {
          totalRefunds += order.refundAmount;
        }

        // Dive into checks for applied discounts and comps
        if (order.checks) {
          for (const check of order.checks) {
            if (check.appliedDiscounts) {
              for (const disc of check.appliedDiscounts) {
                const amt = disc.amount ?? disc.discountAmount ?? 0;
                if (amt > 0) {
                  totalDiscounts += amt;
                  discountCount++;
                }
              }
            }
            if (check.appliedComps) {
              for (const comp of check.appliedComps) {
                const amt = comp.amount ?? comp.compAmount ?? 0;
                if (amt > 0) {
                  totalComps += amt;
                  compCount++;
                }
              }
            }
          }
        }
      }

      const discountPercent = netSales > 0 ? totalDiscounts / netSales : 0;
      const compPercent = netSales > 0 ? totalComps / netSales : 0;
      const refundPercent = netSales > 0 ? totalRefunds / netSales : 0;
      const totalExceptionAmount = voidAmount + totalDiscounts + totalComps + totalRefunds;
      const totalExceptionPercent = grossSales > 0 ? totalExceptionAmount / grossSales : 0;

      /* 6. Determine severity */
      let severity: Severity = 'green';

      if (voidPercent >= thresholds.voidPercentRed) severity = 'red';
      else if (discountPercent >= thresholds.discountPercentRed) severity = 'red';
      else if (compPercent >= thresholds.compPercentRed) severity = 'red';
      else if (totalExceptionPercent >= thresholds.totalExceptionPercentRed) severity = 'red';
      else if (voidPercent >= thresholds.voidPercentYellow) severity = 'yellow';
      else if (discountPercent >= thresholds.discountPercentYellow) severity = 'yellow';
      else if (compPercent >= thresholds.compPercentYellow) severity = 'yellow';
      else if (refundPercent >= thresholds.refundPercentYellow) severity = 'yellow';
      else if (totalExceptionPercent >= thresholds.totalExceptionPercentYellow) severity = 'yellow';

      if (severity === 'green') {
        console.log(`[ControlTower] DiscountComp: All exception metrics within normal range. Voids: ${(voidPercent * 100).toFixed(1)}%, Discounts: ${(discountPercent * 100).toFixed(1)}%, Comps: ${(compPercent * 100).toFixed(1)}%`);
        return nonFiring;
      }

      /* 7. Build alert */
      const keyMetrics: Record<string, string | number> = {
        grossSales: `$${grossSales.toFixed(2)}`,
        netSales: `$${netSales.toFixed(2)}`,
        totalOrders: allOrders,
        voidCount,
        voidAmount: `$${voidAmount.toFixed(2)}`,
        voidPercent: `${(voidPercent * 100).toFixed(1)}%`,
        discountCount,
        discountAmount: `$${totalDiscounts.toFixed(2)}`,
        discountPercent: `${(discountPercent * 100).toFixed(1)}%`,
        compCount,
        compAmount: `$${totalComps.toFixed(2)}`,
        compPercent: `${(compPercent * 100).toFixed(1)}%`,
        refundAmount: `$${totalRefunds.toFixed(2)}`,
        refundPercent: `${(refundPercent * 100).toFixed(1)}%`,
        totalExceptionAmount: `$${totalExceptionAmount.toFixed(2)}`,
        totalExceptionPercent: `${(totalExceptionPercent * 100).toFixed(1)}%`,
      };

      const anomalies: string[] = [];
      if (voidPercent >= thresholds.voidPercentYellow) {
        anomalies.push(`Voids at ${(voidPercent * 100).toFixed(1)}% ($${voidAmount.toFixed(2)})`);
      }
      if (discountPercent >= thresholds.discountPercentYellow) {
        anomalies.push(`Discounts at ${(discountPercent * 100).toFixed(1)}% ($${totalDiscounts.toFixed(2)})`);
      }
      if (compPercent >= thresholds.compPercentYellow) {
        anomalies.push(`Comps at ${(compPercent * 100).toFixed(1)}% ($${totalComps.toFixed(2)})`);
      }
      if (refundPercent >= thresholds.refundPercentYellow) {
        anomalies.push(`Refunds at ${(refundPercent * 100).toFixed(1)}% ($${totalRefunds.toFixed(2)})`);
      }

      const whatHappened = anomalies.length > 0
        ? `Exception metrics elevated yesterday: ${anomalies.join('; ')}. Total exceptions: $${totalExceptionAmount.toFixed(2)} (${(totalExceptionPercent * 100).toFixed(1)}% of gross sales).`
        : `Total exceptions of $${totalExceptionAmount.toFixed(2)} (${(totalExceptionPercent * 100).toFixed(1)}% of gross sales) exceeded threshold.`;

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Discount/comp/void anomaly',
        storeId: 'remote_coffee',
        dateWindow: ctx.yesterdayStr,
        whatHappened,
        whyItMatters: 'Elevated voids, discounts, and comps can signal operational issues, training gaps, or potential misuse. Each dollar in exceptions is a direct hit to the bottom line.',
        keyMetrics,
        recommendedAction: 'Review void reasons and manager approvals. Check if discounts were applied correctly. Investigate any patterns by server, time of day, or order type.',
        owner: ctx.config.ownerDefaults.discountCompVoid,
        fingerprint: `discount_comp_void_${ctx.yesterdayStr}`,
        shadowMode: ctx.config.mode === 'shadow',
        duplicatesExisting: 'void_cluster',
        sourceSystem: 'toast',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] DiscountComp rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
