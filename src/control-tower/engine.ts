/**
 * Control Tower Rules Engine.
 *
 * Accepts RuleHandler registrations, runs them sequentially to stay
 * within MCP rate limits, tracks cooldowns in memory, and returns
 * alerts that passed their cooldown window.
 */

import type { ToastMcpClient } from '../mcp/client.js';
import type { ControlTowerAlert, Severity } from './models.js';
import type { ControlTowerConfig } from './config.js';

/* ------------------------------------------------------------------ */
/*  Public interfaces                                                  */
/* ------------------------------------------------------------------ */

export interface RuleResult {
  ruleId: string;
  fired: boolean;
  alerts: ControlTowerAlert[];
  note?: string;
}

export interface RuleHandler {
  id: string;
  name: string;
  family: string;
  evaluate(ctx: RuleContext): Promise<RuleResult>;
}

export interface RuleContext {
  toastMcp: ToastMcpClient;
  marginedgeMcp: ToastMcpClient | null;
  config: ControlTowerConfig;
  timezone: string;
  todayStr: string;       // YYYYMMDD
  yesterdayStr: string;    // YYYYMMDD
}

/* ------------------------------------------------------------------ */
/*  Cooldown tracker (in memory, resets on restart)                    */
/* ------------------------------------------------------------------ */

const cooldownMap = new Map<string, number>();

function isCoolingDown(fingerprint: string, cooldownMinutes: number): boolean {
  const lastFired = cooldownMap.get(fingerprint);
  if (lastFired === undefined) return false;
  const elapsed = Date.now() - lastFired;
  return elapsed < cooldownMinutes * 60 * 1000;
}

function recordCooldown(fingerprint: string): void {
  cooldownMap.set(fingerprint, Date.now());
}

/* ------------------------------------------------------------------ */
/*  Alert builder helper                                               */
/* ------------------------------------------------------------------ */

export function buildAlert(params: {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  topic: string;
  storeId: string;
  dateWindow: string;
  whatHappened: string;
  whyItMatters: string;
  keyMetrics: Record<string, string | number>;
  recommendedAction: string;
  owner: string;
  dueTime?: string | null;
  fingerprint: string;
  shadowMode: boolean;
  duplicatesExisting?: string | null;
  sourceSystem: string;
}): ControlTowerAlert {
  return {
    id: `${params.ruleId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ruleId: params.ruleId,
    ruleName: params.ruleName,
    severity: params.severity,
    topic: params.topic,
    storeId: params.storeId,
    dateWindow: params.dateWindow,
    whatHappened: params.whatHappened,
    whyItMatters: params.whyItMatters,
    keyMetrics: params.keyMetrics,
    recommendedAction: params.recommendedAction,
    owner: params.owner,
    dueTime: params.dueTime ?? null,
    createdAt: new Date().toISOString(),
    fingerprint: params.fingerprint,
    shadowMode: params.shadowMode,
    duplicatesExisting: params.duplicatesExisting ?? null,
    sourceSystem: params.sourceSystem,
  };
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class ControlTowerEngine {
  private handlers: RuleHandler[] = [];

  /** Register a rule handler. */
  register(handler: RuleHandler): void {
    console.log(`[ControlTower] Registered rule: ${handler.id} (${handler.name})`);
    this.handlers.push(handler);
  }

  /** Register multiple rule handlers at once. */
  registerAll(handlers: RuleHandler[]): void {
    for (const h of handlers) {
      this.register(h);
    }
  }

  /** Return a copy of registered handler metadata. */
  listRules(): Array<{ id: string; name: string; family: string }> {
    return this.handlers.map(h => ({
      id: h.id,
      name: h.name,
      family: h.family,
    }));
  }

  /**
   * Run all registered rules sequentially.
   * Returns only alerts whose fingerprint is not on cooldown.
   */
  async run(ctx: RuleContext): Promise<ControlTowerAlert[]> {
    const passed: ControlTowerAlert[] = [];
    const isShadow = ctx.config.mode === 'shadow';

    console.log(`[ControlTower] Engine run starting. ${this.handlers.length} rule(s) registered. Mode: ${ctx.config.mode}`);

    for (const handler of this.handlers) {
      let result: RuleResult;
      try {
        result = await handler.evaluate(ctx);
      } catch (err) {
        console.log(`[ControlTower] Rule ${handler.id} threw an error: ${(err as Error).message}`);
        continue;
      }

      if (result.note) {
        console.log(`[ControlTower] Rule ${handler.id} note: ${result.note}`);
      }

      if (!result.fired) {
        continue;
      }

      // Determine cooldown minutes from the config cooldown map, keyed by family
      const familyKey = handler.family as keyof typeof ctx.config.cooldowns;
      const cooldownMinutes = ctx.config.cooldowns[familyKey] ?? ctx.config.globalCooldownMinutes;

      for (const alert of result.alerts) {
        // Force shadow flag when engine is in shadow mode
        if (isShadow) {
          alert.shadowMode = true;
        }

        if (isCoolingDown(alert.fingerprint, cooldownMinutes)) {
          console.log(`[ControlTower] Alert suppressed by cooldown: ${alert.fingerprint}`);
          continue;
        }

        recordCooldown(alert.fingerprint);
        passed.push(alert);
      }
    }

    console.log(`[ControlTower] Engine run complete. ${passed.length} alert(s) passed cooldown.`);
    return passed;
  }
}
