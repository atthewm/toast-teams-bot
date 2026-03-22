/**
 * Report generators for scheduled posting to Teams channels.
 * Each function pulls data from the MCP server and formats a Teams message.
 */

import { ToastMcpClient } from "../mcp/client.js";

/** Format YYYYMMDD for Toast API businessDate param */
function businessDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function formatDollars(n: number | undefined | null): string {
  if (n == null) return "N/A";
  return `$${n.toFixed(2)}`;
}

/**
 * Previous day sales summary for #finance.
 */
export async function dailySalesSummary(mcp: ToastMcpClient): Promise<string> {
  const date = yesterday();
  const dateStr = businessDate(date);
  const display = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 50,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        diningOption?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.totalOrders) {
      return `**Daily Sales Summary** (${display})\n\nNo order data available for yesterday.`;
    }

    const validOrders = data.orders?.filter((o) => !o.voided) ?? [];
    const avgOrder =
      validOrders.length > 0 && data.totalSales
        ? data.totalSales / validOrders.length
        : 0;

    let text = `**Daily Sales Summary** (${display})\n\n`;
    text += `Total Orders: **${data.totalOrders}**\n`;
    text += `Total Sales: **${formatDollars(data.totalSales)}**\n`;
    text += `Average Order: **${formatDollars(avgOrder)}**\n`;
    text += `Voided: ${(data.orders?.filter((o) => o.voided).length) ?? 0}`;

    return text;
  } catch (err) {
    return `**Daily Sales Summary** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Marketplace breakdown (DoorDash, Uber Eats, Grubhub) for #marketing.
 */
export async function marketplaceBreakdown(mcp: ToastMcpClient): Promise<string> {
  const date = yesterday();
  const dateStr = businessDate(date);
  const display = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

  const PLATFORMS: Record<string, string[]> = {
    DoorDash: ["DoorDash", "DoorDash Delivery", "DoorDash Takeout"],
    "Uber Eats": [
      "Uber Eats Delivery",
      "Uber Eats Takeout",
      "UberEats",
      "UberEats Delivery",
    ],
    Grubhub: ["Grubhub", "Grubhub Delivery"],
  };

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 100,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        diningOption?: string;
        diningOptionName?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.orders) {
      return `**Marketplace Breakdown** (${display})\n\nNo order data available.`;
    }

    const validOrders = data.orders.filter((o) => !o.voided);

    // Group orders by platform
    const platformTotals: Record<string, { orders: number; sales: number }> = {};
    let inHouseOrders = 0;
    let inHouseSales = 0;

    for (const order of validOrders) {
      const optionName = order.diningOptionName ?? order.diningOption ?? "";
      let matched = false;

      for (const [platform, names] of Object.entries(PLATFORMS)) {
        if (names.some((n) => optionName.includes(n))) {
          if (!platformTotals[platform]) {
            platformTotals[platform] = { orders: 0, sales: 0 };
          }
          platformTotals[platform].orders++;
          platformTotals[platform].sales += order.total ?? 0;
          matched = true;
          break;
        }
      }

      if (!matched) {
        inHouseOrders++;
        inHouseSales += order.total ?? 0;
      }
    }

    let text = `**Marketplace Breakdown** (${display})\n\n`;

    for (const [platform, totals] of Object.entries(platformTotals)) {
      text += `**${platform}**: ${totals.orders} orders, ${formatDollars(totals.sales)}\n`;
    }

    text += `**In House**: ${inHouseOrders} orders, ${formatDollars(inHouseSales)}\n`;
    text += `\nTotal: **${validOrders.length}** orders, **${formatDollars(data.totalSales)}**`;

    return text;
  } catch (err) {
    return `**Marketplace Breakdown** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Rush recap: orders within a time window for today.
 */
export async function rushRecap(
  mcp: ToastMcpClient,
  label: string,
  startHour: number,
  endHour: number
): Promise<string> {
  const today = new Date();
  const dateStr = businessDate(today);
  const display = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  try {
    const raw = await mcp.callToolText("toast_list_orders", {
      businessDate: dateStr,
      detailCount: 100,
    });

    let data: {
      totalOrders?: number;
      totalSales?: number;
      orders?: Array<{
        total?: number;
        voided?: boolean;
        openedDate?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data || !data.orders) {
      return `**${label}** (${display})\n\nNo order data available.`;
    }

    // Filter orders within the time window
    const windowOrders = data.orders.filter((o) => {
      if (o.voided || !o.openedDate) return false;
      const opened = new Date(o.openedDate);
      const hour = opened.getHours();
      return hour >= startHour && hour < endHour;
    });

    const windowSales = windowOrders.reduce(
      (sum, o) => sum + (o.total ?? 0),
      0
    );

    let text = `**${label}** (${display})\n\n`;
    text += `Orders: **${windowOrders.length}**\n`;
    text += `Sales: **${formatDollars(windowSales)}**\n`;

    if (windowOrders.length > 0) {
      const avg = windowSales / windowOrders.length;
      text += `Average: **${formatDollars(avg)}**`;
    }

    return text;
  } catch (err) {
    return `**${label}** (${display})\n\nFailed to fetch: ${(err as Error).message}`;
  }
}

/**
 * Shift roster: who's working today. Requires labor tools on MCP server.
 * Currently a placeholder until toast_list_shifts is added.
 */
export async function shiftRoster(mcp: ToastMcpClient): Promise<string> {
  const today = new Date();
  const display = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

  // Check if labor tool exists
  const tools = mcp.getTools();
  const hasLabor = tools.some(
    (t) => t.name.includes("labor") || t.name.includes("shift")
  );

  if (!hasLabor) {
    return (
      `**Shift Roster** (${display})\n\n` +
      `Labor tools not yet available on the MCP server. ` +
      `Add toast_list_shifts to enable this report.`
    );
  }

  try {
    const raw = await mcp.callToolText("toast_list_shifts", {
      businessDate: businessDate(today),
    });
    return `**Shift Roster** (${display})\n\n${raw}`;
  } catch (err) {
    return `**Shift Roster** (${display})\n\nFailed: ${(err as Error).message}`;
  }
}

/**
 * 86'd item check: polls stock endpoint for out of stock items.
 * Requires toast_get_stock tool on MCP server.
 */
export async function check86d(
  mcp: ToastMcpClient,
  previous86d: Set<string>
): Promise<{ message: string | null; current86d: Set<string> }> {
  const tools = mcp.getTools();
  const hasStock = tools.some(
    (t) => t.name.includes("stock") || t.name.includes("inventory")
  );

  if (!hasStock) {
    return { message: null, current86d: previous86d };
  }

  try {
    const raw = await mcp.callToolText("toast_get_stock");
    let data: {
      items?: Array<{
        name: string;
        guid: string;
        quantity?: number;
        status?: string;
      }>;
    } | null = null;
    try { data = JSON.parse(raw); } catch { /* plain text */ }

    if (!data?.items) {
      return { message: null, current86d: previous86d };
    }

    const current86d = new Set<string>();
    const newly86d: string[] = [];

    for (const item of data.items) {
      if (
        item.status === "OUT_OF_STOCK" ||
        (item.quantity != null && item.quantity <= 0)
      ) {
        current86d.add(item.guid);
        if (!previous86d.has(item.guid)) {
          newly86d.push(item.name);
        }
      }
    }

    if (newly86d.length === 0) {
      return { message: null, current86d };
    }

    const text =
      `**86'd Alert**\n\n` +
      `The following items are now out of stock:\n` +
      newly86d.map((name) => `**${name}**`).join("\n");

    return { message: text, current86d };
  } catch {
    return { message: null, current86d: previous86d };
  }
}
