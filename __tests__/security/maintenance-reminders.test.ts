import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MAINTENANCE REMINDERS — the DARK guarantee (Phase 7).
 *
 * The load-bearing security property of this engine: while the feature flag is
 * off (the production default), NOTHING is sent. This tier proves it two ways —
 *
 *   1. ON SOURCE. `sendEmail` is called on exactly ONE branch in the drain, and
 *      that branch is guarded by `isMaintenanceRemindersLive() && emailReady`.
 *      No other code path can reach the sender.
 *   2. BEHAVIOURALLY. Running the real drain with the flag OFF, against a mocked
 *      admin client that yields a genuinely-due reminder, the email sender is
 *      NEVER invoked and every row is resolved to `skipped_dark`.
 *
 * The DB-level idempotency + RLS proofs run in the integration tier
 * (__tests__/integration/rls/maintenance-reminders.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ── 1. Source pin: the ONE guarded send branch ──────────────────────────────

describe("maintenance-reminders drain — send is gated in source", () => {
  const SERVICE = read("server/services/maintenance-reminders.ts");

  it("calls sendEmail exactly once in the source (one branch)", () => {
    const calls = SERVICE.match(/sendEmail\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("gates the live decision on the ONE shared helper (flag AND email readiness)", () => {
    // The drain's live decision comes from the shared helper, not a local re-derivation...
    expect(SERVICE).toMatch(/const\s+live\s*=\s*maintenanceRemindersSending\(\)/);
    // ...and that helper is exactly the flag AND a genuinely-sendable email provider.
    const READINESS = read("lib/maintenance/readiness.ts");
    expect(READINESS).toMatch(
      /isMaintenanceRemindersLive\(\)\s*&&\s*getEmailReadiness\(\)\.outboundReady/,
    );
  });

  it("the portal copy is gated on the SAME shared helper — the two cannot drift", () => {
    const PORTAL = read("app/customer-portal/[token]/warranties/page.tsx");
    expect(PORTAL).toMatch(/maintenanceRemindersSending\(\)/);
    // The portal no longer gates on the bare flag (which would over-promise a
    // send the drain would not actually make when email is unconfigured).
    expect(PORTAL).not.toMatch(/isMaintenanceRemindersLive\(\)/);
  });

  it("the live path CLAIMS each reminder atomically before sending (no double-send)", () => {
    // The send loop iterates rows won by the atomic claim, not a bare pending read.
    expect(SERVICE).toMatch(/claim_due_maintenance_reminders/);
    expect(SERVICE).toMatch(/for\s*\(const\s+row\s+of\s+claimed\)/);
  });

  it("the dark branch marks skipped_dark and returns before any send", () => {
    expect(SERVICE).toMatch(/if\s*\(!live\)/);
    expect(SERVICE).toMatch(/skipped_dark/);
  });

  it("the flag defaults OFF — only the exact string 'true' enables it", () => {
    const READINESS = read("lib/maintenance/readiness.ts");
    expect(READINESS).toMatch(/===\s*"true"/);
  });
});

// ── 2. Behavioural: the flag is OFF ⇒ the sender is never invoked ────────────

const sendEmailSpy = vi.fn(async (..._args: unknown[]) => ({
  sent: true as const,
  id: "should-never-happen",
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: (...args: unknown[]) => sendEmailSpy(...args),
}));

// A tiny chainable Supabase mock: every builder method returns the same
// thenable builder, and a resolver decides the result from the accumulated
// table/op/filters. Enough to drive the drain end to end without a database.
type Filter = { k: string; v: unknown };
const updates: Array<{ status: unknown }> = [];

function makeBuilder(table: string) {
  const state: { table: string; op: string | null; filters: Filter[]; row: unknown } = {
    table,
    op: null,
    filters: [],
    row: null,
  };
  const resolve_ = (): { data: unknown; error: null } => {
    const hasPending = state.filters.some((f) => f.k === "status" && f.v === "pending");
    if (state.table === "job_warranties" && state.op === "select") {
      return {
        data: [
          {
            id: "w1",
            job_id: "job1",
            period_months: 12,
            service_interval_months: 1,
            status: "active",
            portal_published_at: "2024-01-01T00:00:00Z",
            portal_withdrawn_at: null,
          },
        ],
        error: null,
      };
    }
    if (state.table === "completion_certificates" && state.op === "select") {
      return { data: [{ job_id: "job1", completion_date: "2025-01-01" }], error: null };
    }
    if (state.table === "maintenance_reminder_log") {
      if (state.op === "upsert") return { data: [{ id: "r1" }], error: null };
      if (state.op === "update") {
        updates.push({ status: (state.row as { status: unknown }).status });
        return { data: [], error: null };
      }
      if (state.op === "select" && hasPending) {
        return {
          data: [
            { id: "r1", warranty_id: "w1", job_id: "job1", kind: "service", due_date: "2025-02-01" },
          ],
          error: null,
        };
      }
      // existing-log read (no status filter)
      return { data: [], error: null };
    }
    return { data: [], error: null };
  };

  const builder: Record<string, unknown> = {
    select(_c?: string) {
      if (!state.op) state.op = "select";
      return builder;
    },
    upsert(_rows: unknown, _opts?: unknown) {
      state.op = "upsert";
      return builder;
    },
    insert(_rows: unknown) {
      state.op = "insert";
      return builder;
    },
    update(row: unknown) {
      state.op = "update";
      state.row = row;
      return builder;
    },
    eq(k: string, v: unknown) {
      state.filters.push({ k, v });
      return builder;
    },
    in(k: string, v: unknown) {
      state.filters.push({ k, v });
      return builder;
    },
    then(onF: (r: unknown) => unknown, onR?: (e: unknown) => unknown) {
      return Promise.resolve(resolve_()).then(onF, onR);
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));

describe("maintenance-reminders drain — DARK path sends nothing", () => {
  beforeEach(() => {
    sendEmailSpy.mockClear();
    updates.length = 0;
    // Guarantee dark: the flag is unset.
    delete process.env.NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS;
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("with the flag OFF, a genuinely-due reminder is recorded skipped_dark and NEVER sent", async () => {
    const { drainDueReminders } = await import("@/server/services/maintenance-reminders");
    const res = await drainDueReminders("org1", { today: "2025-01-20" });

    // The reminder WAS computed and recorded...
    expect(res.created).toBe(1);
    // ...but nothing went out, and the run reports itself as not live.
    expect(res.live).toBe(false);
    expect(res.sent).toBe(0);
    expect(res.skippedDark).toBe(1);

    // THE security assertion: the email seam was never touched.
    expect(sendEmailSpy).not.toHaveBeenCalled();
    // And the row was resolved to skipped_dark.
    expect(updates).toContainEqual({ status: "skipped_dark" });
  });

  it("even with a valid email provider configured, the flag being OFF blocks the send", async () => {
    process.env.RESEND_API_KEY = "re_test_key_for_readiness_only";
    const { drainDueReminders } = await import("@/server/services/maintenance-reminders");
    const res = await drainDueReminders("org1", { today: "2025-01-20" });
    expect(res.live).toBe(false);
    expect(res.sent).toBe(0);
    expect(sendEmailSpy).not.toHaveBeenCalled();
    delete process.env.RESEND_API_KEY;
  });
});
