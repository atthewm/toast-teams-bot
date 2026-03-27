/**
 * Item Margin Watchlist rule.
 *
 * Cross references Toast menu items (with prices) against
 * MarginEdge products (with costs) using normalized name
 * matching. Flags items below the configured margin threshold
 * and items missing cost mapping.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';
import type { Severity } from '../models.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface MenuGroup {
  name?: string;
  subgroups?: MenuGroup[];
  menuGroups?: MenuGroup[];
  items?: MenuItem[];
  menuItems?: MenuItem[];
}

interface MenuItem {
  name?: string;
  guid?: string;
  price?: number;
  prices?: Array<{ amount?: number }>;
  visibility?: string;
}

interface MeProduct {
  name?: string;
  unitCost?: number;
  cost?: number;
  averageCost?: number;
  categoryName?: string;
}

interface MatchedItem {
  menuName: string;
  menuPrice: number;
  costName: string;
  estimatedCost: number;
  marginPercent: number;
}

/**
 * Normalize a name for fuzzy matching: lowercase, strip punctuation,
 * collapse whitespace.
 */
function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract all menu items from a nested menu structure.
 */
function flattenMenuItems(groups: MenuGroup[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groups) {
    const groupItems = group.items ?? group.menuItems ?? [];
    items.push(...groupItems);
    const subgroups = group.subgroups ?? group.menuGroups ?? [];
    if (subgroups.length > 0) {
      items.push(...flattenMenuItems(subgroups));
    }
  }
  return items;
}

function getItemPrice(item: MenuItem): number {
  if (typeof item.price === 'number') return item.price;
  if (item.prices && item.prices.length > 0) {
    return item.prices[0]?.amount ?? 0;
  }
  return 0;
}

