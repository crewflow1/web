import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { describeIntegration, serviceClient } from "../_harness";
import { generateWebhookSecret } from "@/lib/webhooks/secret";

/**
 * Train A outbound webhooks — Resume / re-ping must RE-ENABLE a
 * 'disabled_by_failures' endpoint, proven against real Postgres.
 *
 * THE DEFECT THIS FILE PINS (the C39 self-strand class: unrecoverable state +
 * false-success UI).
 *   webhook_claim_deliveries filters out every delivery whose endpoint is
 *   'disabled_by_failures' (pings included — a ping is an ordinary delivery with
 *   event_id NULL). The breaker (webhook_mark_failed) trips with no guard on
 *   verified state, so a never-verified endpoint can be driven to
 *   'disabled_by_failures' by repeated dead pings. The ONLY breaker reset lives
 *   in webhook_mark_delivered, which runs only on a CLAIMED delivery — and a
 *   disabled endpoint's deliveries are never claimed. Circular ⇒ permanently
 *   dead. Pre-fix, resumeWebhookEndpoint's unverified branch and
 *   repingWebhookEndpoint merely ENQUEUED a ping and returned success, without
 *   ever clearing 'disabled_by_failures' / consecutive_failures — so the ping was
 *   unclaimable and the controls LIED about success.
 *
 * THE FIX. Both controls now reset the breaker (service-role UPDATE: status off
 * 'disabled_by_failures', consecutive_failures = 0) BEFORE enqueuing the ping, so
 * the endpoint is claimable again and the ping can actually be delivered.
 *
 * These are state-transition + claimability proofs. The real server actions are
 * exercised with the flag on, an admin org context, and the service-role client
 * standing in for both the tenant and admin Supabase clients (org pinning via
 * `.eq('org_id', …)` is preserved either way). The claim RPC is invoked exactly
 * as the real delivery pass invokes it.
 */

// The write path is flag-gated; turn it on for the action under test.
vi.mock("@/lib/webhooks/flags", () => ({
  outboundWebhooksEnabled: () => true,
}));

// revalidatePath is a no-op outside a request scope.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

// Both the tenant client (createClient) and the service-role client
// (createAdminClient) resolve to the live service-role client. The action's
// org-scoping (`.eq('org_id', …)`) is what this suite verifies is honoured.
const clientHolder: { svc: unknown } = { svc: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(clientHolder.svc),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => clientHolder.svc,
}));

// requireOrgContext is the authorised admin caller for the fixture org.
const authState: { value: unknown } = { value: null };
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: () => Promise.resolve(authState.value),
}));

