import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subscription cancellation SERVICE — every branch, with a MOCKED Stripe client
 * and an in-memory stand-in for the three SQL functions.
 *
 * EVIDENCE LABEL: SIMULATED-ONLY. Nothing here talks to Stripe or Postgres. The
 * fake `claim`/`confirm` model the contract of
 * claim_subscription_cancellation / confirm_subscription_cancellation; that the
 * REAL functions honour that contract (locking, exactly-once, tombstones) is
 * proved against Postgres in
 * __tests__/integration/stripe/subscription-cancellation.test.ts.
 */

// The service module imports its concrete wiring's dependencies at module
// scope; none of them is exercised here (we inject deps), so stub the ones that
// would otherwise need a database, Stripe or Resend.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/stripe/client", () => ({ getStripe: () => null }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity: vi.fn() }));
vi.mock("@/server/services/notifications-service", () => ({ emitNotifications: vi.fn() }));
vi.mock("@/server/services/self-serve-billing", () => ({
  wireSelfServeBillingDeps: vi.fn(),
  syncOrgSubscriptionFromStripe: vi.fn(),
}));

const {
  cancelOrgSubscription,
  requestReactivation,
  stopBillingForHqCancellation,
  HQ_CANCEL_ERROR_COPY,
  REACTIVATION_REQUEST_DEDUPE_SECONDS,
} = await import("@/server/services/subscription-cancellation");
type Deps = import("@/server/services/subscription-cancellation").CancellationDeps;
type Snapshot = import("@/server/services/subscription-cancellation").SubscriptionSnapshot;
type Org = import("@/server/services/subscription-cancellation").CancellationOrg;
type Notice = import("@/lib/notifications/types").NotificationCreate;

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = { userId: "22222222-2222-4222-8222-222222222222", email: "owner@example.test" };
const NOW = 1_800_000_000;
const DAY = 86_400;

function sub(id: string, status: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    id,
    status,
    customerId: "cus_1",
    metadataOrgId: ORG_ID,
    currentPeriodStart: NOW - 10 * DAY,
    currentPeriodEnd: NOW + 20 * DAY,
    unitAmountMinor: 50_000,
    quantity: 1,
    currency: "gbp",
    shape: { id, status, customer: "cus_1" },
    ...over,
  };
}

type World = {
  org: Org | null;
  stripeSubs: Map<string, Snapshot>;
  rows: Map<string, { id: string; state: "requested" | "confirmed" | "failed"; sub: string | null }>;
  stripeAvailable: boolean;
  disabled: boolean;
  cancelImpl: (id: string) => Promise<Snapshot>;
  calls: {
    cancel: Array<{ id: string; idempotencyKey: string }>;
    stopCollection: string[];
    released: Array<{ id: string; error: string }>;
    audits: Array<{ action: string; metadata: Record<string, unknown> }>;
    notices: Notice[];
    emails: Array<{ to: string; orgName: string; hadSubscription: boolean }>;
    projected: string[];
    confirms: Array<Record<string, unknown>>;
    claimSources: string[];
  };
};

let w: World;

