/**
 * Escalation tracker for Tier 2 conditions.
 * Uses an in memory Map keyed by condition identifier.
 * If a condition persists for 30+ minutes, returns an escalation message.
 */

const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface TrackedCondition {
  firstSeen: number;
  lastSeen: number;
  message: string;
  escalated: boolean;
}

/** In memory store of active conditions. */
const conditions = new Map<string, TrackedCondition>();

/**
 * Track a condition. If this is the first time seeing it, record the timestamp.
 * If the condition has persisted for 30+ minutes, return an escalation message.
 * Returns null if no escalation is needed yet.
 */
export function trackCondition(key: string, message: string): string | null {
  const now = Date.now();
  const existing = conditions.get(key);

  if (!existing) {
    conditions.set(key, {
      firstSeen: now,
      lastSeen: now,
      message,
      escalated: false,
    });
    return null;
  }

  existing.lastSeen = now;
  existing.message = message;

  const elapsed = now - existing.firstSeen;
  if (elapsed >= ESCALATION_THRESHOLD_MS && !existing.escalated) {
    existing.escalated = true;
    const minutes = Math.round(elapsed / 60000);
    return (
      `**Escalation: Persistent Condition**\n\n` +
      `The following condition has been active for **${minutes} minutes**:\n\n` +
      `${message}\n\n` +
      `This may need management attention.`
    );
  }

  return null;
}

/**
 * Clear a condition that is no longer active.
 */
export function clearCondition(key: string): void {
  conditions.delete(key);
}

/**
 * Remove any tracked conditions whose keys are not in the active set.
 * Call this each cycle with the keys that are still firing.
 * Returns the number of pruned entries.
 */
export function pruneStaleConditions(activeKeys: Set<string>): number {
  let pruned = 0;
  for (const key of conditions.keys()) {
    if (!activeKeys.has(key)) {
      conditions.delete(key);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Get the count of currently tracked conditions (for diagnostics).
 */
export function getTrackedCount(): number {
  return conditions.size;
}
