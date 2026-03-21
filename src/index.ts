#!/usr/bin/env node

import express from "express";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
} from "botbuilder";
import { loadConfig } from "./config/index.js";
import { ToastMcpClient } from "./mcp/client.js";
import { ToastBot } from "./bot/handler.js";
import { ProactiveMessenger } from "./bot/proactive.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Bot Framework authentication
  const botAuthConfig: ConfigurationBotFrameworkAuthenticationOptions = {
    MicrosoftAppId: config.botId,
    MicrosoftAppPassword: config.botPassword,
    MicrosoftAppTenantId: config.botTenantId,
    MicrosoftAppType: config.botType,
  };

  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
    botAuthConfig
  );
  const adapter = new CloudAdapter(botFrameworkAuth);

  // Error handler
  adapter.onTurnError = async (context, error) => {
    console.error(`[Bot] Unhandled error: ${error.message}`);
    await context.sendActivity(
      "Sorry, something went wrong. Please try again."
    );
  };

  // MCP client for Toast data
  const mcpClient = new ToastMcpClient(config.mcpServerUrl, config.mcpApiKey);

  // Connect to MCP server
  try {
    await mcpClient.connect();
    console.error(`[Bot] Connected to Toast MCP server at ${config.mcpServerUrl}`);
  } catch (error) {
    console.error(
      `[Bot] Warning: Could not connect to MCP server: ${
        error instanceof Error ? error.message : error
      }`
    );
    console.error("[Bot] Bot will attempt to reconnect on first message.");
  }

  // Create bot
  const bot = new ToastBot(mcpClient);

  // Proactive messenger (for future alert integration)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const messenger = new ProactiveMessenger(adapter, config.botId);
  void messenger; // Will be used when event ingestion is implemented

  // Express server
  const app = express();
  app.use(express.json());

  // Bot Framework messages endpoint
  app.post("/api/messages", async (req, res) => {
    await adapter.process(req, res, (context) => bot.run(context));
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mcpConnected: mcpClient.isConnected(),
      toolCount: mcpClient.getTools().length,
    });
  });

  // Start server
  app.listen(config.port, () => {
    console.error(`[Bot] Toast Teams Bot listening on port ${config.port}`);
    console.error(`[Bot] Messages endpoint: http://localhost:${config.port}/api/messages`);
  });
}

main().catch((error) => {
  console.error(`[Bot] Fatal error: ${error.message}`);
  process.exit(1);
});