function makeDeps(): Deps {
  let seq = 0;
  const keyOf = (s: string | null) => s ?? "none";
  return {
    isDisabled: () => w.disabled,
    stripeAvailable: () => w.stripeAvailable,
    now: () => NOW,
    loadOrg: async () => w.org,
    claim: async ({ subscriptionId, source }) => {
      w.calls.claimSources.push(source);
      if (!w.org) return { outcome: "org_not_found", cancellationId: null };
      if (subscriptionId === null) {
        if (w.org.status === "cancelled") return { outcome: "already_confirmed", cancellationId: null };
        const inFlight = [...w.rows.values()].find((r) => r.sub === null && r.state === "requested");
        if (inFlight) return { outcome: "in_flight", cancellationId: inFlight.id };
        const id = `c${++seq}`;
        w.rows.set(id, { id, state: "requested", sub: null });
        return { outcome: "claimed", cancellationId: id };
      }
      const existing = [...w.rows.values()].find((r) => r.sub === subscriptionId);
      if (existing) {
        if (existing.state === "confirmed") return { outcome: "already_confirmed", cancellationId: existing.id };
        if (existing.state === "requested") return { outcome: "in_flight", cancellationId: existing.id };
        existing.state = "requested";
        return { outcome: "claimed", cancellationId: existing.id };
      }
      const id = `c${++seq}`;
      w.rows.set(id, { id, state: "requested", sub: subscriptionId });
      return { outcome: "claimed", cancellationId: id };
    },
    confirm: async (args) => {
      w.calls.confirms.push(args as unknown as Record<string, unknown>);
      let row =
        args.subscriptionId === null
          ? w.rows.get(args.cancellationId ?? "")
          : [...w.rows.values()].find((r) => r.sub === args.subscriptionId);
      if (!row) {
        const id = `c${++seq}`;
        row = { id, state: "requested", sub: keyOf(args.subscriptionId) };
        w.rows.set(id, row);
      }
      const newly = row.state !== "confirmed";
      let revoked = false;
      if ((newly || args.forceRevoke) && w.org && w.org.status !== "cancelled") {
        w.org = { ...w.org, status: "cancelled" };
        revoked = true;
      }
      row.state = "confirmed";
      return {
        newlyConfirmed: newly,
        accessRevoked: revoked,
        cancellationId: row.id,
        source: "owner",
        requestedByEmail: ACTOR.email,
        priorOrgStatus: "active",
      };
    },
    release: async (id, error) => {
      w.calls.released.push({ id, error });
      const row = w.rows.get(id);
      if (row && row.state === "requested") row.state = "failed";
    },
    stripe: {
      listCustomerSubscriptions: async () =>
        [...w.stripeSubs.values()].filter((s) => s.status !== "canceled"),
      retrieveSubscription: async (id) => w.stripeSubs.get(id) ?? null,
      cancelSubscription: async (id, { idempotencyKey }) => {
        w.calls.cancel.push({ id, idempotencyKey });
        return w.cancelImpl(id);
      },
      stopInvoiceCollection: async (id) => {
        w.calls.stopCollection.push(id);
        return { stopped: [`in_open_${id}`], failed: [] };
      },
      countPendingInvoiceItems: async () => 0,
    },
    projectSubscription: async (_org, shape) => {
      w.calls.projected.push(shape.id);
    },
    recordAudit: async (e) => {
      w.calls.audits.push({ action: e.action, metadata: e.metadata });
    },
    notifyHq: async (n) => {
      w.calls.notices.push(n);
    },
    sendOwnerEmail: async (a) => {
      w.calls.emails.push(a);
      return { sent: true };
    },
  };
}

/** Stripe's happy path: the subscription becomes canceled. */
const stripeCancels = async (id: string): Promise<Snapshot> => {
  const s = w.stripeSubs.get(id)!;
  const done = { ...s, status: "canceled" };
  w.stripeSubs.set(id, done);
  return done;
};

beforeEach(() => {
  w = {
    org: {
      id: ORG_ID,
      name: "Acme Builders",
      status: "active",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
    },
    stripeSubs: new Map([["sub_1", sub("sub_1", "active")]]),
    rows: new Map(),
    stripeAvailable: true,
    disabled: false,
    cancelImpl: stripeCancels,
    calls: {
      cancel: [],
      stopCollection: [],
      released: [],
      audits: [],
      notices: [],
      emails: [],
      projected: [],
      confirms: [],
      claimSources: [],
    },
  };
});

const run = (reason?: string) =>
  cancelOrgSubscription(makeDeps(), { orgId: ORG_ID, actor: ACTOR, reason });

// ---------------------------------------------------------------------------

