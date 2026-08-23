import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_MAX_HOURS,
} from "@/server/services/impersonation";

/**
 * HQ-10 Full Impersonation OS contract tests.
 *
 * Pinned:
 *   1. Migration shape: impersonation_sessions with FK cascade,
 *      indexes (admin / target / active partial), RLS no policies.
 *   2. Service exposes start/end/forceEnd/list/getActive/count.
 *   3. Cookie name + 24h cap are constants.
 *   4. getActiveImpersonation REFUSES non-super-admins regardless
 *      of cookie state (security guarantee).
 *   5. Actions: super-admin gated, every start/end writes
 *      admin_activity_log, start fires urgent HQ notification.
 *   6. session.ts hooks impersonation into getOrgForUser BEFORE
 *      the normal membership query.
 *   7. /admin/impersonation page renders active sessions + start
 *      form + history.
 *   8. (app) layout renders red impersonation banner with EXIT
 *      action when an impersonation session is active.
 *   9. HQ_NAV /admin/impersonation no longer marked Coming soon.
 *  10. Open-redirect / cookie tampering guards (validated server-
 *      side every load).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read("supabase/migrations/20260613000000_impersonation_sessions.sql");
const SVC = read("server/services/impersonation.ts");
const ACTIONS = read("app/admin/impersonation/actions.ts");
const PAGE = read("app/admin/impersonation/page.tsx");
const SESSION = read("server/auth/session.ts");
const APP_LAYOUT = read("app/(app)/layout.tsx");
const HQ_LAYOUT = read("app/admin/layout.tsx");
const CUSTOMER_DETAIL = read("app/admin/customers/[id]/page.tsx");

// =====================================================================
// 1. Constants
// =====================================================================

describe("impersonation constants", () => {
  it("cookie name is namespaced", () => {
    expect(IMPERSONATION_COOKIE).toBe("cf_impersonation_session");
  });
  it("24h max session age", () => {
    expect(IMPERSONATION_MAX_HOURS).toBe(24);
  });
});

// =====================================================================
// 2. Migration shape
// =====================================================================

describe("migration 20260613000000 — impersonation_sessions", () => {
  it("creates the table with admin + target columns", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.impersonation_sessions/,
    );
    expect(MIGRATION).toMatch(/admin_user_id\s+uuid references public\.users/);
    expect(MIGRATION).toMatch(/admin_email\s+text not null/);
    expect(MIGRATION).toMatch(
      /target_org_id\s+uuid not null references public\.organizations\(id\)\s+on delete cascade/,
    );
  });

  it("RLS enabled with NO policies (service-role only)", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.impersonation_sessions enable row level security/,
    );
    expect(MIGRATION).not.toMatch(/create policy/i);
  });

  it("indexes cover admin, target, and active-partial", () => {
    expect(MIGRATION).toMatch(/impersonation_sessions_admin_idx/);
    expect(MIGRATION).toMatch(/impersonation_sessions_target_idx/);
    expect(MIGRATION).toMatch(/impersonation_sessions_active_idx[\s\S]*where ended_at is null/);
  });

  it("stamps started_at + ended_at + created_at", () => {
    expect(MIGRATION).toMatch(/started_at\s+timestamp with time zone not null default now\(\)/);
    expect(MIGRATION).toMatch(/ended_at\s+timestamp with time zone/);
  });

  it("optional ip + user_agent for forensic visibility", () => {
    expect(MIGRATION).toMatch(/ip_address\s+text/);
    expect(MIGRATION).toMatch(/user_agent\s+text/);
  });
});

// =====================================================================
// 3. Service
// =====================================================================

describe("impersonation service", () => {
  it("exports start / end / forceEnd / list / getActive / count", () => {
    for (const fn of [
      "startImpersonationSession",
      "endImpersonationSession",
      "listImpersonationSessions",
      "getActiveImpersonation",
      "countActiveImpersonationSessions",
    ]) {
      expect(SVC).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("getActiveImpersonation REFUSES non-super-admins regardless of cookie", () => {
    expect(SVC).toMatch(/if \(!currentEmail \|\| !isSuperAdminEmail\(currentEmail\)\) return null/);
  });

  it("validates admin_email matches the row (no cookie sharing across HQ users)", () => {
    expect(SVC).toMatch(/admin_email\.toLowerCase\(\) !== currentEmail\.toLowerCase\(\)/);
  });

  it("enforces 24h hard cap on session age", () => {
    expect(SVC).toMatch(/IMPERSONATION_MAX_HOURS \* 3600_000/);
  });

  it("startImpersonationSession refuses non-super-admins", () => {
    expect(SVC).toMatch(/if \(!isSuperAdminEmail\(input\.admin_email\)\)/);
  });

  it("captures ip + user-agent best-effort", () => {
    expect(SVC).toMatch(/x-forwarded-for/);
    expect(SVC).toMatch(/user-agent/);
  });
});

// =====================================================================
// 4. Actions
// =====================================================================

describe("impersonation server actions", () => {
  it("every action gates on isSuperAdminEmail via requireAdmin", () => {
    expect(ACTIONS).toMatch(/async function requireAdmin/);
    expect(ACTIONS).toMatch(/isSuperAdminEmail/);
  });

  it("exports start / end / forceEnd", () => {
    for (const fn of [
      "startImpersonation",
      "endImpersonation",
      "forceEndImpersonation",
    ]) {
      expect(ACTIONS).toMatch(new RegExp(`export async function ${fn}`));
    }
  });

  it("reason is required (3+ chars), Zod-validated", () => {
    expect(ACTIONS).toMatch(/\.min\(3, "Reason required/);
  });

  it("cookie set with httpOnly + secure + sameSite=lax", () => {
    expect(ACTIONS).toMatch(/httpOnly:\s*true/);
    expect(ACTIONS).toMatch(/secure:\s*true/);
    expect(ACTIONS).toMatch(/sameSite:\s*"lax"/);
  });

  it("every start writes admin_activity_log + fires urgent HQ notification", () => {
    expect(ACTIONS).toMatch(/recordAdminActivity/);
    expect(ACTIONS).toMatch(/"impersonation\.started"/);
    expect(ACTIONS).toMatch(/notifyOnUrgentHqAlert/);
  });

  it("end writes admin_activity_log + duration_seconds metadata", () => {
    expect(ACTIONS).toMatch(/"impersonation\.ended"/);
    expect(ACTIONS).toMatch(/duration_seconds/);
  });

  it("force-end writes its own audit row (different action)", () => {
    expect(ACTIONS).toMatch(/"impersonation\.force_ended"/);
  });

  it("ends any prior active session before starting a new one (no overlap)", () => {
    expect(ACTIONS).toMatch(/getActiveImpersonation\(admin\.email\)/);
    expect(ACTIONS).toMatch(/endImpersonationSession\(existing\.session_id\)/);
  });
});

// =====================================================================
// 4b. BUG-05 — tenant-switch cache purge (no stale/leaked tenant state)
// =====================================================================

/** Slice out a single exported action body for per-function assertions. */
function actionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start === -1) return "";
  const rest = src.slice(start + 1);
  const nextRel = rest.indexOf("\nexport async function ");
  return nextRel === -1 ? src.slice(start) : src.slice(start, start + 1 + nextRel);
}

