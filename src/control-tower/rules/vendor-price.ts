/**
 * Vendor Price Spike detection rule.
 *
 * Compares line item unit prices from recent MarginEdge invoices
 * (last 7 days) against the previous period (8 to 37 days ago)
 * to detect price spikes above the configured threshold.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';
import type { Severity, VendorPriceChangeEntry } from '../models.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface MeInvoice {
  id?: string;
  vendorName?: string;
  vendor?: { name?: string };
  date?: string;
  items?: MeLineItem[];
  lineItems?: MeLineItem[];
}

interface MeLineItem {
  name?: string;
  productName?: string;
  unitPrice?: number;
  unitCost?: number;
  price?: number;
  quantity?: number;
}

/**
 * Format a date as YYYYMMDD for the MarginEdge API.
 */
function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getLineItemPrice(item: MeLineItem): number {
  return item.unitPrice ?? item.unitCost ?? item.price ?? 0;
}

function getLineItemName(item: MeLineItem): string {
  return item.name ?? item.productName ?? 'Unknown item';
}

function getVendorName(invoice: MeInvoice): string {
  return invoice.vendorName ?? invoice.vendor?.name ?? 'Unknown vendor';
}

/**
 * Build a map of product name to list of unit prices from a set of invoices.
 */
function buildPriceMap(invoices: MeInvoice[]): Map<string, { vendorName: string; prices: number[] }> {
  const map = new Map<string, { vendorName: string; prices: number[] }>();

  for (const inv of invoices) {
    const vendor = getVendorName(inv);
    const items = inv.items ?? inv.lineItems ?? [];
    for (const item of items) {
      const price = getLineItemPrice(item);
      if (price <= 0) continue;
      const name = getLineItemName(item);
      const key = `${vendor}::${name}`.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.prices.push(price);
      } else {
        map.set(key, { vendorName: vendor, prices: [price] });
      }
    }
  }

  return map;
}