describe("ACTIVE before renewal", () => {
  it("cancels immediately at Stripe, revokes access, audits, alerts HQ, emails the owner — once each", async () => {
    const r = await run("moving to a spreadsheet");
    expect(r).toMatchObject({
      ok: true,
      outcome: "cancelled",
      accessRevoked: true,
      subscriptionsCancelled: ["sub_1"],
      refundReview: "pending",
      emailSent: true,
    });
    expect(w.calls.cancel).toEqual([{ id: "sub_1", idempotencyKey: `crewflow-cancel:${ORG_ID}:sub_1` }]);
    expect(w.org?.status).toBe("cancelled");
    expect(w.calls.stopCollection).toEqual(["sub_1"]);
    expect(w.calls.projected).toEqual(["sub_1"]);
    expect(w.calls.audits.map((a) => a.action)).toEqual(["billing.subscription_cancelled_by_owner"]);
    expect(w.calls.notices).toHaveLength(1);
    expect(w.calls.emails).toEqual([
      { to: ACTOR.email, orgName: "Acme Builders", hadSubscription: true },
    ]);
  });

  it("flags a refund REVIEW for HQ with an estimate — and moves no money", async () => {
    await run();
    const confirm = w.calls.confirms[0]!;
    expect(confirm.refundReview).toBe("pending");
    expect((confirm.details as Record<string, unknown>).refund_estimate_minor).toBe(33_333);
    const notice = w.calls.notices[0]!;
    expect(notice.audience).toBe("hq");
    expect(notice.body).toMatch(/REFUND REVIEW DUE/);
    expect(notice.body).toMatch(/333\.33 GBP/);
    expect(notice.body).toMatch(/nothing was refunded automatically/);
    // The only Stripe WRITES the service can make are cancel + stop collection.
    expect(Object.keys(makeDeps().stripe).sort()).toEqual([
      "cancelSubscription",
      "countPendingInvoiceItems",
      "listCustomerSubscriptions",
      "retrieveSubscription",
      "stopInvoiceCollection",
    ]);
  });

  it("passes the owner's optional reason to HQ, and works without one", async () => {
    await run("too expensive");
    expect(w.calls.notices[0]!.body).toMatch(/Reason given: too expensive/);
  });
});

describe("TRIALING / just after signup", () => {
  it("cancels the trialing subscription; no refund review (nothing was paid)", async () => {
    w.stripeSubs.set("sub_1", sub("sub_1", "trialing"));
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", refundReview: "not_applicable" });
    expect(w.calls.cancel).toHaveLength(1);
    expect(w.calls.notices[0]!.body).not.toMatch(/REFUND REVIEW/);
  });

  it("an INCOMPLETE subscription (first payment never confirmed) is still terminated", async () => {
    w.stripeSubs.set("sub_1", sub("sub_1", "incomplete"));
    const r = await run();
    expect(r.ok).toBe(true);
    expect(w.calls.cancel).toHaveLength(1);
  });
});

describe("PAST_DUE during a payment failure", () => {
  it("cancels, stops collection on the unpaid invoice, tells HQ it is still outstanding, no refund review", async () => {
    w.org = { ...w.org!, status: "suspended" };
    w.stripeSubs.set("sub_1", sub("sub_1", "past_due"));
    const r = await run();
    expect(r).toMatchObject({ ok: true, accessRevoked: true, refundReview: "not_applicable" });
    expect(w.calls.stopCollection).toEqual(["sub_1"]);
    expect(w.calls.notices[0]!.body).toMatch(/Automatic collection switched off on 1 unpaid\/draft invoice/);
    expect(w.calls.notices[0]!.body).toMatch(/remain outstanding/);
  });

  it("UNPAID (Stripe retries exhausted, subscription left unpaid) is terminated too", async () => {
    w.org = { ...w.org!, status: "suspended" };
    w.stripeSubs.set("sub_1", sub("sub_1", "unpaid"));
    const r = await run();
    expect(r.ok).toBe(true);
    expect(w.calls.cancel.map((c) => c.id)).toEqual(["sub_1"]);
  });
});

describe("after Stripe's retries are exhausted and Stripe already cancelled it", () => {
  it("org still suspended, subscription already canceled at Stripe → tombstone + revoke, NO Stripe cancel call", async () => {
    w.org = { ...w.org!, status: "suspended" };
    w.stripeSubs.set("sub_1", sub("sub_1", "canceled"));
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true, subscriptionsCancelled: [] });
    expect(w.calls.cancel).toEqual([]);
    expect(w.org?.status).toBe("cancelled");
    expect(w.calls.emails).toHaveLength(1);
  });
});