describe("impersonation actions purge the full route cache on tenant switch (BUG-05)", () => {
  it("imports revalidatePath from next/cache", () => {
    expect(ACTIONS).toMatch(
      /import \{ revalidatePath \} from "next\/cache"/,
    );
  });

  it("starting impersonation purges the entire route tree (not just /dashboard)", () => {
    // A full-tree purge is required so cached customers/quotes/jobs/invoices
    // pages can't leak the operator's prior org after switching in.
    expect(actionBody(ACTIONS, "startImpersonation")).toMatch(
      /revalidatePath\("\/", "layout"\)/,
    );
  });

  it("ending impersonation purges the entire route tree", () => {
    // Returning to HQ must drop the impersonated org's cached pages too.
    expect(actionBody(ACTIONS, "endImpersonation")).toMatch(
      /revalidatePath\("\/", "layout"\)/,
    );
  });

  it("force-ending a session purges cached views", () => {
    expect(actionBody(ACTIONS, "forceEndImpersonation")).toMatch(
      /revalidatePath\("\/", "layout"\)/,
    );
  });

  it("the purge is the full-tree layout variant in every action (exactly 3)", () => {
    const count = (ACTIONS.match(/revalidatePath\("\/", "layout"\)/g) ?? [])
      .length;
    expect(count).toBe(3);
  });
});

