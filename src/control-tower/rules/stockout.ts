/**
 * Stockout / Disabled Item detection rule.
 *
 * Fetches the full menu from Toast and checks item visibility
 * flags. Flags hidden or disabled items that may represent
 * unintentional stockouts. Marks overlap with the existing
 * 86d_check alert in the scheduled monitor.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';
import type { Severity } from '../models.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface MenuGroup {
  name?: string;
  visibility?: string;
  subgroups?: MenuGroup[];
  items?: MenuItem[];
}

interface MenuItem {
  name?: string;
  guid?: string;
  price?: number;
  prices?: Array<{ amount?: number }>;
  visibility?: string;
  isVisible?: boolean;
  enabled?: boolean;
  available?: boolean;
  outOfStock?: boolean;
}

interface DisabledItem {
  name: string;
  guid: string;
  reason: string;
  estimatedPrice: number;
}

/**
 * Check if an item appears to be disabled or out of stock.
 */
function isItemDisabled(item: MenuItem): { disabled: boolean; reason: string } {
  if (item.outOfStock === true) {
    return { disabled: true, reason: 'Marked out of stock' };
  }
  if (item.enabled === false) {
    return { disabled: true, reason: 'Disabled' };
  }
  if (item.available === false) {
    return { disabled: true, reason: 'Marked unavailable' };
  }
  if (item.isVisible === false) {
    return { disabled: true, reason: 'Hidden from menu' };
  }
  if (item.visibility) {
    const lower = item.visibility.toLowerCase();
    if (lower === 'hidden' || lower === 'none' || lower === 'pos_only') {
      return { disabled: true, reason: `Visibility set to ${item.visibility}` };
    }
  }
  return { disabled: false, reason: '' };
}

function getItemPrice(item: MenuItem): number {
  if (typeof item.price === 'number') return item.price;
  if (item.prices && item.prices.length > 0) {
    return item.prices[0]?.amount ?? 0;
  }
  return 0;
}

/**
 * Recursively extract all items from a nested menu structure.
 */
function flattenItems(groups: MenuGroup[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const group of groups) {
    // Skip entirely hidden menu groups
    if (group.visibility) {
      const lower = group.visibility.toLowerCase();
      if (lower === 'hidden' || lower === 'none') continue;
    }
    if (group.items) {
      items.push(...group.items);
    }
    if (group.subgroups) {
      items.push(...flattenItems(group.subgroups));
    }
  }
  return items;
}

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class StockoutRule implements RuleHandler {
  id = 'stockout';
  name = 'Stockout / Disabled Item Detection';
  family = 'stockout';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };

    try {
      /* 1. Fetch full menu */
      const menuData = await ctx.toastMcp.callToolJson<{ menus?: MenuGroup[]; groups?: MenuGroup[] }>(
        'toast_get_menu',
        {}
      );
      const groups = menuData?.menus ?? menuData?.groups ?? [];
      const allItems = flattenItems(groups);

      if (allItems.length === 0) {
        return { ...nonFiring, note: 'No menu items found. Skipping stockout check.' };
      }

      /* 2. Check each item for disabled/hidden status */
      const disabledItems: DisabledItem[] = [];

      for (const item of allItems) {
        if (!item.name) continue;
        const check = isItemDisabled(item);
        if (check.disabled) {
          disabledItems.push({
            name: item.name,
            guid: item.guid ?? '',
            reason: check.reason,
            estimatedPrice: getItemPrice(item),
          });
        }
      }

      if (disabledItems.length === 0) {
        console.log(`[ControlTower] Stockout: All ${allItems.length} menu items are active.`);
        return nonFiring;
      }

      /* 3. Build alert */
      const severity: Severity = disabledItems.length >= 5 ? 'red'
        : disabledItems.length >= 2 ? 'yellow'
        : 'yellow';

      const keyMetrics: Record<string, string | number> = {
        totalMenuItems: allItems.length,
        disabledCount: disabledItems.length,
      };

      const displayItems = disabledItems.slice(0, 10);
      for (let i = 0; i < displayItems.length; i++) {
        const item = displayItems[i]!;
        const priceStr = item.estimatedPrice > 0 ? ` ($${item.estimatedPrice.toFixed(2)})` : '';
        keyMetrics[`item_${i + 1}`] = `${item.name}${priceStr}: ${item.reason}`;
      }

      if (disabledItems.length > 10) {
        keyMetrics['additional'] = `${disabledItems.length - 10} more items not shown`;
      }

      // Estimate potential revenue impact
      const totalPotentialLoss = disabledItems.reduce((sum, item) => sum + item.estimatedPrice, 0);
      if (totalPotentialLoss > 0) {
        keyMetrics['estimatedDailyImpact'] = `Up to $${totalPotentialLoss.toFixed(2)} per missed sale`;
      }

      const itemList = displayItems.map(i => i.name).join(', ');

      const alert = buildAlert({
        ruleId: this.id,
        ruleName: this.name,
        severity,
        topic: 'Menu item stockout',
        storeId: 'remote_coffee',
        dateWindow: ctx.todayStr,
        whatHappened: `${disabledItems.length} menu item(s) are currently disabled or hidden: ${itemList}${disabledItems.length > 10 ? `, and ${disabledItems.length - 10} more` : ''}.`,
        whyItMatters: 'Every disabled item is a missed sale opportunity. Popular items that stay offline hurt customer satisfaction and revenue.',
        keyMetrics,
        recommendedAction: 'Verify each disabled item. If it is intentionally 86d, confirm restock ETA. If it was disabled by mistake, re enable it immediately.',
        owner: ctx.config.ownerDefaults.stockout,
        fingerprint: `stockout_${ctx.todayStr}_${disabledItems.length}`,
        shadowMode: ctx.config.mode === 'shadow',
        duplicatesExisting: '86d_check',
        sourceSystem: 'toast',
      });

      return { ruleId: this.id, fired: true, alerts: [alert] };

    } catch (err) {
      console.log(`[ControlTower] Stockout rule error: ${(err as Error).message}`);
      return nonFiring;
    }
  }
}
