/**
 * Control tower configuration loader.
 * Reads from config/control-tower.json with all thresholds.
 * Falls back to sensible defaults if the file is missing.
 * Merges environment variables where applicable.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ */
/*  Threshold subtypes                                                */
/* ------------------------------------------------------------------ */

export interface ReadinessThresholds {
  target: number;
  yellowThreshold: number;
  redThreshold: number;
  morningRunHour: number;
  escalationHour: number;
  weights: {
    invoicesCaptured: number;
    recipeCoverage: number;
    productMapping: number;
    inventoryRecency: number;
    vendorMapping: number;
    unmappedIngredients: number;
  };
}

export interface PrimeCostThresholds {
  laborTarget: number;
  cogsTarget: number;
  primeCostTarget: number;
  dailySalesTarget: number;
  laborYellowThreshold: number;
  laborRedThreshold: number;
  cogsYellowThreshold: number;
  cogsRedThreshold: number;
  primeCostYellowThreshold: number;
  primeCostRedThreshold: number;
  salesDeviationYellow: number;
  salesDeviationRed: number;
  trailingDays: number;
}

export interface ItemMarginThresholds {
  minMarginPercent: number;
  compressionTolerancePercent: number;
  topSellerThreshold: number;
  highVolumeMinUnits: number;
}

export interface VendorPriceThresholds {
  spikeThresholdPercent: number;
  weekOverWeekThreshold: number;
  trailingMedianDays: number;
  volatilityWindowDays: number;
}

export interface SalesPaceThresholds {
  belowPaceYellow: number;
  belowPaceRed: number;
  abovePaceNotable: number;
  trailingWeekdayCount: number;
  checkHours: number[];
}

export interface LaborThresholds {
  laborPercentYellow: number;
  laborPercentRed: number;
  overtimeHoursThreshold: number;
}

export interface DiscountCompVoidThresholds {
  discountPercentYellow: number;
  discountPercentRed: number;
  voidPercentYellow: number;
  voidPercentRed: number;
  compPercentYellow: number;
  compPercentRed: number;
  refundPercentYellow: number;
  refundPercentRed: number;
  totalExceptionPercentYellow: number;
  totalExceptionPercentRed: number;
  trailingSpikeMultiplier: number;
}

export interface StockoutThresholds {
  highMarginThreshold: number;
  highVelocityMinDaily: number;
  revenueLossAlertThreshold: number;
}

export interface AllThresholds {
  readiness: ReadinessThresholds;
  primeCost: PrimeCostThresholds;
  itemMargin: ItemMarginThresholds;
  vendorPrice: VendorPriceThresholds;
  salesPace: SalesPaceThresholds;
  labor: LaborThresholds;
  discountCompVoid: DiscountCompVoidThresholds;
  stockout: StockoutThresholds;
}

/* ------------------------------------------------------------------ */
/*  Cooldowns and owners                                              */
/* ------------------------------------------------------------------ */

export interface CooldownWindows {
  readiness: number;
  primeCost: number;
  itemMargin: number;
  vendorPrice: number;
  salesPace: number;
  labor: number;
  discountCompVoid: number;
  stockout: number;
}

export interface OwnerDefaults {
  readiness: string;
  primeCost: string;
  itemMargin: string;
  vendorPrice: string;
  salesPace: string;
  labor: string;
  discountCompVoid: string;
  stockout: string;
}

/* ------------------------------------------------------------------ */
/*  Schedules                                                         */
/* ------------------------------------------------------------------ */

export interface RuleSchedules {
  morningReadiness: string;
  readinessEscalation: string;
  dailyPrimeCost: string;
  itemMarginWeekly: string;
  vendorPriceDaily: string;
  salesPaceMidDay: string;
  salesPaceAfternoon: string;
  laborEfficiency: string;
  discountCompVoid: string;
  stockoutCheck: string;
  dailyOpsDigest: string;
  weeklyExecSummary: string;
}