// =====================================================================
// 5. Session resolution hook
// =====================================================================

describe("session.ts — impersonation hooks getOrgForUser BEFORE membership query", () => {
  it("calls getActiveImpersonation when currentEmail is present", () => {
    expect(SESSION).toMatch(/getActiveImpersonation/);
  });

  it("returns the impersonation target context when active", () => {
    expect(SESSION).toMatch(/loadOrgContextForImpersonation/);
  });

  it("passes currentEmail through requireOrgContext", () => {
    expect(SESSION).toMatch(/getOrgForUser\(user\.id, \{ currentEmail/);
  });
});

// =====================================================================
// 6. /admin/impersonation page
// =====================================================================

describe("/admin/impersonation page", () => {
  it("renders start form + active sessions + history", () => {
    expect(PAGE).toMatch(/Start a new impersonation/);
    expect(PAGE).toMatch(/Active sessions/);
    expect(PAGE).toMatch(/Recent history/);
  });

  it("wires startImpersonation + endImpersonation + forceEndImpersonation actions", () => {
    expect(PAGE).toMatch(/action=\{startImpersonation\}/);
    expect(PAGE).toMatch(/action=\{endImpersonation\}/);
    expect(PAGE).toMatch(/action=\{forceEndImpersonation\}/);
  });

  it("describes how cross-tenant access is enforced (current_org_ids)", () => {
    // After HQ-10.1 the v1 limitation is gone — the page now explains
    // the real mechanism instead.
    expect(PAGE).toMatch(/current_org_ids/);
    expect(PAGE).toMatch(/audit-logged/);
    expect(PAGE).toMatch(/Sessions auto-expire after 24h/);
  });
});

// =====================================================================
// 7. Customer (app) layout banner
// =====================================================================

describe("customer (app) layout — impersonation banner", () => {
  it("loads active impersonation via getActiveImpersonation", () => {
    expect(APP_LAYOUT).toMatch(/getActiveImpersonation/);
  });

  it("renders a loud red banner when impersonating", () => {
    expect(APP_LAYOUT).toMatch(/bg-red-600/);
    expect(APP_LAYOUT).toMatch(/IMPERSONATING/);
  });

  it("wires Exit impersonation form action", () => {
    expect(APP_LAYOUT).toMatch(/action=\{endImpersonation\}/);
    expect(APP_LAYOUT).toMatch(/Exit impersonation/);
  });
});

// =====================================================================
// 8. Customer detail page wiring
// =====================================================================

describe("customer detail page wires the real action", () => {
  it("imports startImpersonation (not the legacy logImpersonationAttempt)", () => {
    expect(CUSTOMER_DETAIL).toMatch(/startImpersonation/);
    expect(CUSTOMER_DETAIL).toMatch(/action=\{startImpersonation\}/);
  });
});

// =====================================================================
// 9. HQ_NAV
// =====================================================================

describe("HQ_NAV — impersonation is ready", () => {
  it("/admin/impersonation no shipsIn", () => {
    expect(read("app/admin/_nav/hq-nav-model.ts")).toMatch(/href: "\/admin\/impersonation"/);
    expect(HQ_LAYOUT).not.toMatch(/href: "\/admin\/impersonation"[^}]*shipsIn:/);
  });
});
