/**
 * Control Tower message formatter.
 *
 * Uses OpenAI to convert structured ControlTowerAlert objects into
 * natural language Teams messages. OpenAI ONLY handles formatting;
 * it never determines whether alerts fire, their severity, or routing.
 *
 * Every function has a deterministic fallback so messages still flow
 * when the OpenAI API is unavailable.
 */

import OpenAI from "openai";
import type { ControlTowerAlert, Severity } from "./models.js";
import type { BotConfig } from "../config/index.js";

/* ------------------------------------------------------------------ */
/*  Severity indicators                                                */
/* ------------------------------------------------------------------ */

const SEVERITY_ICON: Record<Severity, string> = {
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  red: "CRITICAL",
  yellow: "WARNING",
  green: "OK",
};

/* ------------------------------------------------------------------ */
/*  System prompt for the formatter LLM call                           */
/* ------------------------------------------------------------------ */

const FORMAT_SYSTEM_PROMPT = `You are a message formatter for a restaurant operations bot in Microsoft Teams.

Your job: take structured alert data and produce a concise, scannable Teams message.

Rules:
1. Be concise. Two to four sentences maximum for a single alert.
2. Format for Teams: use markdown, bold key numbers and percentages.
3. Start with the severity indicator provided, then the alert topic.
4. Include the most important metrics inline with bold formatting.
5. End with the recommended action as a short, direct sentence.
6. Never use dashes of any kind (hyphens, en dashes, em dashes). Use commas, colons, semicolons, or rewrite instead.
7. Do not add greetings, sign offs, or filler phrases.
8. Do not invent data. Only use the fields provided.`;

const DIGEST_SYSTEM_PROMPT = `You are a message formatter for a restaurant operations bot in Microsoft Teams.

Your job: take a list of alerts from today and produce a daily digest summary.

Rules:
1. Start with a header line: "📋 **Daily Ops Digest**"
2. Group alerts by severity (red first, then yellow, then green).
3. For each alert, write one line with severity icon, topic, and the key takeaway.
4. End with a one sentence overall assessment.
5. Never use dashes of any kind (hyphens, en dashes, em dashes). Use commas, colons, semicolons, or rewrite instead.
6. Do not add greetings, sign offs, or filler phrases.
7. Keep the whole digest under 15 lines.`;

/* ------------------------------------------------------------------ */
/*  OpenAI client helper                                               */
/* ------------------------------------------------------------------ */

function createOpenAIClient(config: BotConfig): OpenAI {
  return new OpenAI({ apiKey: config.openaiApiKey });
}

/* ------------------------------------------------------------------ */
/*  Build the user prompt payload for a single alert                   */
/* ------------------------------------------------------------------ */

