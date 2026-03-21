# Toast Teams Bot

A Microsoft Teams bot for Toast restaurant operations. Query menus, check orders, monitor system health, and receive operational alerts directly in Teams.

## Architecture

```
[Teams User] <> [This Bot] <> [Toast MCP Server] <> [Toast API]
                    |
             MCP Client
         (Streamable HTTP)
```

This bot acts as an MCP client, connecting to a separately deployed [Toast MCP Server](https://github.com/atthewm/toast-mcp-server) that handles Toast API authentication and data access. The bot handles Teams specific concerns: message routing, Adaptive Cards, proactive messaging, and user interaction.

## Features

### Interactive Commands

| Command | Description |
|---------|-------------|
| `health` | Run a full system health check |
| `menus` | Show menu overview |
| `menu search [term]` | Search menu items by keyword |
| `orders` | List today's orders |
| `order [guid]` | Get details for a specific order |
| `config` | Show restaurant configuration |
| `status` | Check Toast API authentication status |
| `capabilities` | Show available features |

### Adaptive Cards

All responses are rendered as Adaptive Cards v1.5 with:
- Full width layouts for readability
- FactSets for structured data
- Color coded health status indicators
- Menu items with prices and categories
- Order lists with server names and totals

### Proactive Messaging (Foundation)

The bot stores conversation references and includes a proactive messenger module for sending alerts to Teams channels. When combined with event ingestion on the MCP server side, this enables:
- Health check failure alerts
- Order volume threshold notifications
- Menu change notifications

## Prerequisites

1. **Toast MCP Server** deployed and accessible via HTTP (see [toast-mcp-server](https://github.com/atthewm/toast-mcp-server))
2. **Azure Bot Registration** (single tenant)
3. Node.js 18+

## Setup

### 1. Register an Azure Bot

1. Go to the [Azure Portal](https://portal.azure.com)
2. Create a new "Azure Bot" resource
3. Select "Single Tenant" for the bot type
4. Note the **App ID**, **App Password**, and **Tenant ID**

### 2. Configure

```bash
cp .env.example .env
```

Fill in:
- `BOT_ID`, `BOT_PASSWORD`, `BOT_TENANT_ID` from Azure Bot registration
- `MCP_SERVER_URL` pointing to your Toast MCP Server HTTP endpoint
- `MCP_API_KEY` if your MCP server requires authentication

### 3. Install and Build

```bash
npm install
npm run build
```

### 4. Run

```bash
npm start
```

The bot listens on port 3978 by default (configurable via `PORT`).

### 5. Test Locally

Use the [Bot Framework Emulator](https://github.com/Microsoft/BotFramework-Emulator) or [Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/) to test locally before deploying.

### 6. Deploy to Teams

1. Update `appPackage/manifest.json` with your Bot ID
2. Add icon files (`color.png` 192x192, `outline.png` 32x32) to `appPackage/`
3. Zip the contents of `appPackage/` into a `.zip` file
4. Upload to Teams Admin Center or sideload for testing

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| BOT_ID | Yes | | Azure Bot App ID |
| BOT_PASSWORD | Yes | | Azure Bot App Password |
| BOT_TENANT_ID | Yes | | Azure AD Tenant ID |
| BOT_TYPE | No | SingleTenant | Bot type |
| MCP_SERVER_URL | Yes | | Toast MCP Server HTTP endpoint |
| MCP_API_KEY | No | | API key for MCP server auth |
| PORT | No | 3978 | HTTP server port |
| ALERT_CHANNEL_ID | No | | Teams channel ID for alerts |
| LOG_LEVEL | No | info | Logging verbosity |

## Deployment

### Docker

```bash
docker build -t toast-teams-bot .
docker run -p 3978:3978 --env-file .env toast-teams-bot
```

### Azure Container Apps

```bash
az containerapp create \
  --name toast-teams-bot \
  --resource-group your-rg \
  --environment your-env \
  --image your-registry/toast-teams-bot:latest \
  --target-port 3978 \
  --ingress external \
  --env-vars \
    BOT_ID=secretref:bot-id \
    BOT_PASSWORD=secretref:bot-password \
    BOT_TENANT_ID=your-tenant-id \
    MCP_SERVER_URL=https://your-mcp-server.com/mcp \
    MCP_API_KEY=secretref:mcp-api-key
```

Set the Azure Bot's messaging endpoint to:
`https://your-app.azurecontainerapps.io/api/messages`

## Project Structure

```
src/
  bot/
    handler.ts      # Message routing and command handling
    proactive.ts    # Proactive messaging to Teams channels
  cards/
    templates.ts    # Adaptive Card v1.5 templates
  config/
    index.ts        # Environment configuration
  mcp/
    client.ts       # MCP client for Toast MCP Server
  index.ts          # Entry point (Express + Bot Framework)
appPackage/
  manifest.json     # Teams app manifest
```

## Roadmap

- Event driven alerts (health failures, order thresholds)
- AI powered natural language queries (LLM integration)
- Dashboard summary cards with charts
- Shift and labor data views
- Multi location support
- Copilot Studio agent as an alternative deployment path

## License

MIT
