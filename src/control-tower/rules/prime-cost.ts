/**
 * Daily Prime Cost Control rule.
 *
 * Fetches yesterday's Toast orders to compute net sales, and
 * yesterday's MarginEdge invoices to estimate COGS. Labor is
 * not available via API and is marked as estimated. Computes
 * COGS %, prime cost %, average ticket, and order count.
 * Always generates a daily digest alert (green/yellow/red).
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
}

interface InvoiceEntry {
  id?: string;
  total?: number;
  amount?: number;
  totalAmount?: number;
}

function extractNetSales(orders: OrderEntry[]): { netSales: number; orderCount: number; avgTicket: number } {
  const valid = orders.filter(o => !o.voided && !o.deleted);
  const orderCount = valid.length;
  const netSales = valid.reduce((sum, o) => {
    const amount = o.totalAmount ?? o.amount ?? o.total ?? 0;
    return sum + amount;
  }, 0);
  const avgTicket = orderCount > 0 ? Math.round((netSales / orderCount) * 100) / 100 : 0;
  return { netSales, orderCount, avgTicket };
}

function extractCogs(invoices: InvoiceEntry[]): number {
  return invoices.reduce((sum, inv) => {
    const amount = inv.total ?? inv.amount ?? inv.totalAmount ?? 0;
    return sum + amount;
  }, 0);
}

function cogsPercent(cogs: number, sales: number): number {
  if (sales <= 0) return 0;
  return Math.round((cogs / sales) * 10000) / 10000;
}

function determineSeverity(
  cogsPct: number,
  primeCostPct: number,
  salesDeviation: number,
  thresholds: {
    cogsYellowThreshold: number;
    cogsRedThreshold: number;
    primeCostYellowThreshold: number;
    primeCostRedThreshold: number;
    salesDeviationYellow: number;
    salesDeviationRed: number;
  }
): Severity {
  // Red if any metric hits red
  if (cogsPct >= thresholds.cogsRedThreshold) return 'red';
  if (primeCostPct >= thresholds.primeCostRedThreshold) return 'red';
  if (salesDeviation >= thresholds.salesDeviationRed) return 'red';

  // Yellow if any metric hits yellow
  if (cogsPct >= thresholds.cogsYellowThreshold) return 'yellow';
  if (primeCostPct >= thresholds.primeCostYellowThreshold) return 'yellow';
  if (salesDeviation >= thresholds.salesDeviationYellow) return 'yellow';

  return 'green';
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class PrimeCostRule implements RuleHandler {
  id = 'prime_cost';
  name = 'Daily Prime Cost Control';
  family = 'primeCost';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };
    const thresholds = ctx.config.thresholds.primeCost;

    try {
      /* 1. Fetch yesterday's Toast orders */
      let netSales = 0;
      let orderCount = 0;
      let avgTicket = 0;

      try {
        const ordersData = await ctx.toastMcp.callToolJson<{ orders?: OrderEntry[]; totalOrders?: number }>(
          'toast_list_orders',
          { businessDate: ctx.yesterdayStr }
        );
        const orders = ordersData?.orders ?? [];
        const salesInfo = extractNetSales(orders);
        netSales = salesInfo.netSales;
        orderCount = salesInfo.orderCount;
        avgTicket = salesInfo.avgTicket;
      } catch (err) {
        console.log(`[ControlTower] PrimeCost: Toast orders fetch error: ${(err as Error).message}`);
        return { ...nonFiring, note: 'Failed to fetch Toast orders for yesterday.' };
      }

      if (netSales <= 0) {
        return { ...nonFiring, note: 'No sales data for yesterday. Skipping prime cost calculation.' };
      }

      /* 2. Fetch yesterday's MarginEdge invoices for COGS */
      let cogs = 0;
      let cogsAvailable = false;

      if (ctx.marginedgeMcp) {
        try {
          const invoicesData = await ctx.marginedgeMcp.callToolJson<{ orders?: InvoiceEntry[] }>(
            'marginedge_list_orders',
            { startDate: ctx.yesterdayStr, endDate: ctx.yesterdayStr }
          );
          const invoices = invoicesData?.orders ?? [];
          cogs = extractCogs(invoices);
          cogsAvailable = true;
        } catch (err) {
          console.log(`[ControlTower] PrimeCost: MarginEdge invoice fetch error: ${(err as Error).message}`);
        }
      }

      /* 3. Compute ratios */
      const cogsPct = cogsPercent(cogs, netSales);

      // Labor is not available via API. Use target as estimate.
      const estimatedLaborPct = thresholds.laborTarget;
      const primeCostPct = cogsPct + estimatedLaborPct;

      // Sales deviation from daily target
      const salesDeviation = thresholds.dailySalesTarget > 0
        ? Math.abs(netSales - thresholds.dailySalesTarget) / thresholds.dailySalesTarget
        : 0;

      const severity = determineSeverity(cogsPct, primeCostPct, salesDeviation, thresholds);

      /* 4. Build the digest alert (always fires) */
      const cogsNote = cogsAvailable
        ? `$${cogs.toFixed(2)} (${(cogsPct * 100).toFixed(1)}% of sales)`
        : 'Not available (MarginEdge not configured or no data)';

      const keyMetrics: Record<string, string | number> = {
        netSales: `$${netSales.toFixed(2)}`,
        orderCount,
        avgTicket: `$${avgTicket.toFixed(2)}`,
        cogs: cogsNote,
        cogsPct: `${(cogsPct * 100).toFixed(1)}%`,
        estimatedLaborPct: `${(estimatedLaborPct * 100).toFixed(1)}% (estimated)`,
        primeCostPct: `${(primeCostPct * 100).toFixed(1)}%`,
        dailySalesTarget: `$${thresholds.dailySalesTarget.toFixed(2)}`,
        salesDeviation: `${(salesDeviation * 100).toFixed(1)}%`,
      };

      let whatHappened = `Yesterday's net sales: $${netSales.toFixed(2)} across ${orderCount} orders.`;
      if (cogsAvailable) {
        whatHappened += ` COGS was $${cogs.toFixed(2)} (${(cogsPct * 100).toFixed(1)}%).`;
      }
      whatHappened += ` Estimated prime cost: ${(primeCostPct * 100).toFixed(1)}%.`;

      let recommendedAction = '';
      if (severity === 'red') {
        recommendedAction = 'Review cost drivers immediately. Check for unusually large invoices or waste. Verify menu pricing covers current costs.';
      } else if (severity === 'yellow') {
        recommendedAction = 'Monitor cost trends this week. Check for any vendor price increases or portion drift.';
      } else {
        recommendedAction = 'Costs are within target. Continue monitoring.';
      }

      if (!cogsAvailable) {
        recommendedAction += ' Note: COGS data unavailable. Connect MarginEdge for accurate cost tracking.';
      }

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Daily prime cost digest',
        storeId: 'remote_coffee',
        dateWindow: ctx.yesterdayStr,
        whatHappened,
        whyItMatters: 'Prime cost (COGS + labor) is the single biggest controllable expense. Catching overruns within 24 hours prevents small problems from compounding.',
        keyMetrics,
        recommendedAction,
        owner: ctx.config.ownerDefaults.primeCost,
        fingerprint: `prime_cost_${ctx.yesterdayStr}`,
        shadowMode: ctx.config.mode === 'shadow',
        sourceSystem: 'computed',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] PrimeCost rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
