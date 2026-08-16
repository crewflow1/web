/**
 * AI Cost Governor — BUDGET ATTRIBUTION for calls that have no tenant.
 *
 * WHY THIS FILE HAS TO EXIST
 * -------------------------
 * The ledger and the reservation table both declare
 * `org_id uuid not null references public.organizations(id)`. That is not an
 * oversight to work around — it is what makes the ceiling a PER-ORG ceiling and
 * what makes tenant teardown cascade. Every governed call must therefore name a
 * real organisation.
 *
 * Three governed capabilities have no tenant to name: HQ's Draft Engine, the
 * Shared-Memory lifecycle worker, and HQ research. They are CrewFlow's own AI
 * spend, not a customer's. There are exactly three ways that can be resolved:
 *
 *   1. Make `org_id` nullable — rejected. A nullable org column turns the
 *      per-org ceiling into "£100 per org, plus an unbounded bucket", and the
 *      unbounded bucket is precisely what this whole lane exists to remove.
 *      It would also need a migration, and a control you have to migrate to get
 *      is a control you do not have today.
 *   2. Invent a synthetic UUID — rejected. It would fail the foreign key, and
 *      "the governed call errored" is not a cost control either.
 *   3. Attribute HQ's spend to CrewFlow's OWN organisation row. This is the
 *      honest answer: HQ is a tenant of its own product (hello@crewflow.uk),
 *      that row already exists, and `CREWFLOW_INTERNAL_ORG_ID` already names it
 *      for the demo-booking path (app/api/demo/route.ts) and is already
 *      reported by the ops env snapshot. Nothing new is introduced.
 *
 * A DELIBERATE CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: HQ's own AI
 * spend then consumes the internal org's £100 monthly ceiling alongside anything
 * else that org does. That is the desired shape — HQ's AI is not exempt from the
 * safety limit — but the number was chosen for a CUSTOMER's unit economics, so
 * whether HQ deserves its own ceiling is a product decision. It is flagged, not
 * silently assumed.
 *
 * FAIL-CLOSED. When the variable is unset, this returns `null` and each HQ
 * caller takes its existing deterministic leg. It does NOT fall back to "some
 * org" or to spending unattributed: an invocation nobody is billed for is an
 * invocation outside the ceiling, which is the defect, not the fix. While no
 * tier is bound the question never arises — `invokeWithGovernor` short-circuits
 * before it reads a budget — so today this returns nothing and costs nothing.
 *
 * No `server-only`, no SDK, no I/O, and it can never throw. Reads `process.env`
 * directly, exactly as ./readiness.ts does, so it stays usable from an edge
 * probe and from a test.
 */

/**
 * The organisation HQ's own (non-tenant) AI spend is billed to, or `null` when
 * this deployment has not named one.
 *
 * `null` is a REFUSAL, not a default. See the module note: a governed call with
 * no org cannot be reserved against a ceiling, so the caller degrades.
 */
export function hqBudgetOrgId(): string | null {
  const raw = process.env.CREWFLOW_INTERNAL_ORG_ID;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The EMPLOYEE a governed call is attributed to for PER-EMPLOYEE LIMIT purposes,
 * or `null` when there is no attributable human.
 *
 * WHY THIS EXISTS, AND WHY IT IS SO SMALL.
 * The per-employee limit (ai_employee_budget_limits, enforced fail-closed in
 * ai_reserve_invocation) is keyed on the ACTING USER — the same `user_id` the
 * ledger and the reservation already carry. So "threading the employee dimension
 * through" is mostly a matter of NOT losing the user id that already flows
 * through `invokeWithGovernor`, and of stating the ONE rule that decides when a
 * call has no employee at all:
 *
 *   A SYSTEM / HQ JOB HAS NO EMPLOYEE. A webhook turn, a cron sweep, and HQ's
 *   own AI (billed to hqBudgetOrgId) run with `user_id = null` — there is no
 *   person whose personal monthly budget the call should count against. Such
 *   calls are governed by the ORG CEILING ALONE; the reserve function skips the
 *   employee gate when the user id is null, and this function makes that policy
 *   explicit and testable rather than an implicit consequence of a null.
 *
 * It is NOT a place to invent a synthetic "AI employee" subject. An AI employee
 * is identified by its FEATURE KEY (which the ledger already records), and the
 * per-feature cost rollup on /admin/ai-costs is where that spend is attributed.
 * Folding a feature into the per-employee-limit dimension would conflate "a
 * human's personal cap" with "a capability's spend" — two different controls —
 * so this deliberately returns null for a null user rather than manufacturing an
 * identity the limit table has no row for.
 *
 * Pure, total, never throws — the same contract as `hqBudgetOrgId`.
 */
export function limitSubjectUserId(userId: string | null | undefined): string | null {
  if (typeof userId !== "string") return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}
