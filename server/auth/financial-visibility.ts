import "server-only";

/**
 * Single source of truth for "can this member see commercial / private financial
 * data on a job" (retention, budgets, valuations, unit costs, profit).
 *
 * Historically this was inlined as `role === "owner" || role === "admin"` in
 * app/(app)/jobs/[id]/page.tsx (and gated the private-area FETCH, not just the
 * render, to keep private rows out of a staff member's RSC payload). The AI Site
 * Manager needs the identical rule for its financial tool, so it lives here and
 * both callers import it — no drift between the page gate and the AI gate.
 */

/** Roles permitted to see a job's commercial/financial detail. */
export function roleCanViewPrivate(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Convenience over an org context's membership (the shape returned by
 * `requireOrgContext()`), so callers can pass `ctx` directly.
 */
export function canSeeCommercial(ctx: { membership: { role: string } }): boolean {
  return roleCanViewPrivate(ctx.membership.role);
}