import {
  resumeWebhookEndpoint,
  repingWebhookEndpoint,
} from "@/app/(app)/settings/webhooks/actions";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
  select(c?: string): PromiseLike<Res<Row[]>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row): Ins;
  update(v: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
type Rpc = (fn: string, args?: Row) => Promise<Res<unknown>>;
type Client = { from(t: string): Table; rpc: Rpc };
const db = (c: unknown) => c as unknown as Client;

/** Must match FAILURE_THRESHOLD in server/services/webhook-dispatch.ts. */
const FAILURE_THRESHOLD = 5;

const T = `it-wh-reenable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Train A webhook Resume/re-ping re-enables a disabled endpoint (real Postgres)", () => {
  let orgId = "";
  const svc = () => db(serviceClient());

  const fd = (endpointId: string): FormData => {
    const f = new FormData();
    f.set("endpoint_id", endpointId);
    return f;
  };

  /** Create an endpoint (always born paused/unverified) and drive it into
   *  'disabled_by_failures'. If `verified`, stamp verified_at first (the
   *  sanctioned NULL→timestamp move) so the disabled endpoint is a verified one. */
  const mkDisabledEndpoint = async (opts: { verified: boolean }): Promise<string> => {
    const ins = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const id = String(ins.data?.id);

    if (opts.verified) {
      const v = await svc()
        .from("webhook_endpoints")
        .update({ verified_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      expect(v.error, v.error?.message).toBeNull();
    }

    // Trip the breaker: the state a run of dead deliveries leaves behind.
    const dis = await svc()
      .from("webhook_endpoints")
      .update({ status: "disabled_by_failures", consecutive_failures: FAILURE_THRESHOLD })
      .eq("id", id)
      .select("id");
    expect(dis.error, dis.error?.message).toBeNull();
    return id;
  };

  const endpointState = async (id: string): Promise<{ status: string; consecutive_failures: number; verified_at: string | null }> => {
    const res = await svc()
      .from("webhook_endpoints")
      .select("status, consecutive_failures, verified_at")
      .eq("id", id)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    return res.data as unknown as { status: string; consecutive_failures: number; verified_at: string | null };
  };

  /** The pending ping (event_id NULL) currently enqueued for an endpoint. */
  const pendingPingId = async (endpointId: string): Promise<string | null> => {
    const res = await svc()
      .from("webhook_deliveries")
      .select("id")
      .eq("endpoint_id", endpointId)
      .eq("state", "pending")
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    return res.data ? String(res.data.id) : null;
  };

  /** Delivery ids that webhook_claim_deliveries hands the delivery pass. A large
   *  limit so an accumulated backlog can never crowd our fresh ping out. */
  const claimedIds = async (): Promise<Set<string>> => {
    const res = await svc().rpc("webhook_claim_deliveries", { p_limit: 2000 });
    expect(res.error, res.error?.message).toBeNull();
    const rows = (res.data ?? []) as Array<{ delivery_id: string }>;
    return new Set(rows.map((r) => r.delivery_id));
  };

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "WH Re-enable", slug: `${T}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id);

    authState.value = {
      user: { id: randomUUID() },
      ctx: {
        membership: { org_id: orgId, role: "admin" },
        org: { id: orgId, name: "WH Re-enable", slug: `${T}-org`, status: "active", plan: "pro", trial_ends_at: null, created_at: new Date().toISOString(), onboarding_state: {} },
      },
    };
    clientHolder.svc = serviceClient();
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  // -------------------------------------------------------------------
  // The premise (the RED mechanism): a ping on a STILL-disabled endpoint is
  // never claimable — which is exactly why enqueue-without-reset was a lie.
  // -------------------------------------------------------------------

  it("PREMISE: a ping enqueued on a still-'disabled_by_failures' endpoint is NOT claimable; it becomes claimable only once the breaker is reset", async () => {
    const id = await mkDisabledEndpoint({ verified: false });

    // Enqueue a ping WITHOUT touching the breaker — the pre-fix action's behaviour.
    const enq = await svc().rpc("webhook_enqueue_ping", { p_endpoint_id: id, p_org_id: orgId });
    expect(enq.error, enq.error?.message).toBeNull();
    const pingId = await pendingPingId(id);
    expect(pingId, "a pending ping must exist").toBeTruthy();

    // While disabled, the claim filter excludes it — the stranding.
    expect((await claimedIds()).has(pingId!)).toBe(false);

    // Reset the breaker (what the fix now does) ⇒ the SAME ping is claimable.
    const reset = await svc()
      .from("webhook_endpoints")
      .update({ status: "paused", consecutive_failures: 0 })
      .eq("id", id)
      .select("id");
    expect(reset.error, reset.error?.message).toBeNull();
    expect((await claimedIds()).has(pingId!)).toBe(true);
  });

  // -------------------------------------------------------------------
  // resumeWebhookEndpoint — unverified disabled endpoint
  // -------------------------------------------------------------------

  it("resumeWebhookEndpoint re-enables an UNVERIFIED disabled endpoint (→ paused, failures 0) and its ping is claimable", async () => {
    const id = await mkDisabledEndpoint({ verified: false });

    const out = await resumeWebhookEndpoint({ ok: false, error: null, values: {} } as never, fd(id));
    expect(out.ok, out.error ?? "action must succeed").toBe(true);

    const st = await endpointState(id);
    expect(st.status, "endpoint must leave 'disabled_by_failures'").toBe("paused");
    expect(st.consecutive_failures, "breaker counter must be reset").toBe(0);
    expect(st.verified_at, "still unverified — re-earns active via a 2xx").toBeNull();

    const pingId = await pendingPingId(id);
    expect(pingId, "resume must have enqueued a ping").toBeTruthy();
    expect((await claimedIds()).has(pingId!), "the ping must now be claimable").toBe(true);
  });

  // -------------------------------------------------------------------
  // repingWebhookEndpoint — unverified + verified disabled endpoints
  // -------------------------------------------------------------------

  it("repingWebhookEndpoint re-enables an UNVERIFIED disabled endpoint (→ paused, failures 0) and its ping is claimable", async () => {
    const id = await mkDisabledEndpoint({ verified: false });

    const out = await repingWebhookEndpoint({ ok: false, error: null, values: {} } as never, fd(id));
    expect(out.ok, out.error ?? "action must succeed").toBe(true);

    const st = await endpointState(id);
    expect(st.status).toBe("paused");
    expect(st.consecutive_failures).toBe(0);

    const pingId = await pendingPingId(id);
    expect(pingId).toBeTruthy();
    expect((await claimedIds()).has(pingId!)).toBe(true);
  });

  it("repingWebhookEndpoint re-enables a VERIFIED disabled endpoint (→ active, failures 0) and its ping is claimable", async () => {
    const id = await mkDisabledEndpoint({ verified: true });

    const out = await repingWebhookEndpoint({ ok: false, error: null, values: {} } as never, fd(id));
    expect(out.ok, out.error ?? "action must succeed").toBe(true);

    const st = await endpointState(id);
    expect(st.status, "a verified endpoint returns to active").toBe("active");
    expect(st.consecutive_failures).toBe(0);

    const pingId = await pendingPingId(id);
    expect(pingId).toBeTruthy();
    expect((await claimedIds()).has(pingId!)).toBe(true);
  });

  // -------------------------------------------------------------------
  // No collateral damage: a healthy (verified) endpoint is not disturbed.
  // -------------------------------------------------------------------

  it("repingWebhookEndpoint does NOT reactivate a deliberately-paused VERIFIED endpoint (only a tripped breaker is reset)", async () => {
    // A healthy, verified endpoint the admin has intentionally paused.
    const ins = await svc()
      .from("webhook_endpoints")
      .insert({
        org_id: orgId,
        url: `https://hooks.example.com/${randomUUID()}`,
        secret: generateWebhookSecret(),
        event_verbs: ["org.created"],
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const id = String(ins.data?.id);
    const v = await svc()
      .from("webhook_endpoints")
      .update({ verified_at: new Date().toISOString(), status: "paused" })
      .eq("id", id)
      .select("id");
    expect(v.error, v.error?.message).toBeNull();

    const out = await repingWebhookEndpoint({ ok: false, error: null, values: {} } as never, fd(id));
    expect(out.ok).toBe(true);

    const st = await endpointState(id);
    expect(st.status, "a paused (non-disabled) endpoint must stay paused").toBe("paused");
  });
});
