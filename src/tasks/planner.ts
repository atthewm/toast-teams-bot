/**
 * Planner task creation stub.
 * Creates tasks in Microsoft Planner when alert conditions are met.
 * Requires M365_MCP_URL and PLANNER_PLAN_ID environment variables.
 */

const M365_MCP_URL = process.env.M365_MCP_URL ?? "";
const PLANNER_PLAN_ID = process.env.PLANNER_PLAN_ID ?? "";

/**
 * Create a Planner task from an alert condition.
 *
 * @param topic     Short description of the task (e.g. "Labor Breach Follow Up")
 * @param message   Full alert message body for task notes
 * @param dueHours  Hours from now the task should be due
 * @returns true if task was created, false otherwise
 */
export async function createTaskFromAlert(
  topic: string,
  message: string,
  dueHours: number
): Promise<boolean> {
  if (!M365_MCP_URL || !PLANNER_PLAN_ID) {
    console.log(
      "[Planner] Task creation skipped: M365_MCP_URL or PLANNER_PLAN_ID not configured"
    );
    return false;
  }

  try {
    const dueDate = new Date(Date.now() + dueHours * 60 * 60 * 1000).toISOString();

    console.log(
      `[Planner] Would create task: "${topic}" due ${dueDate} in plan ${PLANNER_PLAN_ID}`
    );
    console.log(`[Planner] Notes: ${message.slice(0, 200)}`);

    // TODO: Wire up actual Planner API call via M365 MCP
    // This will use the M365 MCP server's planner_create_task tool
    // once the MCP server is deployed and configured.

    return false;
  } catch (err) {
    console.log("[Planner] Task creation failed:", (err as Error).message);
    return false;
  }
}
