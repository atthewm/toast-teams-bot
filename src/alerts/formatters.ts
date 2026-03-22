/**
 * Alert message formatters for Teams channel posts.
 */

export interface OrderInfo {
  guid: string;
  displayNumber?: string;
  total: number;
  itemCount: number;
  serverName?: string;
  diningOptionName?: string;
  openedDate?: string;
}

export function formatLargeOrderAlert(order: OrderInfo): string {
  const num = order.displayNumber ?? order.guid.slice(0, 8);
  let text = `**Large Order Alert**\n\n`;
  text += `Order #${num} just came in: **$${order.total.toFixed(2)}**, **${order.itemCount} items**\n`;
  if (order.serverName) {
    text += `Server: ${order.serverName}\n`;
  }
  if (order.diningOptionName) {
    text += `Dining Option: ${order.diningOptionName}\n`;
  }
  return text;
}

export function formatHighVoidAlert(voidCount: number, windowMinutes: number): string {
  return (
    `**High Void Alert**\n\n` +
    `**${voidCount}** orders voided in the last ${windowMinutes} minutes. ` +
    `Check with the floor team to see if there's an issue.`
  );
}

export function formatLongOpenOrderAlert(
  orders: Array<{ displayNumber?: string; guid: string; minutesOpen: number; serverName?: string }>
): string {
  let text = `**Long Open Order Alert**\n\n`;
  text += `The following orders have been open 30+ minutes with no close time:\n\n`;
  for (const o of orders) {
    const num = o.displayNumber ?? o.guid.slice(0, 8);
    text += `Order #${num}: **${o.minutesOpen} min** open`;
    if (o.serverName) text += ` (${o.serverName})`;
    text += `\n`;
  }
  text += `\nThese may need attention or may be stuck in the POS.`;
  return text;
}