function medianPrice(prices: number[]): number {
  if (prices.length === 0) return 0;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class VendorPriceRule implements RuleHandler {
  id = 'vendor_price';
  name = 'Vendor Price Spike Detection';
  family = 'vendorPrice';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };

    if (!ctx.marginedgeMcp) {
      return { ...nonFiring, note: 'MarginEdge MCP not configured. Skipping vendor price check.' };
    }

    const thresholds = ctx.config.thresholds.vendorPrice;

    try {
      const now = new Date();

      /* 1. Recent period: last 7 days */
      const recentEnd = new Date(now);
      recentEnd.setDate(recentEnd.getDate() - 1);
      const recentStart = new Date(now);
      recentStart.setDate(recentStart.getDate() - 7);

      let recentInvoices: MeInvoice[] = [];
      try {
        const recentData = await ctx.marginedgeMcp.callToolJson<{ orders?: MeInvoice[] }>(
          'marginedge_list_orders',
          { startDate: formatDateStr(recentStart), endDate: formatDateStr(recentEnd) }
        );
        recentInvoices = recentData?.orders ?? [];
      } catch (err) {
        console.log(`[ControlTower] VendorPrice: recent invoice fetch error: ${(err as Error).message}`);
        return { ...nonFiring, note: 'Failed to fetch recent invoices from MarginEdge.' };
      }

      if (recentInvoices.length === 0) {
        return { ...nonFiring, note: 'No recent invoices found in the last 7 days.' };
      }

      /* 2. Previous period: 8 to 37 days ago */
      const prevEnd = new Date(now);
      prevEnd.setDate(prevEnd.getDate() - 8);
      const prevStart = new Date(now);
      prevStart.setDate(prevStart.getDate() - 37);

      let prevInvoices: MeInvoice[] = [];
      try {
        const prevData = await ctx.marginedgeMcp.callToolJson<{ orders?: MeInvoice[] }>(
          'marginedge_list_orders',
          { startDate: formatDateStr(prevStart), endDate: formatDateStr(prevEnd) }
        );
        prevInvoices = prevData?.orders ?? [];
      } catch (err) {
        console.log(`[ControlTower] VendorPrice: previous period invoice fetch error: ${(err as Error).message}`);
        return { ...nonFiring, note: 'Failed to fetch previous period invoices from MarginEdge.' };
      }

      if (prevInvoices.length === 0) {
        return { ...nonFiring, note: 'No previous period invoices for comparison.' };
      }

      /* 3. Build price maps and compare */
      const recentMap = buildPriceMap(recentInvoices);
      const prevMap = buildPriceMap(prevInvoices);

      const spikes: VendorPriceChangeEntry[] = [];

      for (const [key, recentEntry] of recentMap) {
        const prevEntry = prevMap.get(key);
        if (!prevEntry || prevEntry.prices.length === 0) continue;

        const recentMedian = medianPrice(recentEntry.prices);
        const prevMedian = medianPrice(prevEntry.prices);

        if (prevMedian <= 0) continue;

        const changePercent = (recentMedian - prevMedian) / prevMedian;

        if (changePercent >= thresholds.spikeThresholdPercent) {
          const productName = key.split('::')[1] ?? 'Unknown';
          spikes.push({
            vendorName: recentEntry.vendorName,
            productName,
            previousPrice: Math.round(prevMedian * 100) / 100,
            currentPrice: Math.round(recentMedian * 100) / 100,
            changePercent: Math.round(changePercent * 10000) / 10000,
          });
        }
      }

      if (spikes.length === 0) {
        console.log(`[ControlTower] VendorPrice: No price spikes detected above ${(thresholds.spikeThresholdPercent * 100).toFixed(0)}% threshold.`);
        return nonFiring;
      }

      // Sort by change percent descending (biggest spikes first)
      spikes.sort((a, b) => b.changePercent - a.changePercent);

      /* 4. Build alert */
      const topSpikes = spikes.slice(0, 10);
      const severity: Severity = spikes.some(s => s.changePercent >= 0.25) ? 'red'
        : spikes.length >= 3 ? 'yellow'
        : 'yellow';

      const keyMetrics: Record<string, string | number> = {
        spikeCount: spikes.length,
        recentInvoiceCount: recentInvoices.length,
        previousInvoiceCount: prevInvoices.length,
        threshold: `${(thresholds.spikeThresholdPercent * 100).toFixed(0)}%`,
      };

      for (let i = 0; i < topSpikes.length; i++) {
        const s = topSpikes[i]!;
        keyMetrics[`spike_${i + 1}`] = `${s.vendorName} / ${s.productName}: $${s.previousPrice.toFixed(2)} -> $${s.currentPrice.toFixed(2)} (+${(s.changePercent * 100).toFixed(1)}%)`;
      }

      // Check watchlist ingredients
      const watchlistHits = spikes.filter(s => {
        const lower = s.productName.toLowerCase();
        return ctx.config.watchlists.keyIngredients.some(
          ing => lower.includes(ing.toLowerCase())
        );
      });

      let whatHappened = `${spikes.length} vendor item(s) show price increases above ${(thresholds.spikeThresholdPercent * 100).toFixed(0)}% compared to the prior 30 day median.`;
      if (watchlistHits.length > 0) {
        whatHappened += ` ${watchlistHits.length} of these are key ingredients on the watchlist.`;
      }

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Vendor price spikes',
        storeId: 'remote_coffee',
        dateWindow: `${formatDateStr(recentStart)} to ${formatDateStr(recentEnd)}`,
        whatHappened,
        whyItMatters: 'Vendor price increases directly impact COGS. Early detection allows you to negotiate, source alternatives, or adjust menu prices before margins erode.',
        keyMetrics,
        recommendedAction: 'Contact vendors on the largest spikes. Check if the increase is a one time event or a trend. Consider alternative suppliers or menu price adjustments for affected items.',
        owner: ctx.config.ownerDefaults.vendorPrice,
        fingerprint: `vendor_price_${ctx.todayStr}_${spikes.length}`,
        shadowMode: ctx.config.mode === 'shadow',
        sourceSystem: 'marginedge',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] VendorPrice rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
