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
 * FIELD capabilities (D-17, founder ruling 2026-11-15).
 *
 * Ordinary construction duties that a crew member needs WITHOUT being an admin:
 * scan an asset QR, inspect, report a defect, take an asset into their own custody,
 * log fuel, issue / transfer / count stock and manage their assigned van, record
 * goods received, request materials, submit a job cost as a PENDING entry, draft and
 * complete site-safety documents. They are separate module keys (`*_field`) so that
 * holding one never implies the money / approval / administration capability of the
 * parent module (`stock`, `assets`, `purchase_orders`, `expenses`, `site_safety`).
 *
 * Baseline: every owner, admin and staff member holds view / create / edit on each
 * field module. NEVER approve, delete, export or manage — those need an explicit
 * grant on the PARENT module held by an ADMIN (or the owner); staff never hold grants. The database mirrors this in
 * public.has_org_capability (migration 20261346) so a direct Data-API call is held to
 * the same rule as the application.
 */
export const FIELD_MODULES = [
  "assets_field",
  "fuel_field",
  "stock_field",
  "goods_receiving_field",
  "job_costs_field",
  "site_safety_field",
] as const;
export type FieldModule = (typeof FIELD_MODULES)[number];

/** The only actions the baseline ever confers. */
export const FIELD_BASELINE_ACTIONS: readonly CapAction[] = ["view", "create", "edit"];

/** Parent module whose explicit grant also satisfies the field module. */
export const FIELD_PARENT: Readonly<Record<FieldModule, string>> = {
  assets_field: "assets",
  fuel_field: "fleet",
  stock_field: "stock",
  goods_receiving_field: "purchase_orders",
  job_costs_field: "expenses",
  site_safety_field: "site_safety",
};

export function isFieldModule(module: string): module is FieldModule {
  return (FIELD_MODULES as readonly string[]).includes(module);
}

/**
 * The capability decision, given a role and its loaded grants.
 *   owner → always true.
 *   admin → the FIELD baseline for a field module, else only what was explicitly
 *     granted (on the module itself, or on a field module's parent).
 *   staff → the FIELD baseline ONLY. Stray grant rows on a staff membership are IGNORED
 *     (a staff member never holds a management capability, whatever the grants table says).
 *   any other role → false.
 * Default-deny: nothing outside the baseline is ever implied by role alone.
 */
export function canWith(
  role: string | null | undefined,
  grants: readonly Grant[],
  module: string,
  action: CapAction,
): boolean {
  if (role === "owner") return true;
  if (role !== "admin" && role !== "staff") return false;
  if (isFieldModule(module) && FIELD_BASELINE_ACTIONS.includes(action)) return true;
  if (role === "staff") return false;
  if (isFieldModule(module)) return grantAllows(grants, FIELD_PARENT[module], action);
  return grantAllows(grants, module, action);
}
