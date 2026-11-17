import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F2 — HQ "Cancel" must stop billing, not just lock the customer out.
 *
 * The two HQ actions that can set an organisation to `cancelled`
 * (app/admin/customers/actions.ts setCustomerLifecycle and app/admin/actions.ts
 * setOrganizationStatus) run for real here. The cancellation service is a spy
 * and the admin client records its writes, so what is proved is the ORDER and
 * the GATE: billing is stopped first, and if it cannot be, the organisation row
 * is never written.
 */

const ORG = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  stop: vi.fn(),
  writes: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  events: [] as string[],
  audits: [] as Array<{ action: string }>,
}));

class Redirect extends Error {
  constructor(public url: string) {
    super(`REDIRECT ${url}`);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "hq-user", email: "ops@hq.example.test" }),
}));
vi.mock("@/server/auth/superadmin", () => ({ isSuperAdminEmail: () => true }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.test" } }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ sent: false, reason: "no_key" })) }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: vi.fn(async (e: { action: string }) => {
    h.audits.push({ action: e.action });
  }),
}));
vi.mock("@/server/services/notifications-service", () => ({ emitNotifications: vi.fn() }));
vi.mock("@/server/services/subscription-cancellation", () => ({
  stopBillingForHqCancellation: (...a: unknown[]) => {
    h.events.push("stop_billing");
    return h.stop(...a);
  },
  wireCancellationDeps: () => ({ wired: true }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          h.writes.push({ table, payload });
          h.events.push(`update:${table}:${String(payload.status)}`);
          return { error: null };
        },
      }),
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

const { setCustomerLifecycle } = await import("@/app/admin/customers/actions");
const { setOrganizationStatus } = await import("@/app/admin/actions");

function form(status: string): FormData {
  const f = new FormData();
  f.set("org_id", ORG);
  f.set("status", status);
  f.set("reason", "non-payment");
  return f;
}
async function run(action: (f: FormData) => Promise<void>, status: string): Promise<string> {
  try {
    await action(form(status));
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("action did not redirect");
}
const orgWrites = () => h.writes.filter((w) => w.table === "organizations");

beforeEach(() => {
  h.stop.mockReset();
  h.stop.mockResolvedValue({ ok: true, result: { ok: true, outcome: "cancelled" } });
  h.writes.length = 0;
  h.events.length = 0;
  h.audits.length = 0;
});

describe.each([
  ["setCustomerLifecycle (/admin/customers/[id])", setCustomerLifecycle, `/admin/customers/${ORG}`],
  ["setOrganizationStatus (/admin/organizations)", setOrganizationStatus, "/admin/organizations"],
] as const)("%s", (_name, action, base) => {
  it("CANCELLED → billing is stopped FIRST, for that org, with the HQ operator as actor; only then is the org written", async () => {
    const url = await run(action, "cancelled");
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      actor: { userId: "hq-user", email: "ops@hq.example.test" },
      reason: "non-payment",
    });
    expect(h.events[0]).toBe("stop_billing");
    expect(h.events).toContain("update:organizations:cancelled");
    expect(url.startsWith(`${base}?saved=`)).toBe(true);
  });

  it("CANCELLED but billing could NOT be stopped → the org is NOT marked cancelled, and the operator is told why", async () => {
    h.stop.mockResolvedValue({
      ok: false,
      reason: "stripe_error",
      message: "NOT cancelled. Stripe refused to cancel the subscription, so billing is still active.",
    });
    const url = await run(action, "cancelled");
    expect(orgWrites()).toEqual([]);
    expect(url.startsWith(`${base}?error=`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("NOT cancelled.");
    expect(url).not.toContain("saved=");
  });

  it("SUSPENDED never touches the subscription", async () => {
    const url = await run(action, "suspended");
    expect(h.stop).not.toHaveBeenCalled();
    expect(orgWrites().map((w) => w.payload.status)).toEqual(["suspended"]);
    expect(url).toContain("saved=");
  });

  it.each(["active", "trial"])("%s (reactivation) never touches the subscription", async (status) => {
    await run(action, status);
    expect(h.stop).not.toHaveBeenCalled();
    expect(orgWrites().map((w) => w.payload.status)).toEqual([status]);
  });
});

it("a blocked HQ cancel is itself audited (customers page)", async () => {
  h.stop.mockResolvedValue({ ok: false, reason: "billing_unavailable", message: "NOT cancelled. x" });
  await run(setCustomerLifecycle, "cancelled");
  expect(h.audits.map((a) => a.action)).toEqual(["customer.lifecycle_cancel_blocked"]);
});
