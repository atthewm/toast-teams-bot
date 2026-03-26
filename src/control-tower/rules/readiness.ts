/**
 * MarginEdge Readiness Score rule.
 *
 * Checks invoice capture, product mapping, category coverage,
 * and vendor mapping against MarginEdge. Recipe coverage and
 * inventory counts are NOT available via the API so they use
 * placeholder scores. Alerts when the weighted readiness score
 * falls below the configured threshold.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';
import type { Severity } from '../models.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface ReadinessComponent {
  name: string;
  weight: number;
  score: number;
  details: string;
}

function computeWeightedScore(components: ReadinessComponent[]): number {
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = components.reduce((sum, c) => sum + c.score * c.weight, 0);
  return Math.round((weighted / totalWeight) * 100) / 100;
}

function severityFromScore(
  score: number,
  yellowThreshold: number,
  redThreshold: number
): Severity {
  if (score >= yellowThreshold) return 'green';
  if (score >= redThreshold) return 'yellow';
  return 'red';
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class ReadinessRule implements RuleHandler {
  id = 'readiness';
  name = 'MarginEdge Readiness Score';
  family = 'readiness';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };

    if (!ctx.marginedgeMcp) {
      return { ...nonFiring, note: 'MarginEdge MCP not configured. Skipping readiness check.' };
    }

    const thresholds = ctx.config.thresholds.readiness;
    const weights = thresholds.weights;
    const components: ReadinessComponent[] = [];

    try {
      /* 1. Invoice capture for yesterday */
      let invoiceScore = 0;
      let invoiceDetails = 'No invoice data retrieved';
      try {
        const invoices = await ctx.marginedgeMcp.callToolJson<{ orders?: unknown[] }>(
          'marginedge_list_orders',
          { startDate: ctx.yesterdayStr, endDate: ctx.yesterdayStr }
        );
        const orderCount = invoices?.orders?.length ?? 0;
        if (orderCount > 0) {
          invoiceScore = 100;
          invoiceDetails = `${orderCount} invoice(s) captured for yesterday`;
        } else {
          invoiceScore = 0;
          invoiceDetails = 'No invoices found for yesterday';
        }
      } catch (err) {
        console.log(`[ControlTower] Readiness: invoice fetch error: ${(err as Error).message}`);
        invoiceDetails = 'Error fetching invoices';
      }
      components.push({
        name: 'Invoices Captured',
        weight: weights.invoicesCaptured,
        score: invoiceScore,
        details: invoiceDetails,
      });

      /* 2. Product mapping completeness */
      let productScore = 0;
      let productDetails = 'No product data retrieved';
      try {
        const products = await ctx.marginedgeMcp.callToolJson<{ products?: Array<{ name?: string; categoryName?: string }> }>(
          'marginedge_list_products',
          {}
        );
        const allProducts = products?.products ?? [];
        const total = allProducts.length;
        if (total > 0) {
          const mapped = allProducts.filter(p => p.categoryName && p.categoryName.length > 0).length;
          productScore = Math.round((mapped / total) * 100);
          productDetails = `${mapped} of ${total} products mapped to categories`;
        } else {
          productScore = 50;
          productDetails = 'No products returned from API';
        }
      } catch (err) {
        console.log(`[ControlTower] Readiness: product fetch error: ${(err as Error).message}`);
        productDetails = 'Error fetching products';
      }
      components.push({
        name: 'Product Mapping',
        weight: weights.productMapping,
        score: productScore,
        details: productDetails,
      });

      /* 3. Category mapping */
      let categoryScore = 0;
      let categoryDetails = 'No category data retrieved';
      try {
        const categories = await ctx.marginedgeMcp.callToolJson<{ categories?: unknown[] }>(
          'marginedge_list_categories',
          {}
        );
        const catCount = categories?.categories?.length ?? 0;
        if (catCount > 0) {
          categoryScore = 100;
          categoryDetails = `${catCount} categories configured`;
        } else {
          categoryScore = 0;
          categoryDetails = 'No categories found';
        }
      } catch (err) {
        console.log(`[ControlTower] Readiness: category fetch error: ${(err as Error).message}`);
        categoryDetails = 'Error fetching categories';
      }
      // Category data folds into product mapping weight; use unmappedIngredients slot
      components.push({
        name: 'Category Coverage',
        weight: weights.unmappedIngredients,
        score: categoryScore,
        details: categoryDetails,
      });

      /* 4. Vendor mapping */
      let vendorScore = 0;
      let vendorDetails = 'No vendor data retrieved';
      try {
        const vendors = await ctx.marginedgeMcp.callToolJson<{ vendors?: Array<{ id?: string; name?: string }> }>(
          'marginedge_list_vendors',
          {}
        );
        const vendorList = vendors?.vendors ?? [];
        const vendorCount = vendorList.length;

        if (vendorCount > 0) {
          // Check how many vendors have items linked
          let vendorsWithItems = 0;
          for (const v of vendorList.slice(0, 10)) {
            try {
              const items = await ctx.marginedgeMcp!.callToolJson<{ items?: unknown[] }>(
                'marginedge_list_vendor_items',
                { vendorId: String(v.id ?? '') }
              );
              if ((items?.items?.length ?? 0) > 0) {
                vendorsWithItems++;
              }
            } catch {
              // Skip vendor on error
            }
          }
          const sampled = Math.min(vendorCount, 10);
          vendorScore = sampled > 0 ? Math.round((vendorsWithItems / sampled) * 100) : 50;
          vendorDetails = `${vendorsWithItems} of ${sampled} sampled vendors have items linked (${vendorCount} total vendors)`;
        } else {
          vendorScore = 0;
          vendorDetails = 'No vendors found';
        }
      } catch (err) {
        console.log(`[ControlTower] Readiness: vendor fetch error: ${(err as Error).message}`);
        vendorDetails = 'Error fetching vendors';
      }
      components.push({
        name: 'Vendor Mapping',
        weight: weights.vendorMapping,
        score: vendorScore,
        details: vendorDetails,
      });

      /* 5. Recipe coverage (placeholder, not available via API) */
      components.push({
        name: 'Recipe Coverage',
        weight: weights.recipeCoverage,
        score: 50,
        details: 'Not available via API. Using placeholder score of 50.',
      });

      /* 6. Inventory recency (placeholder, not available via API) */
      components.push({
        name: 'Inventory Recency',
        weight: weights.inventoryRecency,
        score: 50,
        details: 'Not available via API. Using placeholder score of 50.',
      });

      /* Compute overall score */
      const overallScore = computeWeightedScore(components);
      const severity = severityFromScore(
        overallScore,
        thresholds.yellowThreshold,
        thresholds.redThreshold
      );

      if (overallScore >= thresholds.target) {
        console.log(`[ControlTower] Readiness score ${overallScore} meets target ${thresholds.target}. No alert.`);
        return nonFiring;
      }

      const keyMetrics: Record<string, string | number> = {
        overallScore,
        target: thresholds.target,
      };
      for (const c of components) {
        keyMetrics[c.name] = `${c.score}/100 (weight ${c.weight})`;
      }

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'MarginEdge readiness',
        storeId: 'remote_coffee',
        dateWindow: ctx.yesterdayStr,
        whatHappened: `Readiness score is ${overallScore}, below the target of ${thresholds.target}.`,
        whyItMatters: 'Low readiness means cost data may be incomplete. Prime cost and margin calculations will be less accurate until gaps are closed.',
        keyMetrics,
        recommendedAction: components
          .filter(c => c.score < 80)
          .map(c => `${c.name}: ${c.details}`)
          .join('. ') || 'Review MarginEdge configuration for gaps.',
        owner: ctx.config.ownerDefaults.readiness,
        fingerprint: `readiness_${ctx.yesterdayStr}`,
        shadowMode: ctx.config.mode === 'shadow',
        sourceSystem: 'marginedge',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] Readiness rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