describe("ALREADY CANCELLED", () => {
  it("cancelled org, nothing live at Stripe → success, nothing happens, nobody is notified", async () => {
    w.org = { ...w.org!, status: "cancelled" };
    w.stripeSubs.set("sub_1", sub("sub_1", "canceled"));
    w.rows.set("c0", { id: "c0", state: "confirmed", sub: "sub_1" });
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "already_cancelled", accessRevoked: false });
    expect(w.calls.cancel).toEqual([]);
    expect(w.calls.notices).toEqual([]);
    expect(w.calls.emails).toEqual([]);
    expect(w.calls.audits).toEqual([]);
  });

  it("org marked cancelled BY HAND but the Stripe subscription is still live → it is terminated (never charged again)", async () => {
    w.org = { ...w.org!, status: "cancelled" };
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", subscriptionsCancelled: ["sub_1"] });
    expect(w.calls.cancel).toHaveLength(1);
    // Access was already revoked; HQ is still told the subscription was live.
    expect(r.ok && r.accessRevoked).toBe(false);
    expect(w.calls.notices).toHaveLength(1);
  });

  it("legacy: cancelled org whose dead subscription was never tombstoned → records it quietly", async () => {
    w.org = { ...w.org!, status: "cancelled" };
    w.stripeSubs.set("sub_1", sub("sub_1", "canceled"));
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "already_cancelled" });
    expect([...w.rows.values()].find((x) => x.sub === "sub_1")?.state).toBe("confirmed");
    expect(w.calls.notices).toEqual([]);
    expect(w.calls.emails).toEqual([]);
  });
});

describe("NO SUBSCRIPTION", () => {
  it("org with no Stripe link at all → local-only cancellation; Stripe is never called", async () => {
    w.org = { ...w.org!, status: "trial", stripe_customer_id: null, stripe_subscription_id: null };
    w.stripeSubs.clear();
    w.stripeAvailable = false; // irrelevant: nothing in Stripe to cancel
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true, refundReview: "not_applicable" });
    expect(w.calls.cancel).toEqual([]);
    expect(w.org?.status).toBe("cancelled");
    expect(w.calls.emails).toEqual([{ to: ACTOR.email, orgName: "Acme Builders", hadSubscription: false }]);
    expect(w.calls.notices[0]!.body).toMatch(/no live Stripe subscription/);
  });

  it("Stripe customer exists but has no subscription → local-only", async () => {
    w.org = { ...w.org!, stripe_subscription_id: null };
    w.stripeSubs.clear();
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", subscriptionsCancelled: [] });
    expect(w.calls.cancel).toEqual([]);
  });
});

