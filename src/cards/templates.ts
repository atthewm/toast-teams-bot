/**
 * Adaptive Card v1.5 templates for Teams bot responses.
 * Returns AdaptiveCard instances from @microsoft/teams.cards.
 */

import { AdaptiveCard, TextBlock, FactSet, Fact } from "@microsoft/teams.cards";

interface FactItem {
  title: string;
  value: string;
}

/**
 * Generic info card with title, body, and optional facts.
 */
export function infoCard(
  title: string,
  body: string,
  facts?: FactItem[]
): AdaptiveCard {
  const elements: Array<TextBlock | FactSet> = [
    new TextBlock(title, { weight: "Bolder", size: "Large", wrap: true }),
    new TextBlock(body, { wrap: true, spacing: "Medium" }),
  ];

  if (facts && facts.length > 0) {
    elements.push(
      new FactSet(...facts.map((f) => new Fact(f.title, f.value)))
    );
  }

  return new AdaptiveCard(...elements);
}

/**
 * Error card for displaying failures.
 */
export function errorCard(title: string, message: string): AdaptiveCard {
  return new AdaptiveCard(
    new TextBlock(title, {
      weight: "Bolder",
      size: "Medium",
      color: "Attention",
      wrap: true,
    }),
    new TextBlock(message, { wrap: true, spacing: "Small" })
  );
}

/**
 * Health check results card.
 */
export function healthCard(data: Record<string, unknown>): AdaptiveCard {
  const overall = data.overall as string;
  const checks = data.checks as Record<
    string,
    { status: string; message: string; durationMs?: number }
  >;
  const config = data.config as Record<string, unknown>;

  const color =
    overall === "healthy"
      ? "Good"
      : overall === "degraded"
        ? "Warning"
        : ("Attention" as const);

  const elements: Array<TextBlock | FactSet> = [
    new TextBlock(
      overall === "healthy"
        ? "Healthy"
        : overall === "degraded"
          ? "Degraded"
          : "Unhealthy",
      { weight: "Bolder", size: "Large", color }
    ),
  ];

  if (checks) {
    const checkFacts = Object.entries(checks).map(
      ([name, check]) =>
        new Fact(
          name,
          `${check.status === "pass" ? "Pass" : "FAIL"}: ${check.message}${
            check.durationMs ? ` (${check.durationMs}ms)` : ""
          }`
        )
    );
    elements.push(new FactSet(...checkFacts));
  }

  if (config) {
    elements.push(
      new FactSet(
        new Fact("Restaurants", String(config.restaurantsConfigured ?? 0)),
        new Fact("Writes", config.writesEnabled ? "Enabled" : "Disabled"),
        new Fact("Dry Run", config.dryRun ? "Yes" : "No")
      )
    );
  }

  return new AdaptiveCard(...elements);
}

/**
 * Menu search results card.
 */
export function menuSearchCard(
  query: string,
  results: Array<{
    item: { name: string; price?: number; guid: string };
    menuName: string;
    groupName: string;
    matchField: string;
  }>
): AdaptiveCard {
  const elements: Array<TextBlock | FactSet> = [
    new TextBlock(`Menu Search: "${query}"`, {
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    }),
    new TextBlock(
      `Found ${results.length} item${results.length === 1 ? "" : "s"}`,
      { isSubtle: true, spacing: "Small" }
    ),
  ];

  // Show results as fact sets (item name : price)
  const itemFacts = results.slice(0, 15).map(
    (r) =>
      new Fact(
        r.item.name,
        `${r.item.price != null ? `$${r.item.price.toFixed(2)}` : "N/A"} (${r.menuName} > ${r.groupName})`
      )
  );

  if (itemFacts.length > 0) {
    elements.push(new FactSet(...itemFacts));
  }

  if (results.length > 15) {
    elements.push(
      new TextBlock(`... and ${results.length - 15} more`, {
        isSubtle: true,
        spacing: "Small",
      })
    );
  }

  return new AdaptiveCard(...elements);
}

/**
 * Order list card.
 */
export function orderListCard(
  orders: Array<{
    guid: string;
    openedDate?: string;
    closedDate?: string;
    server?: { name?: string };
    checks?: Array<{ totalAmount?: number }>;
  }>,
  businessDate?: string
): AdaptiveCard {
  const elements: Array<TextBlock | FactSet> = [
    new TextBlock(
      businessDate ? `Orders for ${businessDate}` : "Recent Orders",
      { weight: "Bolder", size: "Medium" }
    ),
    new TextBlock(
      `${orders.length} order${orders.length === 1 ? "" : "s"}`,
      { isSubtle: true, spacing: "Small" }
    ),
  ];

  const orderFacts = orders.slice(0, 20).map((order) => {
    const total = order.checks
      ?.reduce((sum, c) => sum + (c.totalAmount ?? 0), 0)
      ?.toFixed(2);
    const label = `${order.guid.slice(0, 8)}...${order.server?.name ? ` (${order.server.name})` : ""}`;
    return new Fact(label, total ? `$${total}` : "");
  });

  if (orderFacts.length > 0) {
    elements.push(new FactSet(...orderFacts));
  }

  return new AdaptiveCard(...elements);
}

/**
 * Restaurant config summary card.
 */
export function configCard(data: Record<string, unknown>): AdaptiveCard {
  const restaurant = data.restaurant as Record<string, unknown> | null;
  const revenueCenters = data.revenueCenters as Array<{ name: string }>;
  const diningOptions = data.diningOptions as Array<{ name: string }>;
  const serviceAreas = data.serviceAreas as Array<{ name: string }>;

  const elements: Array<TextBlock | FactSet> = [
    new TextBlock(
      (restaurant?.name as string) ?? "Restaurant Configuration",
      { weight: "Bolder", size: "Large", wrap: true }
    ),
  ];

  if (restaurant) {
    elements.push(
      new FactSet(
        new Fact("Timezone", String(restaurant.timezone ?? "N/A")),
        new Fact("Currency", String(restaurant.currencyCode ?? "N/A"))
      )
    );
  }

  if (revenueCenters?.length > 0) {
    elements.push(
      new TextBlock(`Revenue Centers (${revenueCenters.length})`, {
        weight: "Bolder",
        spacing: "Medium",
      }),
      new TextBlock(revenueCenters.map((rc) => rc.name).join(", "), { wrap: true })
    );
  }

  if (diningOptions?.length > 0) {
    elements.push(
      new TextBlock(`Dining Options (${diningOptions.length})`, {
        weight: "Bolder",
        spacing: "Medium",
      }),
      new TextBlock(diningOptions.map((d) => d.name).join(", "), { wrap: true })
    );
  }

  if (serviceAreas?.length > 0) {
    elements.push(
      new TextBlock(`Service Areas (${serviceAreas.length})`, {
        weight: "Bolder",
        spacing: "Medium",
      }),
      new TextBlock(serviceAreas.map((sa) => sa.name).join(", "), { wrap: true })
    );
  }

  return new AdaptiveCard(...elements);
}
