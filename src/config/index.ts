import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export interface BotConfig {
  botId: string;
  botPassword: string;
  botTenantId: string;
  mcpServerUrl: string;
  mcpApiKey: string | undefined;
  port: number;
  logLevel: string;
  // AI
  openaiApiKey: string;
  openaiModel: string;
  // Scheduling
  timezone: string;
  // RBAC
  adminGroupId: string | undefined;
  managerGroupId: string | undefined;
  // Alert thresholds
  largeOrderDollars: number;
  largeOrderItems: number;
  highVoidCount: number;
  longOpenMinutes: number;
  // MarginEdge MCP
  marginedgeMcpUrl: string | undefined;
  // Intelligence thresholds
  dtOutlierMultiplier: number;
  dtTrendThreshold: number;
  slowPeriodThreshold: number;
  platformDroughtMinutes: number;
  revenuePacingThreshold: number;
  voidClusterCount: number;
  voidClusterWindow: number;
  rushEntryMultiplier: number;
  rushExitMultiplier: number;
  hourlyPulseDeviation: number;
  shiftPerfMinOrders: number;
  rollingWindowMinutes: number;
  // Labor and projection thresholds
  laborBreachPercent: number;
  projectedMissPercent: number;
}

export function loadConfig(): BotConfig {
  loadDotEnv(resolve(process.cwd(), ".env"));

  const env = process.env;

  // Support both naming conventions
  const botId = env.ENTRA_APP_CLIENT_ID ?? env.BOT_ID;
  const botPassword = env.ENTRA_APP_CLIENT_SECRET ?? env.BOT_PASSWORD;
  const botTenantId = env.ENTRA_TENANT_ID ?? env.BOT_TENANT_ID;
  const mcpServerUrl = env.MCP_SERVER_URL;
  const openaiApiKey = env.OPENAI_API_KEY;

  const missing: string[] = [];
  if (!botId) missing.push("ENTRA_APP_CLIENT_ID (or BOT_ID)");
  if (!botPassword) missing.push("ENTRA_APP_CLIENT_SECRET (or BOT_PASSWORD)");
  if (!botTenantId) missing.push("ENTRA_TENANT_ID (or BOT_TENANT_ID)");
  if (!mcpServerUrl) missing.push("MCP_SERVER_URL");
  if (!openaiApiKey) missing.push("OPENAI_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        `Copy .env.example to .env and fill in the values.`
    );
  }

  return {
    botId: botId!,
    botPassword: botPassword!,
    botTenantId: botTenantId!,
    mcpServerUrl: mcpServerUrl!,
    mcpApiKey: env.MCP_API_KEY,
    port: parseInt(env.PORT ?? "3978", 10),
    logLevel: env.LOG_LEVEL ?? "info",
    openaiApiKey: openaiApiKey!,
    openaiModel: env.OPENAI_MODEL ?? "gpt-4o",
    marginedgeMcpUrl: env.MARGINEDGE_MCP_URL,
    timezone: env.TIMEZONE ?? "America/Chicago",
    adminGroupId: env.ADMIN_GROUP_ID,
    managerGroupId: env.MANAGER_GROUP_ID,
    largeOrderDollars: parseInt(env.LARGE_ORDER_DOLLARS ?? "50", 10),
    largeOrderItems: parseInt(env.LARGE_ORDER_ITEMS ?? "10", 10),
    highVoidCount: parseInt(env.HIGH_VOID_COUNT ?? "3", 10),
    longOpenMinutes: parseInt(env.LONG_OPEN_MINUTES ?? "30", 10),
    dtOutlierMultiplier: parseFloat(env.DT_OUTLIER_MULTIPLIER ?? "2.0"),
    dtTrendThreshold: parseFloat(env.DT_TREND_THRESHOLD ?? "0.20"),
    slowPeriodThreshold: parseFloat(env.SLOW_PERIOD_THRESHOLD ?? "0.50"),
    platformDroughtMinutes: parseInt(env.PLATFORM_DROUGHT_MINUTES ?? "45", 10),
    revenuePacingThreshold: parseFloat(env.REVENUE_PACING_THRESHOLD ?? "0.20"),
    voidClusterCount: parseInt(env.VOID_CLUSTER_COUNT ?? "3", 10),
    voidClusterWindow: parseInt(env.VOID_CLUSTER_WINDOW ?? "7", 10),
    rushEntryMultiplier: parseFloat(env.RUSH_ENTRY_MULTIPLIER ?? "1.5"),
    rushExitMultiplier: parseFloat(env.RUSH_EXIT_MULTIPLIER ?? "1.0"),
    hourlyPulseDeviation: parseFloat(env.HOURLY_PULSE_DEVIATION ?? "0.15"),
    shiftPerfMinOrders: parseInt(env.SHIFT_PERF_MIN_ORDERS ?? "5", 10),
    rollingWindowMinutes: parseInt(env.ROLLING_WINDOW_MINUTES ?? "30", 10),
    laborBreachPercent: parseFloat(env.LABOR_BREACH_PERCENT ?? "0.35"),
    projectedMissPercent: parseFloat(env.PROJECTED_MISS_PERCENT ?? "0.25"),
  };
}
