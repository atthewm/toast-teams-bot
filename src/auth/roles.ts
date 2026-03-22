/**
 * Role based access control for Toast Teams Bot.
 * Maps Azure AD group membership to permission levels.
 * Users not in any configured group get "staff" (read only menus/health).
 */

export type Role = "admin" | "manager" | "staff";

export interface RoleConfig {
  adminGroupId?: string;
  managerGroupId?: string;
}

/**
 * Permissions per role. Each key is a command or data category.
 */
const PERMISSIONS: Record<Role, Set<string>> = {
  admin: new Set([
    "health",
    "menus",
    "search",
    "orders",
    "config",
    "status",
    "capabilities",
    "register",
    "channels",
    "ai",
    "sales",
    "labor",
  ]),
  manager: new Set([
    "health",
    "menus",
    "search",
    "orders",
    "config",
    "status",
    "ai",
    "sales",
  ]),
  staff: new Set(["health", "menus", "search", "ai"]),
};

/**
 * Check if a role has permission for a given action.
 */
export function hasPermission(role: Role, action: string): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}

/**
 * Resolve user role from Azure AD group membership.
 * groupIds: the Azure AD group IDs the user belongs to.
 */
export function resolveRole(
  groupIds: string[],
  config: RoleConfig
): Role {
  const memberOf = new Set(groupIds);

  if (config.adminGroupId && memberOf.has(config.adminGroupId)) {
    return "admin";
  }

  if (config.managerGroupId && memberOf.has(config.managerGroupId)) {
    return "manager";
  }

  return "staff";
}

/**
 * Fetch user's group memberships via Microsoft Graph.
 * Returns array of group IDs.
 */
export async function fetchUserGroups(
  graphToken: string,
  userId: string
): Promise<string[]> {
  try {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/users/${userId}/memberOf`,
      {
        headers: { Authorization: `Bearer ${graphToken}` },
      }
    );

    if (!response.ok) {
      console.error(`[RBAC] Graph API error: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      value?: Array<{ id: string; "@odata.type"?: string }>;
    };

    return (
      data.value
        ?.filter(
          (m) =>
            m["@odata.type"] === "#microsoft.graph.group" ||
            !m["@odata.type"]
        )
        .map((m) => m.id) ?? []
    );
  } catch (err) {
    console.error(`[RBAC] Failed to fetch groups: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Format a denial message.
 */
export function denyMessage(action: string): string {
  return `You don't have permission to access **${action}** data. Contact an admin if you need access.`;
}
