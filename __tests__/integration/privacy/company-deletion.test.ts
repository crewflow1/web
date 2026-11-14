import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  admin,
  asLoose,
  cleanup,
  countOrgObjects,
  countRows,
  db,
  ledger,
  makeDue,
  mkOrg,
  mkUser,
  newMarkers,
  residue,
  seedMemberFootprint,
  seedOrgBusinessData,
  signIn,
  snapshotOrg,
  stripeMock,
  uploadOrgObjects,
  type Markers,
  type TestOrg,
  type TestUser,
} from "./_fixtures";
import {
  cancelOrgDeletion,
  requestOrgDeletion,
  runDeletionRequest,
  ORG_DELETION_COOLING_OFF_SECONDS,
  type DeletionAdminClient,
} from "@/server/services/privacy-deletion";
import { buildOrgExport } from "@/server/services/gdpr-export";

/**
 * COMPANY DELETION — real Postgres, real Storage, real Supabase Auth; Stripe is
 * a recording stand-in (SIMULATED).
 *
 * Each `it` builds its own synthetic company so the cases cannot contaminate one
 * another, and a bystander company (org B, with a user who also belongs to a
 * target company) is snapshotted before and after to prove the blast radius.
 */

const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

type World = {
  m: Markers;
  owner: TestUser;
  adminUser: TestUser;
  staff: TestUser;
  shared: TestUser; // belongs to the target AND to the bystander org
  org: TestOrg;
};

async function buildWorld(
  prefix: string,
  bystander: TestOrg,
  opts: { subscription?: boolean; shareWithBystander?: boolean } = {},
): Promise<World> {
  const m = newMarkers(prefix);
  const owner = await mkUser(m, "owner");
  const adminUser = await mkUser(m, "admin");
  const staff = await mkUser(m, "staff");
  const shared = await mkUser(m, "shared");
  created.users.push(owner.id, adminUser.id, staff.id, shared.id);
  const org = await mkOrg(m, "target", [
    { user: owner, role: "owner" },
    { user: adminUser, role: "admin" },
    { user: staff, role: "staff" },
    { user: shared, role: "staff" },
  ]);
  created.orgs.push(org.id);
  if (opts.shareWithBystander !== false) {
    const add = await db().from("memberships").insert({ org_id: bystander.id, user_id: shared.id, role: "staff" });
    expect(add.error, add.error?.message).toBeNull();
  }

  const seed = await seedOrgBusinessData(org, m);
  await seedMemberFootprint(org, seed, staff, m, { withPayroll: true });
  await uploadOrgObjects(org.id, m);
  if (opts.subscription) {
    const u = await db()
      .from("organizations")
      .update({ stripe_customer_id: "cus_TESTdeletion0001", stripe_subscription_id: "sub_TESTdeletion0001" })
      .eq("id", org.id);
    expect(u.error, u.error?.message).toBeNull();
  }
  return { m, owner, adminUser, staff, shared, org };
}

