/**
 * Simple alert persistence for the control tower.
 *
 * Stores alerts as a JSON array in data/control-tower-alerts.json.
 * Prunes entries older than 30 days on each write to keep the
 * file size manageable.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { ControlTowerAlert } from "./models.js";

const LOG_PATH = resolve(process.cwd(), "data", "control-tower-alerts.json");
const PRUNE_DAYS = 30;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function ensureDir(): void {
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readFile(): ControlTowerAlert[] {
  try {
    if (existsSync(LOG_PATH)) {
      const raw = readFileSync(LOG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as ControlTowerAlert[];
      }
    }
  } catch (err) {
    console.log(
      "[ControlTower] Failed to read alert log, starting fresh:",
      (err as Error).message
    );
  }
  return [];
}

function writeFile(alerts: ControlTowerAlert[]): void {
  ensureDir();
  writeFileSync(LOG_PATH, JSON.stringify(alerts, null, 2), "utf-8");
}

/**
 * Remove entries older than PRUNE_DAYS from the array.
 * Returns a new array with only recent entries.
 */
function pruneOld(alerts: ControlTowerAlert[]): ControlTowerAlert[] {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  return alerts.filter((a) => {
    const ts = new Date(a.createdAt).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Append an alert to the log file. Automatically prunes entries
 * older than 30 days to keep the file compact.
 */
export function logAlert(alert: ControlTowerAlert): void {
  try {
    const existing = readFile();
    existing.push(alert);
    const pruned = pruneOld(existing);
    writeFile(pruned);
    console.log(
      `[ControlTower] Logged alert: ${alert.ruleId} (${alert.severity}) [${pruned.length} total in log]`
    );
  } catch (err) {
    console.log(
      "[ControlTower] Failed to log alert:",
      (err as Error).message
    );
  }
}

/**
 * Load all alerts from the log file.
 */
export function loadAlertLog(): ControlTowerAlert[] {
  return readFile();
}

/**
 * Get alerts from the last N days.
 */
export function getRecentAlerts(days: number): ControlTowerAlert[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = readFile();
  return all.filter((a) => {
    const ts = new Date(a.createdAt).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });
}
