/**
 * Adaptive Card v1.5 templates for Teams bot responses.
 * All cards use the msteams full width property for better readability.
 */

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
): Record<string, unknown> {
  const cardBody: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: title,
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: body,
      wrap: true,
      spacing: "Medium",
    },
  ];

  if (facts && facts.length > 0) {
    cardBody.push({
      type: "FactSet",
      facts: facts.map((f) => ({ title: f.title, value: f.value })),
      spacing: "Medium",
    });
  }

  return wrapCard(cardBody);
}

/**
 * Error card for displaying failures.
 */
export function errorCard(title: string, message: string): Record<string, unknown> {
  return wrapCard([
    {
      type: "TextBlock",
      text: title,
      weight: "Bolder",
      size: "Medium",
      color: "Attention",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: message,
      wrap: true,
      spacing: "Small",
    },
  ]);
}

/**
 * Health check results card.
 */
export function healthCard(data: Record<string, unknown>): Record<string, unknown> {
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
        : "Attention";

  const body: Array<Record<string, unknown>> = [
    {
      type: "ColumnSet",
      columns: [
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: overall === "healthy" ? "Healthy" : overall === "degraded" ? "Degraded" : "Unhealthy",
              weight: "Bolder",
              size: "Large",
              color,
            },
          ],
        },
      ],
    },
  ];

  // Add each check as a fact
  if (checks) {
    const facts = Object.entries(checks).map(([name, check]) => ({
      title: name,
      value: `${check.status === "pass" ? "Pass" : "FAIL"}: ${check.message}${
        check.durationMs ? ` (${check.durationMs}ms)` : ""
      }`,
    }));

    body.push({
      type: "FactSet",
      facts,
      spacing: "Medium",
    });
  }

  // Config summary
  if (config) {
    body.push({
      type: "FactSet",
      facts: [
        {
          title: "Restaurants",
          value: String(config.restaurantsConfigured ?? 0),
        },
        {
          title: "Writes",
          value: config.writesEnabled ? "Enabled" : "Disabled",
        },
        {
          title: "Dry Run",
          value: config.dryRun ? "Yes" : "No",
        },
      ],
      spacing: "Small",
    });
  }

  return wrapCard(body);
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
): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: `Menu Search: "${query}"`,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: `Found ${results.length} item${results.length === 1 ? "" : "s"}`,
      isSubtle: true,
      spacing: "Small",
    },
  ];

  // Add each result as a container
  for (const result of results.slice(0, 10)) {
    const price = result.item.price != null ? `$${result.item.price.toFixed(2)}` : "N/A";

    body.push({
      type: "Container",
      spacing: "Small",
      separator: true,
      items: [
        {
          type: "ColumnSet",
          columns: [
            {
              type: "Column",
              width: "stretch",
              items: [
                {
                  type: "TextBlock",
                  text: result.item.name,
                  weight: "Bolder",
                  wrap: true,
                },
              ],
            },
            {
              type: "Column",
              width: "auto",
              items: [
                {
                  type: "TextBlock",
                  text: price,
                  weight: "Bolder",
                  color: "Accent",
                },
              ],
            },
          ],
        },
        {
          type: "TextBlock",
          text: `${result.menuName} > ${result.groupName}`,
          isSubtle: true,
          size: "Small",
        },
      ],
    });
  }

  if (results.length > 10) {
    body.push({
      type: "TextBlock",
      text: `... and ${results.length - 10} more`,
      isSubtle: true,
      spacing: "Small",
    });
  }

  return wrapCard(body);
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
): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: businessDate ? `Orders for ${businessDate}` : "Recent Orders",
      weight: "Bolder",
      size: "Medium",
    },
    {
      type: "TextBlock",
      text: `${orders.length} order${orders.length === 1 ? "" : "s"}`,
      isSubtle: true,
      spacing: "Small",
    },
  ];

  for (const order of orders.slice(0, 15)) {
    const total = order.checks
      ?.reduce((sum, c) => sum + (c.totalAmount ?? 0), 0)
      ?.toFixed(2);

    body.push({
      type: "ColumnSet",
      spacing: "Small",
      separator: true,
      columns: [
        {
          type: "Column",
          width: "stretch",
          items: [
            {
              type: "TextBlock",
              text: order.guid.slice(0, 8) + "...",
              size: "Small",
            },
          ],
        },
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: order.server?.name ?? "",
              size: "Small",
              isSubtle: true,
            },
          ],
        },
        {
          type: "Column",
          width: "auto",
          items: [
            {
              type: "TextBlock",
              text: total ? `$${total}` : "",
              weight: "Bolder",
              size: "Small",
            },
          ],
        },
      ],
    });
  }

  return wrapCard(body);
}

/**
 * Restaurant config summary card.
 */
export function configCard(data: Record<string, unknown>): Record<string, unknown> {
  const restaurant = data.restaurant as Record<string, unknown> | null;
  const revenueCenters = data.revenueCenters as Array<{ name: string }>;
  const diningOptions = data.diningOptions as Array<{ name: string; behavior?: string }>;
  const serviceAreas = data.serviceAreas as Array<{ name: string }>;

  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: (restaurant?.name as string) ?? "Restaurant Configuration",
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
  ];

  if (restaurant) {
    body.push({
      type: "FactSet",
      facts: [
        { title: "Timezone", value: String(restaurant.timezone ?? "N/A") },
        { title: "Currency", value: String(restaurant.currencyCode ?? "N/A") },
      ],
    });
  }

  if (revenueCenters?.length > 0) {
    body.push({
      type: "TextBlock",
      text: `Revenue Centers (${revenueCenters.length})`,
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "TextBlock",
      text: revenueCenters.map((rc) => rc.name).join(", "),
      wrap: true,
    });
  }

  if (diningOptions?.length > 0) {
    body.push({
      type: "TextBlock",
      text: `Dining Options (${diningOptions.length})`,
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "TextBlock",
      text: diningOptions.map((d) => d.name).join(", "),
      wrap: true,
    });
  }

  if (serviceAreas?.length > 0) {
    body.push({
      type: "TextBlock",
      text: `Service Areas (${serviceAreas.length})`,
      weight: "Bolder",
      spacing: "Medium",
    });
    body.push({
      type: "TextBlock",
      text: serviceAreas.map((sa) => sa.name).join(", "),
      wrap: true,
    });
  }

  return wrapCard(body);
}

/**
 * Wrap body elements in an Adaptive Card envelope.
 */
function wrapCard(body: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    msteams: { width: "Full" },
  };
}