/* ------------------------------------------------------------------ */
/*  Watchlists and category targets                                   */
/* ------------------------------------------------------------------ */

export interface Watchlists {
  keyIngredients: string[];
  keyMenuItems: string[];
  keyVendors: string[];
}

export interface CategoryTarget {
  cogsTarget: number;
  marginTarget: number;
}

/* ------------------------------------------------------------------ */
/*  Top level config                                                  */
/* ------------------------------------------------------------------ */

export interface ControlTowerConfig {
  mode: "shadow" | "live";
  pilotChannel: string;
  globalCooldownMinutes: number;
  schedules: RuleSchedules;
  thresholds: AllThresholds;
  cooldowns: CooldownWindows;
  ownerDefaults: OwnerDefaults;
  watchlists: Watchlists;
  categoryTargets: Record<string, CategoryTarget>;
  /** MarginEdge MCP server URL, from MARGINEDGE_MCP_URL env var */
  marginEdgeMcpUrl: string;
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_SCHEDULES: RuleSchedules = {
  morningReadiness: "0 7 * * *",
  readinessEscalation: "0 10 * * *",
  dailyPrimeCost: "0 7 * * *",
  itemMarginWeekly: "0 8 * * 1",
  vendorPriceDaily: "0 7 * * *",
  salesPaceMidDay: "0 13 * * *",
  salesPaceAfternoon: "0 16 * * *",
  laborEfficiency: "0 7 * * *",
  discountCompVoid: "0 7 * * *",
  stockoutCheck: "0 9 * * *",
  dailyOpsDigest: "0 18 * * *",
  weeklyExecSummary: "0 8 * * 1",
};

const DEFAULT_THRESHOLDS: AllThresholds = {
  readiness: {
    target: 85,
    yellowThreshold: 85,
    redThreshold: 70,
    morningRunHour: 7,
    escalationHour: 10,
    weights: {
      invoicesCaptured: 25,
      recipeCoverage: 25,
      productMapping: 20,
      inventoryRecency: 15,
      vendorMapping: 10,
      unmappedIngredients: 5,
    },
  },
  primeCost: {
    laborTarget: 0.30,
    cogsTarget: 0.30,
    primeCostTarget: 0.60,
    dailySalesTarget: 2500,
    laborYellowThreshold: 0.33,
    laborRedThreshold: 0.38,
    cogsYellowThreshold: 0.33,
    cogsRedThreshold: 0.38,
    primeCostYellowThreshold: 0.63,
    primeCostRedThreshold: 0.68,
    salesDeviationYellow: 0.15,
    salesDeviationRed: 0.25,
    trailingDays: 28,
  },
  itemMargin: {
    minMarginPercent: 0.65,
    compressionTolerancePercent: 0.05,
    topSellerThreshold: 10,
    highVolumeMinUnits: 20,
  },
  vendorPrice: {
    spikeThresholdPercent: 0.10,
    weekOverWeekThreshold: 0.05,
    trailingMedianDays: 30,
    volatilityWindowDays: 90,
  },
  salesPace: {
    belowPaceYellow: 0.15,
    belowPaceRed: 0.25,
    abovePaceNotable: 0.20,
    trailingWeekdayCount: 4,
    checkHours: [10, 13, 16],
  },
  labor: {
    laborPercentYellow: 0.33,
    laborPercentRed: 0.38,
    overtimeHoursThreshold: 4,
  },
  discountCompVoid: {
    discountPercentYellow: 0.05,
    discountPercentRed: 0.10,
    voidPercentYellow: 0.02,
    voidPercentRed: 0.05,
    compPercentYellow: 0.03,
    compPercentRed: 0.05,
    refundPercentYellow: 0.02,
    refundPercentRed: 0.04,
    totalExceptionPercentYellow: 0.05,
    totalExceptionPercentRed: 0.08,
    trailingSpikeMultiplier: 2.0,
  },
  stockout: {
    highMarginThreshold: 0.70,
    highVelocityMinDaily: 15,
    revenueLossAlertThreshold: 50,
  },
};

const DEFAULT_COOLDOWNS: CooldownWindows = {
  readiness: 720,
  primeCost: 1440,
  itemMargin: 10080,
  vendorPrice: 1440,
  salesPace: 240,
  labor: 480,
  discountCompVoid: 1440,
  stockout: 240,
};

const DEFAULT_OWNER_DEFAULTS: OwnerDefaults = {
  readiness: "manager",
  primeCost: "manager",
  itemMargin: "manager",
  vendorPrice: "manager",
  salesPace: "shift_lead",
  labor: "manager",
  discountCompVoid: "manager",
  stockout: "shift_lead",
};

const DEFAULT_WATCHLISTS: Watchlists = {
  keyIngredients: [
    "espresso beans",
    "whole milk",
    "oat milk",
    "flour tortillas",
    "eggs",
    "bacon",
    "sausage",
    "cheese",
    "avocado",
    "vanilla syrup",
    "caramel syrup",
    "chocolate syrup",
    "cups (16oz)",
    "cups (20oz)",
    "lids",
  ],
  keyMenuItems: [],
  keyVendors: [],
};

const DEFAULT_CATEGORY_TARGETS: Record<string, CategoryTarget> = {
  Food: { cogsTarget: 0.32, marginTarget: 0.68 },
  "N/A Bev": { cogsTarget: 0.25, marginTarget: 0.75 },
};

/* ------------------------------------------------------------------ */
/*  Deep merge utility                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Recursively merge source into target. Source values override target,
 * with nested objects merged rather than replaced wholesale.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (key.startsWith("_comment")) continue;
    const srcVal = source[key];
    const tgtVal = result[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Config loader                                                     */
/* ------------------------------------------------------------------ */

const CONFIG_PATH = resolve(process.cwd(), "config", "control-tower.json");

/**
 * Load the control tower configuration.
 *
 * Reads from config/control-tower.json if it exists, then deep merges
 * the file contents over the built in defaults. Environment variables
 * override specific fields:
 *   MARGINEDGE_MCP_URL  -> marginEdgeMcpUrl
 *   CT_MODE             -> mode (shadow or live)
 *   CT_PILOT_CHANNEL    -> pilotChannel
 */
export function loadControlTowerConfig(): ControlTowerConfig {
  const defaults: ControlTowerConfig = {
    mode: "shadow",
    pilotChannel: "shadow-pilot",
    globalCooldownMinutes: 120,
    schedules: { ...DEFAULT_SCHEDULES },
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
    cooldowns: { ...DEFAULT_COOLDOWNS },
    ownerDefaults: { ...DEFAULT_OWNER_DEFAULTS },
    watchlists: structuredClone(DEFAULT_WATCHLISTS),
    categoryTargets: structuredClone(DEFAULT_CATEGORY_TARGETS),
    marginEdgeMcpUrl: "",
  };

  /* Merge from JSON file if present */
  let config = defaults;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      config = deepMerge(
        defaults as unknown as Record<string, unknown>,
        parsed
      ) as unknown as ControlTowerConfig;
      console.log("[ControlTower] Loaded config from", CONFIG_PATH);
    } catch (err) {
      console.error(
        "[ControlTower] Failed to parse config file, using defaults:",
        (err as Error).message
      );
    }
  } else {
    console.log("[ControlTower] No config file found, using defaults");
  }

  /* Environment variable overrides */
  const env = process.env;

  if (env.MARGINEDGE_MCP_URL) {
    config.marginEdgeMcpUrl = env.MARGINEDGE_MCP_URL;
  }

  if (env.CT_MODE === "shadow" || env.CT_MODE === "live") {
    config.mode = env.CT_MODE;
  }

  if (env.CT_PILOT_CHANNEL) {
    config.pilotChannel = env.CT_PILOT_CHANNEL;
  }

  return config;
}