function getProductCost(product: MeProduct): number {
  return product.unitCost ?? product.cost ?? product.averageCost ?? 0;
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class ItemMarginRule implements RuleHandler {
  id = 'item_margin';
  name = 'Item Margin Watchlist';
  family = 'itemMargin';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };
    const thresholds = ctx.config.thresholds.itemMargin;

    /* 1. Fetch Toast menu */
    /* toast_get_menu returns an array of menu objects, each with groups */
    type MenuEnvelope = { menus?: MenuObj[]; groups?: MenuGroup[] } | MenuObj[];
    interface MenuObj { name?: string; guid?: string; groups?: MenuGroup[]; menuGroups?: MenuGroup[] }
    let menuItems: MenuItem[] = [];
    try {
      const raw = await ctx.toastMcp.callToolJson<MenuEnvelope>('toast_get_menu', {});
      let allGroups: MenuGroup[] = [];
      if (Array.isArray(raw)) {
        for (const menu of raw) {
          allGroups.push(...(menu.groups ?? menu.menuGroups ?? []));
        }
      } else if (raw) {
        const menus = raw.menus ?? [];
        for (const menu of menus) {
          allGroups.push(...(menu.groups ?? menu.menuGroups ?? []));
        }
        if (raw.groups) {
          allGroups.push(...raw.groups);
        }
      }
      menuItems = flattenMenuItems(allGroups);
    } catch (err) {
      console.log(`[ControlTower] ItemMargin: Toast menu fetch error: ${(err as Error).message}`);
      return { ...nonFiring, note: 'Failed to fetch Toast menu data.' };
    }

    if (menuItems.length === 0) {
      return { ...nonFiring, note: 'No menu items found in Toast.' };
    }

    /* 2. Fetch MarginEdge products */
    let meProducts: MeProduct[] = [];
    if (ctx.marginedgeMcp) {
      try {
        const prodData = await ctx.marginedgeMcp.callToolJson<{ products?: MeProduct[] }>(
          'marginedge_list_products',
          {}
        );
        meProducts = prodData?.products ?? [];
      } catch (err) {
        console.log(`[ControlTower] ItemMargin: MarginEdge products fetch error: ${(err as Error).message}`);
      }
    }

    if (meProducts.length === 0) {
      return { ...nonFiring, note: 'No MarginEdge products available for cost matching.' };
    }

    /* 3. Build a lookup map of normalized product names to costs */
    const costMap = new Map<string, MeProduct>();
    for (const prod of meProducts) {
      if (!prod.name) continue;
      costMap.set(normalizeName(prod.name), prod);
    }

    /* 4. Cross reference */
    const matched: MatchedItem[] = [];
    const unmatchedItems: string[] = [];

    for (const item of menuItems) {
      if (!item.name) continue;
      const price = getItemPrice(item);
      if (price <= 0) continue;

      const normalizedMenuName = normalizeName(item.name);
      const product = costMap.get(normalizedMenuName);

      if (!product) {
        unmatchedItems.push(item.name);
        continue;
      }

      const cost = getProductCost(product);
      if (cost <= 0) continue;

      const marginPercent = (price - cost) / price;
      matched.push({
        menuName: item.name,
        menuPrice: price,
        costName: product.name ?? item.name,
        estimatedCost: cost,
        marginPercent: Math.round(marginPercent * 10000) / 10000,
      });
    }

    /* 5. Flag items below threshold */
    const belowThreshold = matched.filter(m => m.marginPercent < thresholds.minMarginPercent);

    // Sort by margin ascending (worst first)
    belowThreshold.sort((a, b) => a.marginPercent - b.marginPercent);

    if (belowThreshold.length === 0 && unmatchedItems.length === 0) {
      console.log(`[ControlTower] ItemMargin: All ${matched.length} matched items above ${(thresholds.minMarginPercent * 100).toFixed(0)}% margin.`);
      return nonFiring;
    }

    /* 6. Build alert */
    const alerts = [];

    if (belowThreshold.length > 0) {
      const topOffenders = belowThreshold.slice(0, 10);
      const keyMetrics: Record<string, string | number> = {
        totalMenuItems: menuItems.length,
        matchedItems: matched.length,
        belowThresholdCount: belowThreshold.length,
        marginThreshold: `${(thresholds.minMarginPercent * 100).toFixed(0)}%`,
      };

      for (let i = 0; i < topOffenders.length; i++) {
        const item = topOffenders[i]!;
        keyMetrics[`item_${i + 1}`] = `${item.menuName}: $${item.menuPrice.toFixed(2)} price, $${item.estimatedCost.toFixed(2)} cost, ${(item.marginPercent * 100).toFixed(1)}% margin`;
      }

      const severity: Severity = belowThreshold.length >= 5 ? 'red' : 'yellow';

      alerts.push(buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Item margin compression',
        storeId: 'remote_coffee',
        dateWindow: ctx.todayStr,
        whatHappened: `${belowThreshold.length} menu item(s) have margins below ${(thresholds.minMarginPercent * 100).toFixed(0)}%.`,
        whyItMatters: 'Items sold below target margin erode profitability with every sale. High volume items with low margins compound losses quickly.',
        keyMetrics,
        recommendedAction: 'Review pricing on flagged items. Consider a price increase, portion adjustment, or ingredient substitution for the worst offenders.',
        owner: ctx.config.ownerDefaults.itemMargin,
        fingerprint: `item_margin_below_${ctx.todayStr}`,
        shadowMode: ctx.config.mode === 'shadow',
        sourceSystem: 'computed',
      }));
    }

    if (unmatchedItems.length > 0 && unmatchedItems.length > matched.length * 0.3) {
      const preview = unmatchedItems.slice(0, 8).join(', ');
      const keyMetrics: Record<string, string | number> = {
        unmatchedCount: unmatchedItems.length,
        matchedCount: matched.length,
        totalMenuItems: menuItems.length,
        sampleUnmatched: preview,
      };

      alerts.push(buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity: 'yellow',
        topic: 'Menu cost mapping gaps',
        storeId: 'remote_coffee',
        dateWindow: ctx.todayStr,
        whatHappened: `${unmatchedItems.length} menu items have no matching cost in MarginEdge.`,
        whyItMatters: 'Without cost data, margins cannot be monitored. These blind spots may hide unprofitable items.',
        keyMetrics,
        recommendedAction: 'Map missing items in MarginEdge or create recipes for composite items. Start with highest volume items.',
        owner: ctx.config.ownerDefaults.itemMargin,
        fingerprint: `item_margin_unmatched_${ctx.todayStr}`,
        shadowMode: ctx.config.mode === 'shadow',
        sourceSystem: 'computed',
      }));
    }

    if (alerts.length === 0) {
      return nonFiring;
    }

    return { ruleId: this.id, fired: true, alerts };
  }
}