describeIntegration("privacy · company deletion", () => {
  let bm: Markers;
  let bOwner: TestUser;
  let orgB: TestOrg;

  beforeAll(async () => {
    bm = newMarkers("bystander");
    bOwner = await mkUser(bm, "owner");
    created.users.push(bOwner.id);
    orgB = await mkOrg(bm, "bystander", [{ user: bOwner, role: "owner" }]);
    created.orgs.push(orgB.id);
    const seed = await seedOrgBusinessData(orgB, bm);
    await seedMemberFootprint(orgB, seed, bOwner, bm, { withPayroll: true });
    await uploadOrgObjects(orgB.id, bm);
  }, 120_000);

  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("deletes the whole company: rows, files, memberships, identities — no residue, bystander untouched", async () => {
    const w = await buildWorld("full", orgB, { subscription: true });
    const stripe = stripeMock();
    const before = await snapshotOrg(orgB.id, [bOwner.id, w.shared.id]);
    const baseline = await residue(w.m);
    expect(baseline.length, "markers must be present before deletion or the scan proves nothing").toBeGreaterThan(15);
    expect(await countOrgObjects(w.org.id)).toBe(4);
    const staffToken = await signIn(w.staff);

    // ── export-before-delete still works for the owner ──────────────────────
    const ownerToken = await signIn(w.owner);
    const exp = await buildOrgExport({
      orgId: w.org.id,
      generatedAt: "2026-11-14T00:00:00.000Z",
      client: userClient(ownerToken) as never,
      adminClient: serviceClient() as never,
    });
    const customers = exp.tables.find((t) => t.table === "customers");
    expect(customers?.rowCount, "the owner can still take their data out first").toBe(1);

    // ── request: cooling-off, nothing destroyed ─────────────────────────────
    const req = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    expect(req.created).toBe(true);
    const wait = new Date(req.scheduledFor).getTime() - Date.now();
    expect(wait).toBeGreaterThan((ORG_DELETION_COOLING_OFF_SECONDS - 60) * 1000);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);

    // Not due yet → the engine refuses to claim it.
    const early = await runDeletionRequest(req.requestId, { admin: admin(), stripe });
    expect(early.status).toBe("not_claimed");
    expect(stripe.calls).toEqual([]);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);

    // ── run once due ────────────────────────────────────────────────────────
    await makeDue(req.requestId);
    const order: string[] = [];
    const run = await runDeletionRequest(req.requestId, {
      admin: admin(),
      stripe,
      afterStep: (s) => {
        order.push(s);
      },
    });
    expect(run.status).toBe("completed");
    expect(order).toEqual(["stripe_cancel", "lockout", "storage", "teardown", "identities"]);
    // Stripe was cancelled FIRST, once, with an idempotency key bound to the request.
    expect(stripe.calls).toEqual([
      "retrieve:sub_TESTdeletion0001",
      `cancel:sub_TESTdeletion0001:privacy-deletion-${req.requestId}-sub_TESTdeletion0001`,
    ]);

    // ── gone ────────────────────────────────────────────────────────────────
    expect(await countRows("organizations", { id: w.org.id })).toBe(0);
    for (const t of ["customers", "jobs", "messages", "comm_events", "memberships", "payroll_lines", "time_entries", "staff_secrets", "billing_events", "billing_invoices", "notifications"]) {
      expect(await countRows(t, { org_id: w.org.id }), t).toBe(0);
    }
    expect(await countOrgObjects(w.org.id), "storage objects").toBe(0);

    // Sole-company members: identity destroyed, session dead.
    for (const u of [w.owner, w.adminUser, w.staff]) {
      const got = await serviceClient().auth.admin.getUserById(u.id);
      expect(got.data.user, `auth user ${u.email} should be gone`).toBeNull();
      expect(await countRows("users", { id: u.id })).toBe(0);
    }
    expect(await countRows("staff_compensation", { user_id: w.staff.id })).toBe(0);
    const stale = await anonClient().auth.getUser(staffToken);
    expect(stale.data.user, "a pre-deletion access token must no longer resolve").toBeNull();

    // The member who also works elsewhere keeps their account, untouched.
    const sharedAuth = await serviceClient().auth.admin.getUserById(w.shared.id);
    expect(sharedAuth.data.user?.email).toBe(w.shared.email);
    expect(await countRows("memberships", { user_id: w.shared.id })).toBe(1);

    // ── catalogue-driven residue scan ───────────────────────────────────────
    const left = await residue(w.m);
    // The ONLY permitted survivor is the still-employed-elsewhere member's own
    // live profile (their account was correctly kept).
    const unexpected = left.filter(
      (r) => !/^(public\.users\.|auth\.users\.|auth\.identities\.|auth\.audit_log_entries\.)/.test(r.location),
    );
    expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
    const sharedOnly = await db().from("users").select("id").eq("id", w.shared.id);
    expect(sharedOnly.data?.length).toBe(1);
    for (const r of left.filter((x) => x.location.startsWith("public.users."))) {
      expect(r.hits, `${r.location} should only be the kept member`).toBe(1);
    }

    // ── retained records: minimised, no identity ────────────────────────────
    const kept = await db().from("privacy_retained_billing_records").select("*").eq("former_org_id", w.org.id);
    const rows = (kept.data ?? []) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.record_kind).sort()).toEqual(["billing_invoice", "org_account"]);
    const account = rows.find((r) => r.record_kind === "org_account");
    expect(account?.stripe_customer_id).toBe("cus_TESTdeletion0001");
    expect(account?.stripe_subscription_id).toBe("sub_TESTdeletion0001");
    const invoice = rows.find((r) => r.record_kind === "billing_invoice");
    expect(Number(invoice?.amount_gbp)).toBe(99);
    expect(invoice?.currency).toBe("GBP");
    expect(String(invoice?.retention_until)).toMatch(/^20\d\d-12-31$/);
    expect(JSON.stringify(rows)).not.toContain(w.m.name);

    // ── tombstone: evidence without the data ────────────────────────────────
    const tomb = await ledger(req.requestId);
    expect(tomb.status).toBe("completed");
    expect(tomb.actor_role).toBe("owner");
    expect(tomb.work).toEqual({});
    const counts = (tomb.counts as { org_tables: Record<string, number> }).org_tables;
    expect(counts.customers).toBe(1);
    expect(counts.comm_events).toBe(1);
    expect((tomb.steps as Record<string, { objects?: number }>).storage.objects).toBe(4);
    const text = JSON.stringify(tomb);
    for (const s of [w.m.name, w.m.email, w.m.phone, w.org.slug]) expect(text).not.toContain(s);

    // ── bystander: byte-for-byte unaffected ─────────────────────────────────
    expect(await snapshotOrg(orgB.id, [bOwner.id, w.shared.id])).toBe(before);

    // ── idempotent: running it again does nothing ───────────────────────────
    const again = await runDeletionRequest(req.requestId, { admin: admin(), stripe });
    expect(again.status).toBe("not_claimed");
    expect(stripe.calls.length).toBe(2);
    expect(await ledger(req.requestId)).toEqual(tomb);
  }, 180_000);

  it("a sealed tombstone cannot be edited or deleted", async () => {
    const done = await db().from("privacy_deletion_requests").select("id").eq("status", "completed").limit(1);
    const id = String((done.data?.[0] as { id?: string } | undefined)?.id ?? "");
    expect(id).not.toBe("");
    const upd = await db().from("privacy_deletion_requests").update({ counts: {} }).eq("id", id).select("id");
    expect(upd.error?.message ?? "").toMatch(/sealed tombstone/);
    const del = await db().from("privacy_deletion_requests").delete().eq("id", id).select("id");
    expect(del.error?.message ?? "").toMatch(/permission denied|never deleted/);
  });

  it("authorisation: only the owner of THAT company, with the exact name, can request it", async () => {
    const w = await buildWorld("authz", orgB);
    const attempt = (actor: TestUser, confirmName = w.org.name) =>
      requestOrgDeletion({ orgId: w.org.id, actorUserId: actor.id, confirmName }, { admin: admin() });

    for (const [who, actor] of [
      ["admin", w.adminUser],
      ["staff", w.staff],
      ["owner of another company", bOwner],
    ] as const) {
      const r = await attempt(actor);
      expect(r.ok, who).toBe(false);
      if (!r.ok) expect(r.code, who).toBe("forbidden");
    }
    for (const wrong of ["", "  ", w.org.slug, `${w.org.name} `.toUpperCase(), orgB.name]) {
      const r = await attempt(w.owner, wrong);
      expect(r.ok, `confirm="${wrong}"`).toBe(false);
      if (!r.ok) expect(r.code).toBe("confirmation");
    }
    // The owner of B cannot aim a request at this org even with its right name.
    const cross = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: bOwner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(cross.ok).toBe(false);

    expect(await countRows("privacy_deletion_requests", { target_org_id: w.org.id })).toBe(0);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
  }, 120_000);

  it("the primitives are unreachable with the anon key or a signed-in user's JWT", async () => {
    const w = await buildWorld("grants", orgB);
    const ownerJwt = asLoose(userClient(await signIn(w.owner)));
    const anon = asLoose(anonClient());
    const calls: Array<[string, Record<string, unknown>]> = [
      ["privacy_request_create", { p_kind: "org", p_target_org_id: w.org.id, p_target_user_id: null, p_actor_user_id: w.owner.id, p_confirm: w.org.name, p_cooling_off_seconds: 0 }],
      ["privacy_request_claim", { p_request_id: w.org.id, p_lease_seconds: 60 }],
      ["privacy_request_cancel", { p_request_id: w.org.id, p_actor_user_id: w.owner.id }],
      ["privacy_request_complete", { p_request_id: w.org.id, p_required_steps: [] }],
      ["privacy_org_lockout", { p_request_id: w.org.id }],
      ["privacy_org_teardown", { p_request_id: w.org.id, p_retention_until: "2040-12-31" }],
      ["privacy_user_lockout", { p_request_id: w.org.id }],
      ["privacy_user_identity_scrub", { p_request_id: w.org.id, p_user_id: w.owner.id, p_global_delete: [] }],
      ["privacy_user_auth_audit_purge", { p_request_id: w.org.id, p_user_id: w.owner.id }],
      ["privacy_residue_scan", { p_markers: [w.m.name] }],
      ["privacy_tombstone_reapply", { p_tombstone: { id: w.org.id, kind: "org", target_org_id: w.org.id } }],
    ];
    for (const [fn, args] of calls) {
      for (const [label, client] of [["anon", anon], ["owner JWT", ownerJwt]] as const) {
        const r = await client.rpc(fn, args);
        expect(r.error, `${fn} as ${label} must be refused`).not.toBeNull();
        expect(r.error?.message ?? "", `${fn} as ${label}`).toMatch(/permission denied|service_role only|not find the function/i);
      }
    }
    for (const [label, client] of [["anon", anon], ["owner JWT", ownerJwt]] as const) {
      const read = await client.from("privacy_deletion_requests").select("id").limit(1);
      expect(read.error?.message ?? "", `ledger read as ${label}`).toMatch(/permission denied/i);
      const write = await client
        .from("privacy_deletion_requests")
        .insert({ kind: "org", target_org_id: w.org.id, actor_role: "owner" });
      expect(write.error?.message ?? "", `ledger write as ${label}`).toMatch(/permission denied/i);
      const billing = await client.from("privacy_retained_billing_records").select("id").limit(1);
      expect(billing.error?.message ?? "", `archive read as ${label}`).toMatch(/permission denied/i);
    }
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
  }, 120_000);

  it("double submit returns the SAME request; any owner can cancel during cooling-off; a cancelled request never runs", async () => {
    const w = await buildWorld("cancel", orgB);
    const submit = () =>
      requestOrgDeletion({ orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name }, { admin: admin() });
    const [a, b, c] = await Promise.all([submit(), submit(), submit()]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(1);
    expect([a.created, b.created, c.created].filter(Boolean).length).toBe(1);
    expect(await countRows("privacy_deletion_requests", { target_org_id: w.org.id })).toBe(1);

    // Staff and admins cannot cancel; an owner can.
    for (const u of [w.staff, w.adminUser, bOwner]) {
      const r = await cancelOrgDeletion({ requestId: a.requestId, actorUserId: u.id }, { admin: admin() });
      expect(r.ok).toBe(false);
    }
    const cancelled = await cancelOrgDeletion({ requestId: a.requestId, actorUserId: w.owner.id }, { admin: admin() });
    expect(cancelled).toEqual({ ok: true, changed: true });

    await makeDue(a.requestId).catch(() => undefined); // sealed: the update is refused
    const run = await runDeletionRequest(a.requestId, { admin: admin(), stripe: stripeMock() });
    expect(run.status).toBe("not_claimed");
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(4);
    expect((await ledger(a.requestId)).cancelled_reason).toBe("requester_cancelled");

    // After a cancel, a fresh request is possible.
    const fresh = await submit();
    expect(fresh.ok && fresh.created).toBe(true);
  }, 120_000);

  it("deletion racing a role change: a requester who is no longer the owner cannot destroy the company", async () => {
    const w = await buildWorld("race", orgB);
    const req = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    // During the cooling-off, ownership moves to the admin and the requester is demoted.
    await db().from("memberships").update({ role: "owner" }).eq("org_id", w.org.id).eq("user_id", w.adminUser.id);
    await db().from("memberships").update({ role: "staff" }).eq("org_id", w.org.id).eq("user_id", w.owner.id);

    await makeDue(req.requestId);
    const stripe = stripeMock();
    const run = await runDeletionRequest(req.requestId, { admin: admin(), stripe });
    expect(run.status).toBe("cancelled");
    expect(stripe.calls, "nothing — not even Stripe — is touched").toEqual([]);
    const row = await ledger(req.requestId);
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_reason).toBe("requester_not_owner");
    expect(await countRows("organizations", { id: w.org.id })).toBe(1);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(4);
    expect(await countOrgObjects(w.org.id)).toBe(4);
  }, 120_000);

  it("Stripe fails closed: no client, or a Stripe error, stops the deletion before anything is destroyed", async () => {
    const w = await buildWorld("stripe", orgB, { subscription: true });
    const req = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    await makeDue(req.requestId);

    const unconfigured = await runDeletionRequest(req.requestId, { admin: admin(), stripe: null });
    expect(unconfigured).toMatchObject({ status: "failed", errorCode: "stripe_cancel:stripe_unconfigured" });

    const down = await runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock({ failCancel: true }) });
    expect(down).toMatchObject({ status: "failed", errorCode: "stripe_cancel:stripe_error" });

    const row = await ledger(req.requestId);
    expect(row.status).toBe("failed");
    expect(row.steps).toEqual({});
    expect(row.last_error_code).toBe("stripe_cancel:stripe_error");
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(4);
    expect(await countOrgObjects(w.org.id)).toBe(4);

    // Stripe back (subscription already gone at Stripe) → the SAME request completes.
    const ok = await runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock({ missing: true }) });
    expect(ok.status).toBe("completed");
    expect(await countRows("organizations", { id: w.org.id })).toBe(0);
  }, 180_000);

  it("interrupted at EVERY step boundary, then resumed: finishes exactly once, bystander untouched", async () => {
    const before = await snapshotOrg(orgB.id, [bOwner.id]);
    for (const dieAfter of ["stripe_cancel", "lockout", "storage", "teardown", "identities"]) {
      const w = await buildWorld(`die${dieAfter.slice(0, 3)}`, orgB, {
        subscription: true,
        shareWithBystander: false,
      });
      const req = await requestOrgDeletion(
        { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
        { admin: admin() },
      );
      expect(req.ok).toBe(true);
      if (!req.ok) return;
      await makeDue(req.requestId);

      const stripe = stripeMock();
      const crashed = await runDeletionRequest(req.requestId, {
        admin: admin(),
        stripe,
        afterStep: (s) => {
          if (s === dieAfter) throw new Error("simulated crash");
        },
      });
      expect(crashed.status, dieAfter).toBe("failed");
      const mid = await ledger(req.requestId);
      expect(Object.keys(mid.steps as object), dieAfter).toContain(dieAfter);
      expect(mid.status).toBe("failed");

      const seen: string[] = [];
      const resumed = await runDeletionRequest(req.requestId, {
        admin: admin(),
        stripe,
        afterStep: (s) => {
          seen.push(s);
        },
      });
      expect(resumed.status, dieAfter).toBe("completed");
      expect(seen, `no recorded step is repeated after dying at ${dieAfter}`).not.toContain(dieAfter);
      expect(stripe.calls.filter((c) => c.startsWith("cancel:")).length, "Stripe cancelled exactly once").toBe(1);

      expect(await countRows("organizations", { id: w.org.id })).toBe(0);
      expect(await countOrgObjects(w.org.id)).toBe(0);
      for (const u of [w.owner, w.adminUser, w.staff, w.shared]) {
        expect((await serviceClient().auth.admin.getUserById(u.id)).data.user, dieAfter).toBeNull();
      }
      const tomb = await ledger(req.requestId);
      expect(tomb.status).toBe("completed");
      expect(tomb.attempts).toBe(2);
      // Every member belonged only to this company, so NOTHING may remain anywhere.
      const left = await residue(w.m);
      expect(left, `${dieAfter}: ${JSON.stringify(left)}`).toEqual([]);
    }
    expect(await snapshotOrg(orgB.id, [bOwner.id])).toBe(before);
  }, 600_000);

  it("a hard crash (no failure recorded) holds the lease; two runners never both work; the next claim resumes", async () => {
    const w = await buildWorld("lease", orgB);
    const req = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    await makeDue(req.requestId);

    // A runner that dies so hard it cannot even record the failure.
    const real = admin();
    const dying: DeletionAdminClient = {
      ...real,
      from: real.from.bind(real),
      storage: real.storage,
      auth: real.auth,
      rpc: (fn, args) => {
        if (fn === "privacy_request_fail") throw new Error("process killed");
        return real.rpc(fn, args);
      },
    };
    await expect(
      runDeletionRequest(req.requestId, {
        admin: dying,
        stripe: stripeMock(),
        afterStep: (s) => {
          if (s === "lockout") throw new Error("simulated kill -9");
        },
      }),
    ).rejects.toThrow(/process killed/);
    const stuck = await ledger(req.requestId);
    expect(stuck.status).toBe("running");

    // While the dead runner's lease is live, nobody else may take the job.
    const blocked = await runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock() });
    expect(blocked.status).toBe("not_claimed");

    // Lease expires → exactly ONE of two simultaneous runners gets it.
    const exp = await db()
      .from("privacy_deletion_requests")
      .update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("id", req.requestId);
    expect(exp.error, exp.error?.message).toBeNull();
    const [r1, r2] = await Promise.all([
      runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock() }),
      runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock() }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual(["completed", "not_claimed"]);
    expect(await countRows("organizations", { id: w.org.id })).toBe(0);
    expect((await ledger(req.requestId)).status).toBe("completed");
  }, 180_000);

  it("teardown refuses while a storage object remains, and rolls back completely", async () => {
    const w = await buildWorld("store", orgB);
    const req = await requestOrgDeletion(
      { orgId: w.org.id, actorUserId: w.owner.id, confirmName: w.org.name },
      { admin: admin() },
    );
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    await makeDue(req.requestId);
    // A runner whose storage step "succeeds" without removing anything.
    const real = admin();
    const lazy: DeletionAdminClient = {
      ...real,
      rpc: real.rpc.bind(real),
      from: real.from.bind(real),
      auth: real.auth,
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }),
          remove: async () => ({ data: null, error: null }),
        }),
      },
    };
    const run = await runDeletionRequest(req.requestId, { admin: lazy, stripe: stripeMock() });
    expect(run.status).toBe("failed");
    expect((run as { errorCode: string }).errorCode).toBe("teardown:23514");
    // Fail-closed: the org row and its data are all still there.
    expect(await countRows("organizations", { id: w.org.id })).toBe(1);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countRows("comm_events", { org_id: w.org.id })).toBe(1);
    expect(await countOrgObjects(w.org.id)).toBe(4);
  }, 120_000);
});