describe("STRIPE ERROR / TIMEOUT — never report 'cancelled' unless Stripe confirmed", () => {
  it("Stripe refuses and the subscription is still live → refusal, claim released, org untouched, no email", async () => {
    w.cancelImpl = async () => {
      throw Object.assign(new Error("card_error"), { type: "StripeInvalidRequestError" });
    };
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "stripe_error" });
    expect(w.org?.status).toBe("active");
    expect(w.calls.released).toHaveLength(1);
    expect(w.calls.emails).toEqual([]);
    expect(w.calls.notices).toEqual([]);
    expect(w.calls.audits.map((a) => a.action)).toEqual(["billing.subscription_cancel_failed"]);
  });

  it("timeout, and Stripe says it is still live → stripe_timeout; a RETRY then succeeds with the same idempotency key", async () => {
    w.cancelImpl = async () => {
      throw Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" });
    };
    const first = await run();
    expect(first).toEqual({ ok: false, reason: "stripe_timeout" });
    expect(w.org?.status).toBe("active");

    w.cancelImpl = stripeCancels;
    const second = await run();
    expect(second).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true });
    expect(w.calls.cancel.map((c) => c.idempotencyKey)).toEqual([
      `crewflow-cancel:${ORG_ID}:sub_1`,
      `crewflow-cancel:${ORG_ID}:sub_1`,
    ]);
    expect(w.calls.emails).toHaveLength(1);
  });

  it("timeout, but Stripe DID cancel it (verified by retrieve) → treated as success", async () => {
    w.cancelImpl = async (id) => {
      await stripeCancels(id);
      throw Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" });
    };
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true });
    expect(w.calls.released).toEqual([]);
  });

  it("'no such subscription' on a subscription that is in fact gone → success", async () => {
    w.cancelImpl = async (id) => {
      w.stripeSubs.delete(id);
      throw Object.assign(new Error("No such subscription: 'sub_1'"), { code: "resource_missing" });
    };
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled" });
  });

  it("timeout and the state cannot be verified either → refusal (never assume success)", async () => {
    w.cancelImpl = async () => {
      throw Object.assign(new Error("ECONNRESET"), { type: "StripeConnectionError" });
    };
    const deps = makeDeps();
    deps.stripe.retrieveSubscription = async () => {
      throw new Error("ECONNRESET");
    };
    // retrieve is used in target resolution only when the recorded id is not
    // listed; here it is listed, so the first use is the post-error verify.
    const r = await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: false, reason: "stripe_timeout" });
    expect(w.org?.status).toBe("active");
  });

  it("Stripe answers 200 but the subscription is still live → refusal", async () => {
    w.cancelImpl = async (id) => w.stripeSubs.get(id)!;
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "stripe_error" });
    expect(w.org?.status).toBe("active");
  });

  it("org is linked to Stripe but Stripe is not configured → billing_unavailable, nothing changes", async () => {
    w.stripeAvailable = false;
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "billing_unavailable" });
    expect(w.org?.status).toBe("active");
    expect(w.rows.size).toBe(0);
  });

  it("Stripe unreachable while listing → billing_unavailable, nothing changes", async () => {
    const deps = makeDeps();
    deps.stripe.listCustomerSubscriptions = async () => {
      throw new Error("ETIMEDOUT");
    };
    const r = await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: false, reason: "billing_unavailable" });
    expect(w.org?.status).toBe("active");
  });

  it("Stripe cancelled it but OUR confirm write fails → still reported cancelled (not billable); deferred to the webhook; no email here", async () => {
    const deps = makeDeps();
    deps.confirm = async () => {
      throw new Error("db down");
    };
    const r = await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: false, emailSent: false });
    expect(w.stripeSubs.get("sub_1")?.status).toBe("canceled");
    expect(w.calls.audits.map((a) => a.action)).toContain("billing.subscription_cancel_confirm_deferred");
    expect(w.calls.emails).toEqual([]);
  });
});

describe("CONCURRENT cancellations", () => {
  it("a second caller while the first holds the claim gets in_progress and makes NO Stripe call", async () => {
    w.rows.set("c0", { id: "c0", state: "requested", sub: "sub_1" });
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "in_progress" });
    expect(w.calls.cancel).toEqual([]);
  });

  it("two simultaneous callers → one Stripe cancel, one success, one in_progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    w.cancelImpl = async (id) => {
      await gate;
      return stripeCancels(id);
    };
    const a = run();
    const b = run();
    await new Promise((r) => setTimeout(r, 5));
    release();
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "in_progress")).toHaveLength(1);
    expect(w.calls.cancel).toHaveLength(1);
    expect(w.calls.emails).toHaveLength(1);
  });

  it("the webhook confirmed first → the action still reports success, sends NO second email", async () => {
    const deps = makeDeps();
    const realConfirm = deps.confirm;
    deps.confirm = async (args) => {
      // The webhook lands between Stripe's response and our confirm.
      const row = [...w.rows.values()].find((x) => x.sub === args.subscriptionId)!;
      row.state = "confirmed";
      w.org = { ...w.org!, status: "cancelled" };
      return realConfirm(args);
    };
    const r = await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: false, emailSent: false });
    expect(w.calls.emails).toEqual([]);
    // HQ still gets the action's detailed notice (refund review).
    expect(w.calls.notices).toHaveLength(1);
  });
});

