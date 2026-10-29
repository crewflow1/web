/**
 * Admin capability RULES — pure, dependency-free decision logic.
 *
 * No server-only, no DB, no Next imports, so it is unit-testable in isolation
 * and importable from either a server module (server/auth/capabilities.ts) or a
 * client component (the R3 owner permissions UI) without pulling in server code.
 *
 * Founder model: OWNER full; ADMIN only what was granted (default-deny); STAFF /
 * any other role hold no management capability.
 */

/** The seven founder-defined actions. '*' (owner-only wildcard) is not listed. */
export const CAP_ACTIONS = [
  "view",
  "create",
  "edit",
  "approve",
  "delete",
  "export",
  "manage",
] as const;
export type CapAction = (typeof CAP_ACTIONS)[number];

/** Canonical module list the owner UI presents (app-governed, not DB-constrained). */
export const CAP_MODULES = [
  "jobs",
  "quotes",
  "sales",
  "customers",
  "leads",
  "price_book",
  "invoices",
  "payments",
  "expenses",
  "costs",
  "cis",
  "tax",
  "reports",
  "cash",
  "operations",
  "assets",
  "fleet",
  "stock",
  "suppliers",
  "purchase_orders",
  "sites",
  "materials",
  "staff",
  "rota",
  "payroll",
  "leave",
  "site_safety",
  "documents",
  "inbox",
  "settings",
  "integrations",
  "marketplace",
  "ai",
] as const;
export type CapModule = (typeof CAP_MODULES)[number];

export type Grant = { module: string; action: string };

/** The owner's implicit full grant (never stored in the table). */
export const OWNER_WILDCARD: Grant = { module: "*", action: "*" };

/**
 * Does this grant set permit (module, action)?
 *   - '*' module matches any module; '*' action matches any action.
 *   - 'manage' implies every action on its module (manage = full control).
 * Default-deny: an empty grant set permits nothing.
 */
export function grantAllows(
  grants: readonly Grant[],
  module: string,
  action: CapAction,
): boolean {
  for (const g of grants) {
    // Ignore malformed grants (empty module/action) so a bad row can never
    // match a (necessarily non-empty) request — belt-and-suspenders until the
    // R3 write UI validates module ∈ CAP_MODULES at write time.
    if (!g.module || !g.action) continue;
    const moduleOk = g.module === "*" || g.module === module;
    const actionOk = g.action === "*" || g.action === "manage" || g.action === action;
    if (moduleOk && actionOk) return true;
  }
  return false;
}

/**
 * The capability decision, given a role and its loaded grants.
 *   owner  → always true. admin → only what was granted. other → false.
 */
export function canWith(
  role: string | null | undefined,
  grants: readonly Grant[],
  module: string,
  action: CapAction,
): boolean {
  if (role === "owner") return true;
  if (role !== "admin") return false;
  return grantAllows(grants, module, action);
}
