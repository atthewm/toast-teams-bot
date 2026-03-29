/**
 * Alert grouping utility.
 * When multiple alerts target the same channel in one scheduler cycle,
 * this combines them under a single "Operations Update" header to
 * reduce notification noise.
 */

export interface PendingAlert {
  channel: string;
  message: string;
}

/**
 * Group a list of pending alerts by channel.
 * If multiple alerts target the same channel, they are combined
 * under a single header with the current time label.
 * Single alerts pass through unchanged.
 */
export function groupAlertsByChannel(
  alerts: PendingAlert[],
  timeLabel: string
): Map<string, string> {
  const grouped = new Map<string, string[]>();

  for (const alert of alerts) {
    const existing = grouped.get(alert.channel) ?? [];
    existing.push(alert.message);
    grouped.set(alert.channel, existing);
  }

  const result = new Map<string, string>();

  for (const [channel, messages] of grouped) {
    if (messages.length === 1) {
      result.set(channel, messages[0]);
    } else {
      let combined = `**Operations Update** (${timeLabel})\n\n`;
      for (let i = 0; i < messages.length; i++) {
        if (i > 0) combined += `\n\n· · ·\n\n`;
        combined += messages[i];
      }
      result.set(channel, combined);
    }
  }

  return result;
}