describe("only THIS org's subscriptions are ever touched", () => {
  it("recorded subscription belongs to a different Stripe customer → refuse, alert HQ, cancel nothing", async () => {
    w.stripeSubs = new Map([["sub_1", sub("sub_1", "active", { customerId: "cus_OTHER" })]]);
    const deps = makeDeps();
    // Stripe lists by customer, so cus_1 has nothing; the recorded id is fetched by id.
    deps.stripe.listCustomerSubscriptions = async () => [];
    const r = await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: false, reason: "billing_mismatch" });
    expect(w.calls.cancel).toEqual([]);
    expect(w.org?.status).toBe("active");
    expect(w.calls.notices[0]!.title).toMatch(/could not be matched/);
  });

  it("no customer id, and the subscription's metadata names another org → refuse", async () => {
    w.org = { ...w.org!, stripe_customer_id: null };
    w.stripeSubs = new Map([["sub_1", sub("sub_1", "active", { metadataOrgId: "some-other-org" })]]);
    const r = await run();
    expect(r).toEqual({ ok: false, reason: "billing_mismatch" });
    expect(w.calls.cancel).toEqual([]);
  });

  it("no customer id, metadata names THIS org → cancelled", async () => {
    w.org = { ...w.org!, stripe_customer_id: null };
    const r = await run();
    expect(r).toMatchObject({ ok: true, outcome: "cancelled" });
  });
});

describe("every live subscription on the customer is terminated", () => {
  it("a second live subscription we had no record of is cancelled too; the revoke is forced on the last", async () => {
    w.stripeSubs.set("sub_2", sub("sub_2", "active"));
    const r = await run();
    expect(r).toMatchObject({ ok: true, subscriptionsCancelled: ["sub_1", "sub_2"] });
    expect(w.calls.confirms.map((c) => c.forceRevoke)).toEqual([false, true]);
    expect(w.org?.status).toBe("cancelled");
  });

  it("the recorded id is stale (already canceled) but another is live → the live one is cancelled", async () => {
    w.stripeSubs = new Map([
      ["sub_1", sub("sub_1", "canceled")],
      ["sub_9", sub("sub_9", "active")],
    ]);
    const r = await run();
    expect(r).toMatchObject({ ok: true, subscriptionsCancelled: ["sub_9"] });
    expect(w.org?.status).toBe("cancelled");
  });
});

describe("kill switch + missing org", () => {
  it("disabled → refuses before loading anything", async () => {
    w.disabled = true;
    const deps = makeDeps();
    deps.loadOrg = async () => {
      throw new Error("must not be reached");
    };
    expect(await cancelOrgSubscription(deps, { orgId: ORG_ID, actor: ACTOR })).toEqual({
      ok: false,
      reason: "disabled",
    });
  });
  it("org not found", async () => {
    w.org = null;
    expect(await run()).toEqual({ ok: false, reason: "org_not_found" });
  });
});