function buildAlertPromptPayload(alert: ControlTowerAlert): string {
  const metricsLines = Object.entries(alert.keyMetrics)
    .map(([key, val]) => `  ${key}: ${val}`)
    .join("\n");

  return [
    `Severity: ${SEVERITY_ICON[alert.severity]} ${SEVERITY_LABEL[alert.severity]}`,
    `Topic: ${alert.topic}`,
    `Rule: ${alert.ruleName}`,
    `Source: ${alert.sourceSystem}`,
    `Date Window: ${alert.dateWindow}`,
    `What Happened: ${alert.whatHappened}`,
    `Why It Matters: ${alert.whyItMatters}`,
    `Key Metrics:\n${metricsLines}`,
    `Recommended Action: ${alert.recommendedAction}`,
    `Owner: ${alert.owner}`,
    alert.duplicatesExisting
      ? `Note: This duplicates an existing notification (${alert.duplicatesExisting})`
      : "",
    alert.shadowMode ? "Mode: SHADOW (observation only)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/*  Build the user prompt payload for a digest                         */
/* ------------------------------------------------------------------ */

function buildDigestPromptPayload(alerts: ControlTowerAlert[]): string {
  if (alerts.length === 0) {
    return "No alerts fired today. Generate a short all clear message.";
  }

  const lines = alerts.map((a, i) => {
    const metricsStr = Object.entries(a.keyMetrics)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return [
      `Alert ${i + 1}:`,
      `  Severity: ${SEVERITY_ICON[a.severity]} ${SEVERITY_LABEL[a.severity]}`,
      `  Topic: ${a.topic}`,
      `  What: ${a.whatHappened}`,
      `  Metrics: ${metricsStr}`,
      `  Action: ${a.recommendedAction}`,
    ].join("\n");
  });

  return `Total alerts today: **${alerts.length}**\n\n${lines.join("\n\n")}`;
}

/* ------------------------------------------------------------------ */
/*  Deterministic (fallback) formatters                                */
/* ------------------------------------------------------------------ */

/**
 * Deterministic single alert formatter. Produces a clean message
 * without any LLM call. Good enough to use on its own.
 */
export function formatAlertPlaintext(alert: ControlTowerAlert): string {
  const icon = SEVERITY_ICON[alert.severity];
  const label = SEVERITY_LABEL[alert.severity];

  const metricsStr = Object.entries(alert.keyMetrics)
    .map(([key, val]) => `**${key}**: ${val}`)
    .join(" | ");

  const parts = [
    `${icon} **${label}**: ${alert.topic}`,
    "",
    alert.whatHappened,
    "",
    metricsStr,
    "",
    `**Action**: ${alert.recommendedAction}`,
    `**Owner**: ${alert.owner}`,
  ];

  if (alert.shadowMode) {
    parts.push("", "_Shadow mode: observation only_");
  }

  if (alert.duplicatesExisting) {
    parts.push(`_Duplicates existing notification: ${alert.duplicatesExisting}_`);
  }

  return parts.join("\n");
}

/**
 * Deterministic digest formatter. Produces a structured summary
 * without any LLM call.
 */
export function formatDigestPlaintext(alerts: ControlTowerAlert[]): string {
  if (alerts.length === 0) {
    return "📋 **Daily Ops Digest**\n\n🟢 All clear. No alerts fired today.";
  }

  const header = `📋 **Daily Ops Digest** (${alerts.length} alert${alerts.length === 1 ? "" : "s"})`;

  // Group by severity
  const grouped: Record<Severity, ControlTowerAlert[]> = {
    red: [],
    yellow: [],
    green: [],
  };
  for (const a of alerts) {
    grouped[a.severity].push(a);
  }

  const lines: string[] = [header, ""];

  for (const sev of ["red", "yellow", "green"] as Severity[]) {
    const group = grouped[sev];
    if (group.length === 0) continue;

    for (const a of group) {
      const topMetric = Object.entries(a.keyMetrics)[0];
      const metricStr = topMetric
        ? ` (**${topMetric[0]}**: ${topMetric[1]})`
        : "";
      lines.push(`${SEVERITY_ICON[sev]} ${a.topic}${metricStr}`);
    }
  }

  // Summary line
  const redCount = grouped.red.length;
  const yellowCount = grouped.yellow.length;

  lines.push("");
  if (redCount > 0) {
    lines.push(
      `⚠️ **${redCount}** critical alert${redCount === 1 ? "" : "s"} need${redCount === 1 ? "s" : ""} attention today.`
    );
  } else if (yellowCount > 0) {
    lines.push(
      `**${yellowCount}** warning${yellowCount === 1 ? "" : "s"} noted. No critical issues.`
    );
  } else {
    lines.push("All green. Smooth operations today.");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  OpenAI powered formatters with fallback                            */
/* ------------------------------------------------------------------ */

/**
 * Format a single alert using OpenAI for natural language polish.
 * Falls back to the deterministic formatter on any error.
 */
export async function formatAlertMessage(
  alert: ControlTowerAlert,
  config: BotConfig
): Promise<string> {
  try {
    const client = createOpenAIClient(config);
    const userContent = buildAlertPromptPayload(alert);

    const completion = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: "system", content: FORMAT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (text && text.length > 10) {
      return text;
    }

    // Empty or too short response, fall back
    console.log("[ControlTower] OpenAI returned empty response, using fallback formatter");
    return formatAlertPlaintext(alert);
  } catch (err) {
    console.log(
      "[ControlTower] OpenAI format failed, using fallback:",
      (err as Error).message
    );
    return formatAlertPlaintext(alert);
  }
}

/**
 * Format a batch of alerts as a daily digest using OpenAI.
 * Falls back to the deterministic digest formatter on any error.
 */
export async function formatDailyDigest(
  alerts: ControlTowerAlert[],
  config: BotConfig
): Promise<string> {
  try {
    const client = createOpenAIClient(config);
    const userContent = buildDigestPromptPayload(alerts);

    const completion = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: "system", content: DIGEST_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 600,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (text && text.length > 10) {
      return text;
    }

    console.log("[ControlTower] OpenAI digest returned empty, using fallback");
    return formatDigestPlaintext(alerts);
  } catch (err) {
    console.log(
      "[ControlTower] OpenAI digest failed, using fallback:",
      (err as Error).message
    );
    return formatDigestPlaintext(alerts);
  }
}
