/**
 * Channel registration store for proactive messaging.
 * Persists channel mappings to a JSON file so the bot can send
 * scheduled reports and alerts to specific Teams channels.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface ChannelRegistration {
  name: string;
  conversationId: string;
  serviceUrl: string;
  teamId?: string;
  registeredBy: string;
  registeredAt: string;
}

const STORE_PATH = resolve(process.cwd(), "data", "channels.json");

function ensureDir(): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function load(): Record<string, ChannelRegistration> {
  try {
    if (existsSync(STORE_PATH)) {
      return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    }
  } catch {
    console.error("[Channels] Failed to load channel store, starting fresh");
  }
  return {};
}

function save(data: Record<string, ChannelRegistration>): void {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function registerChannel(
  name: string,
  conversationId: string,
  serviceUrl: string,
  registeredBy: string,
  teamId?: string
): ChannelRegistration {
  const channels = load();
  const reg: ChannelRegistration = {
    name,
    conversationId,
    serviceUrl,
    teamId,
    registeredBy,
    registeredAt: new Date().toISOString(),
  };
  channels[name] = reg;
  save(channels);
  console.error(`[Channels] Registered "${name}" -> ${conversationId}`);
  return reg;
}

export function getChannel(name: string): ChannelRegistration | undefined {
  const channels = load();
  return channels[name];
}

export function getAllChannels(): Record<string, ChannelRegistration> {
  return load();
}

export function removeChannel(name: string): boolean {
  const channels = load();
  if (channels[name]) {
    delete channels[name];
    save(channels);
    return true;
  }
  return false;
}

/**
 * Known channel purposes for scheduled reports.
 */
export const CHANNEL_NAMES = {
  FINANCE: "finance",
  OPS_CONTROL: "ops",
  MARKETING: "marketplace",
} as const;
