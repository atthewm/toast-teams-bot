import {
  ActivityHandler,
  CardFactory,
  TurnContext,
  ConversationReference,
  type Activity,
} from "botbuilder";
import type { ToastMcpClient } from "../mcp/client.js";
import {
  infoCard,
  errorCard,
  healthCard,
  menuSearchCard,
  configCard,
  orderListCard,
} from "../cards/templates.js";

/**
 * Teams bot that routes natural language queries to Toast MCP tools
 * and responds with Adaptive Cards.
 *
 * Supports both direct commands and conversational queries.
 */
export class ToastBot extends ActivityHandler {
  // Store conversation references for proactive messaging
  private conversationReferences: Map<string, Partial<ConversationReference>> =
    new Map();

  constructor(private readonly mcp: ToastMcpClient) {
    super();

    // Handle incoming messages
    this.onMessage(async (context, next) => {
      const text = (context.activity.text ?? "").trim().toLowerCase();
      await this.routeMessage(context, text);
      await next();
    });

    // Store conversation reference when bot is added to a conversation
    this.onConversationUpdate(async (context, next) => {
      const ref = TurnContext.getConversationReference(
        context.activity as Activity
      );
      if (ref.conversation?.id) {
        this.conversationReferences.set(ref.conversation.id, ref);
      }
      await next();
    });

    // Handle bot installation
    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            "Hello! I am the Toast Operations Bot. I can help you query " +
              "restaurant data, search menus, check orders, and monitor system health.\n\n" +
              "Try: **health**, **menu search [term]**, **orders**, **config**, or **help**"
          );
        }
      }
      await next();
    });
  }

  /**
   * Route a user message to the appropriate handler.
   */
  private async routeMessage(
    context: TurnContext,
    text: string
  ): Promise<void> {
    try {
      // Direct commands
      if (text === "help" || text === "?") {
        await this.handleHelp(context);
      } else if (text === "health" || text === "healthcheck") {
        await this.handleHealthCheck(context);
      } else if (text.startsWith("menu search ") || text.startsWith("search menu ")) {
        const query = text.replace(/^(menu search |search menu )/, "").trim();
        await this.handleMenuSearch(context, query);
      } else if (text === "menu" || text === "menus") {
        await this.handleMenuOverview(context);
      } else if (text === "orders" || text === "today orders" || text === "orders today") {
        await this.handleOrders(context);
      } else if (text === "config" || text === "configuration") {
        await this.handleConfig(context);
      } else if (text === "status" || text === "auth") {
        await this.handleAuthStatus(context);
      } else if (text === "capabilities") {
        await this.handleCapabilities(context);
      } else if (text.startsWith("order ")) {
        const guid = text.replace("order ", "").trim();
        await this.handleGetOrder(context, guid);
      } else {
        await this.handleUnknown(context, text);
      }
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "An unexpected error occurred";
      const card = errorCard("Something went wrong", msg);
      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
    }
  }

  private async handleHelp(context: TurnContext): Promise<void> {
    const card = infoCard(
      "Toast Operations Bot",
      "Available commands:",
      [
        { title: "health", value: "Run a full system health check" },
        { title: "menu search [term]", value: "Search menu items by keyword" },
        { title: "menus", value: "Show menu overview" },
        { title: "orders", value: "List today's orders" },
        { title: "order [guid]", value: "Get details for a specific order" },
        { title: "config", value: "Show restaurant configuration" },
        { title: "status", value: "Check authentication status" },
        { title: "capabilities", value: "Show available features" },
      ]
    );
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleHealthCheck(context: TurnContext): Promise<void> {
    await context.sendActivity("Running health check...");
    const data = await this.mcp.callToolJson("toast_healthcheck");
    const card = healthCard(data as Record<string, unknown>);
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleMenuSearch(
    context: TurnContext,
    query: string
  ): Promise<void> {
    if (!query) {
      await context.sendActivity('Please provide a search term. Example: **menu search espresso**');
      return;
    }

    await context.sendActivity(`Searching menus for "${query}"...`);
    const data = await this.mcp.callToolJson<{
      query: string;
      resultCount: number;
      results: Array<{
        item: { name: string; price?: number; guid: string };
        menuName: string;
        groupName: string;
        matchField: string;
      }>;
    }>("toast_search_menu_items", { query });

    if (!data.results || data.results.length === 0) {
      await context.sendActivity(`No menu items found matching "${query}".`);
      return;
    }

    const card = menuSearchCard(query, data.results);
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleMenuOverview(context: TurnContext): Promise<void> {
    const data = await this.mcp.callToolJson<{
      menuCount: number;
      menus: Array<{ guid: string; name: string; groupCount: number }>;
    }>("toast_get_menu_metadata");

    const facts = data.menus.map((m) => ({
      title: m.name,
      value: `${m.groupCount} group${m.groupCount === 1 ? "" : "s"}`,
    }));

    const card = infoCard(
      `Menus (${data.menuCount})`,
      "Available menus for this restaurant:",
      facts
    );
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleOrders(context: TurnContext): Promise<void> {
    await context.sendActivity("Fetching today's orders...");
    const today = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    const data = await this.mcp.callToolJson<{
      count: number;
      orders: Array<{
        guid: string;
        openedDate?: string;
        closedDate?: string;
        server?: { name?: string };
        checks?: Array<{ totalAmount?: number }>;
      }>;
    }>("toast_list_orders", { businessDate: today });

    if (data.orders.length === 0) {
      await context.sendActivity("No orders found for today.");
      return;
    }

    const card = orderListCard(data.orders, today);
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleGetOrder(
    context: TurnContext,
    guid: string
  ): Promise<void> {
    const data = await this.mcp.callToolJson("toast_get_order", {
      orderGuid: guid,
    });

    const card = infoCard(
      `Order ${guid.slice(0, 8)}...`,
      "Order details:",
      [{ title: "Data", value: JSON.stringify(data, null, 2).slice(0, 500) }]
    );
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleConfig(context: TurnContext): Promise<void> {
    const data = await this.mcp.callToolJson("toast_get_config_summary");
    const card = configCard(data as Record<string, unknown>);
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleAuthStatus(context: TurnContext): Promise<void> {
    const data = await this.mcp.callToolJson<Record<string, unknown>>(
      "toast_auth_status"
    );

    const card = infoCard(
      "Authentication Status",
      data.authenticated ? "Connected to Toast API" : "Not authenticated",
      [
        { title: "Authenticated", value: String(data.authenticated) },
        { title: "API Host", value: String(data.apiHost) },
        {
          title: "Restaurants",
          value: String(
            (data.configuredRestaurants as string[])?.length ?? 0
          ),
        },
        { title: "Writes Enabled", value: String(data.writesEnabled) },
      ]
    );
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  private async handleCapabilities(context: TurnContext): Promise<void> {
    const data = await this.mcp.callToolJson<Record<string, unknown>>(
      "toast_api_capabilities"
    );

    await context.sendActivity({
      attachments: [
        CardFactory.adaptiveCard(
          infoCard(
            "API Capabilities",
            JSON.stringify(data, null, 2).slice(0, 1000)
          )
        ),
      ],
    });
  }

  private async handleUnknown(
    context: TurnContext,
    text: string
  ): Promise<void> {
    // Try to be helpful
    if (text.length < 2) {
      await context.sendActivity('Type **help** to see available commands.');
      return;
    }

    // Attempt a menu search as fallback
    await this.handleMenuSearch(context, text);
  }

  /**
   * Get all stored conversation references (for proactive messaging).
   */
  getConversationReferences(): Map<string, Partial<ConversationReference>> {
    return this.conversationReferences;
  }
}
