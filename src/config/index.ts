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
  botType: string;
  mcpServerUrl: string;
  mcpApiKey: string | undefined;
  port: number;
  alertChannelId: string | undefined;
  alertTeamId: string | undefined;
  logLevel: string;
}

export function loadConfig(): BotConfig {
  loadDotEnv(resolve(process.cwd(), ".env"));

  const env = process.env;

  const botId = env.BOT_ID;
  const botPassword = env.BOT_PASSWORD;
  const botTenantId = env.BOT_TENANT_ID;
  const mcpServerUrl = env.MCP_SERVER_URL;

  const missing: string[] = [];
  if (!botId) missing.push("BOT_ID");
  if (!botPassword) missing.push("BOT_PASSWORD");
  if (!botTenantId) missing.push("BOT_TENANT_ID");
  if (!mcpServerUrl) missing.push("MCP_SERVER_URL");

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
    botType: env.BOT_TYPE ?? "SingleTenant",
    mcpServerUrl: mcpServerUrl!,
    mcpApiKey: env.MCP_API_KEY,
    port: parseInt(env.PORT ?? "3978", 10),
    alertChannelId: env.ALERT_CHANNEL_ID,
    alertTeamId: env.ALERT_TEAM_ID,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