describe("HQ-INITIATED cancellation (the HQ 'Cancel' lifecycle action) — F2", () => {
  const HQ = { userId: "33333333-3333-4333-8333-333333333333", email: "ops@hq.example.test" };
  const asHq = (deps = makeDeps()) =>
    stopBillingForHqCancellation(deps, { orgId: ORG_ID, actor: HQ, reason: "non-payment" });

  it("terminates the Stripe subscription through the SAME path, recorded as source 'hq', with the refund-review flag", async () => {
    const r = await asHq();
    expect(r.ok).toBe(true);
    expect(w.calls.cancel).toEqual([{ id: "sub_1", idempotencyKey: `crewflow-cancel:${ORG_ID}:sub_1` }]);
    expect(w.stripeSubs.get("sub_1")?.status).toBe("canceled");
    expect(w.org?.status).toBe("cancelled");
    expect(w.calls.claimSources).toEqual(["hq"]);
    expect(w.calls.confirms[0]!.refundReview).toBe("pending");
    expect(w.calls.stopCollection).toEqual(["sub_1"]);
    expect(w.calls.audits.map((a) => a.action)).toEqual(["billing.subscription_cancelled_by_hq"]);
    expect(w.calls.notices[0]!.title).toBe("Subscription cancelled by HQ");
    expect(w.calls.notices[0]!.body).toMatch(/REFUND REVIEW DUE/);
  });

  it("does NOT send the 'your subscription is cancelled' email to the HQ operator", async () => {
    await asHq();
    expect(w.calls.emails).toEqual([]);
  });

  it("the self-serve kill switch does not stop HQ from stopping a customer's billing", async () => {
    w.disabled = true;
    const r = await asHq();
    expect(r.ok).toBe(true);
    expect(w.calls.cancel).toHaveLength(1);
  });

  it.each([
    ["Stripe refuses", () => Object.assign(new Error("no"), { type: "StripeInvalidRequestError" }), "stripe_error"],
    ["Stripe times out", () => Object.assign(new Error("timed out"), { type: "StripeConnectionError" }), "stripe_timeout"],
  ] as const)("%s → FAILS LOUDLY and the org is NOT marked cancelled", async (_n, err, reason) => {
    w.cancelImpl = async () => {
      throw err();
    };
    const r = await asHq();
    expect(r).toMatchObject({ ok: false, reason });
    expect(!r.ok && r.message).toMatch(/^NOT cancelled\./);
    expect(w.org?.status).toBe("active");
    expect(w.stripeSubs.get("sub_1")?.status).toBe("active");
  });

  it("org linked to Stripe but Stripe unavailable → refused, org untouched", async () => {
    w.stripeAvailable = false;
    const r = await asHq();
    expect(r).toMatchObject({ ok: false, reason: "billing_unavailable" });
    expect(w.org?.status).toBe("active");
  });

  it("an unexpected throw is a refusal too, never a silent success", async () => {
    const deps = makeDeps();
    deps.loadOrg = async () => {
      throw new Error("db down");
    };
    const r = await asHq(deps);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/^NOT cancelled\./);
  });

  it("org with no Stripe subscription → cancelled locally (nothing to bill)", async () => {
    w.org = { ...w.org!, stripe_customer_id: null, stripe_subscription_id: null };
    w.stripeSubs.clear();
    w.stripeAvailable = false;
    const r = await asHq();
    expect(r.ok).toBe(true);
    expect(w.org?.status).toBe("cancelled");
  });

  it("every billing-failure message tells the operator the org was NOT cancelled", () => {
    for (const code of ["billing_unavailable", "billing_mismatch", "stripe_timeout", "stripe_error"] as const) {
      expect(HQ_CANCEL_ERROR_COPY[code], code).toMatch(/^NOT cancelled\./);
    }
  });
});

describe("reactivation request", () => {
  function deps(over: { status?: string; last?: string | null } = {}) {
    const audits: string[] = [];
    const notices: Notice[] = [];
    return {
      audits,
      notices,
      d: {
        loadOrg: async () => ({
          id: ORG_ID,
          name: "Acme",
          status: over.status ?? "cancelled",
          stripe_customer_id: "cus_1",
          stripe_subscription_id: "sub_1",
        }),
        lastReactivationRequestAt: async () => over.last ?? null,
        now: () => NOW,
        recordAudit: async (e: { action: string }) => {
          audits.push(e.action);
        },
        notifyHq: async (n: Notice) => {
          notices.push(n);
        },
      },
    };
  }

  it("cancelled org → audited + HQ alerted; no billing happens", async () => {
    const x = deps();
    const r = await requestReactivation(x.d, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: true, outcome: "requested" });
    expect(x.audits).toEqual(["billing.reactivation_requested"]);
    expect(x.notices).toHaveLength(1);
    expect(x.notices[0]!.audience).toBe("hq");
    expect(x.notices[0]!.body).toMatch(/new subscription checkout/);
  });

  it("a repeat inside 24h does not alert HQ again", async () => {
    const x = deps({ last: new Date((NOW - 3600) * 1000).toISOString() });
    const r = await requestReactivation(x.d, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: true, outcome: "already_requested" });
    expect(x.notices).toEqual([]);
  });

  it("an old request no longer suppresses a new one", async () => {
    const x = deps({
      last: new Date((NOW - REACTIVATION_REQUEST_DEDUPE_SECONDS - 60) * 1000).toISOString(),
    });
    const r = await requestReactivation(x.d, { orgId: ORG_ID, actor: ACTOR });
    expect(r).toEqual({ ok: true, outcome: "requested" });
  });

  it("an org that is not cancelled has nothing to reactivate", async () => {
    const x = deps({ status: "active" });
    expect(await requestReactivation(x.d, { orgId: ORG_ID, actor: ACTOR })).toEqual({
      ok: false,
      reason: "not_cancelled",
    });
    expect(x.notices).toEqual([]);
  });
});
