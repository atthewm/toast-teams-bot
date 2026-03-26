/**
 * Labor Efficiency rule (scaffolded).
 *
 * Checks whether labor data tools are available on the Toast
 * MCP server. If not, returns a non firing result indicating
 * that labor data is unavailable. This rule is structured for
 * future activation once Toast exposes labor endpoints.
 */

import type { RuleHandler, RuleContext, RuleResult } from '../engine.js';
import { buildAlert } from '../engine.js';

/* ------------------------------------------------------------------ */
/*  Known labor tool names to look for                                 */
/* ------------------------------------------------------------------ */

const LABOR_TOOL_NAMES = [
  'toast_get_labor_summary',
  'toast_list_labor',
  'toast_get_labor',
  'toast_labor_summary',
  'toast_get_timecards',
  'toast_list_timecards',
];

/* ------------------------------------------------------------------ */
/*  Rule                                                               */
/* ------------------------------------------------------------------ */

export class LaborRule implements RuleHandler {
  id = 'labor';
  name = 'Labor Efficiency Monitor';
  family = 'labor';

  async evaluate(ctx: RuleContext): Promise<RuleResult> {
    const nonFiring: RuleResult = { ruleId: this.id, fired: false, alerts: [] };

    /* 1. Check if any labor tools are available */
    let hasLaborTools = false;
    try {
      const tools = ctx.toastMcp.getTools();
      const toolNames = tools.map(t => t.name.toLowerCase());
      hasLaborTools = LABOR_TOOL_NAMES.some(name => toolNames.includes(name));
    } catch {
      // getTools may not be populated if not yet connected
      hasLaborTools = false;
    }

    if (!hasLaborTools) {
      console.log('[ControlTower] Labor: No labor data tools available on Toast MCP server.');
      return {
        ...nonFiring,
        note: 'Labor data tools not available on the Toast MCP server. This rule will activate when labor endpoints are added. Using estimated labor % from prime cost config in the meantime.',
      };
    }

    /* 2. Future: fetch labor data and compute efficiency */
    // When labor tools become available, the implementation would:
    //   a. Fetch yesterday's time card / labor summary data
    //   b. Compute total labor hours and labor dollars
    //   c. Fetch yesterday's sales for labor percentage
    //   d. Compare labor % against thresholds
    //   e. Check for overtime hours above threshold
    //   f. Generate alert with breakdown by role if available

    console.log('[ControlTower] Labor: Tools detected but full implementation is pending. Generating placeholder alert.');

    const alert = buildAlert({
      ruleId: this.id,
      ruleName: this.name,
      severity: 'green',
      topic: 'Labor efficiency',
      storeId: 'remote_coffee',
      dateWindow: ctx.yesterdayStr,
      whatHappened: 'Labor tools detected on MCP server. Full labor efficiency analysis is pending implementation.',
      whyItMatters: 'Labor is typically 25% to 35% of revenue. Monitoring labor efficiency alongside COGS completes the prime cost picture.',
      keyMetrics: {
        laborToolsAvailable: 'true',
        status: 'Pending full implementation',
      },
      recommendedAction: 'No action needed. Labor monitoring will activate automatically once the implementation is complete.',
      owner: ctx.config.ownerDefaults.labor,
      fingerprint: `labor_scaffold_${ctx.yesterdayStr}`,
      shadowMode: true,
      sourceSystem: 'toast',
    });

    return { ruleId: this.id, fired: true, alerts: [alert] };
  }
}
