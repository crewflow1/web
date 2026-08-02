import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * OFFLINE WRITE EXPANSION 2 (train "offl") — the database-level guarantees for
 * the two new verticals, delay_event.create and site_report.create (both DRAFT
 * creates), proven against real Postgres (migration 20261101000000). Mirrors
 * offline-write-expansion.test.ts (the snag/MR proof); read that file's header
 * for why these are demonstrated on the AUTHENTICATED user client.
 *
 * Both are single-statement draft creates, so the proof is the diary's shape
 * verbatim: (org_id, client_write_key) makes a replay ONE row, the index is
 * org-scoped and partial (NULL keys never collide), a queued write does not
 * bypass RLS, and the DB alone does not prevent RE-HOMING — which is exactly why
 * dispatchOfflineWrite pins the active org (the #456 seam).
 */

type Err = { message: string; code?: string } | null;
type Res<T> = { data: T | null; error: Err };
interface Sel extends PromiseLike<Res<Record<string, unknown>[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Record<string, unknown>[]>> {
  select(columns?: string): { single(): PromiseLike<Res<{ id: string }>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Record<string, unknown> | Record<string, unknown>[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-offx2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("offline write expansion 2 · DB idempotency (20261101)", () => {
  const svc = () => db(serviceClient());
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  /** A genuinely MULTI-ORG member — the shape the app-level org pin exists for. */
  let member = { id: "", token: "" };
  /** Authenticated, but a member of neither org. */
  let outsider = { id: "", token: "" };

  const mkOrg = async (label: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name: `Offline Expansion2 ${label}`, slug: `${TOKEN}-${label}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data?.id ?? "");
    if (!id) throw new Error(`failed to create org ${label}`);
    return id;
  };

  const mkJob = async (org: string) => {
    const r = await svc().from("jobs").insert({ org_id: org }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data?.id ?? "");
    if (!id) throw new Error(`failed to create job in ${org}`);
    return id;
  };

  const mkUser = async (label: string) => {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${label}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    if (!id) throw new Error(`failed to create user ${label}`);
    await svc().from("users").insert({ id, email });
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!token) throw new Error(`failed to mint a token for ${label}`);
    return { id, token };
  };

  /** One delay-event draft insert, exactly as createDelayEventDraftRecord builds it. */
  const insertDelay = (
    client: unknown,
    args: {
      orgId: string;
      jobId: string;
      clientKey: string | null;
      createdBy?: string | null;
      description?: string;
      offlineAuthoredAt?: string | null;
    },
  ) =>
    db(client)
      .from("delay_events")
      .insert({
        org_id: args.orgId,
        job_id: args.jobId,
        category: "weather",
        started_on: "2026-07-30",
        description: args.description ?? "Heavy rain stopped groundworks",
        status: "draft",
        created_by: args.createdBy ?? null,
        client_write_key: args.clientKey,
        offline_authored_at: args.offlineAuthoredAt ?? null,
      });

  /** One site-report draft insert, exactly as createSiteReportDraftRecord builds it. */
  const insertReport = (
    client: unknown,
    args: {
      orgId: string;
      clientKey: string | null;
      title?: string;
      preparedBy?: string | null;
      offlineAuthoredAt?: string | null;
    },
  ) =>
    db(client)
      .from("site_reports")
      .insert({
        org_id: args.orgId,
        title: args.title ?? "Week 30 progress",
        period_start: "2026-07-27",
        period_end: "2026-07-31",
        status: "draft",
        revision: 1,
        prepared_by: args.preparedBy ?? null,
        client_write_key: args.clientKey,
        offline_authored_at: args.offlineAuthoredAt ?? null,
      });

  const countByKey = async (table: string, orgId: string, clientKey: string) => {
    const r = await svc()
      .from(table)
      .select("id")
      .eq("org_id", orgId)
      .eq("client_write_key", clientKey);
    expect(r.error, r.error?.message).toBeNull();
    return (r.data ?? []).length;
  };

  beforeAll(async () => {
    orgA = await mkOrg("A");
    orgB = await mkOrg("B");
    jobA = await mkJob(orgA);
    jobB = await mkJob(orgB);
    member = await mkUser("member");
    outsider = await mkUser("outsider");
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: member.id, role: "staff" });
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
    for (const u of [member, outsider]) {
      if (u.id) {
        await svc().from("users").delete().eq("id", u.id);
        await serviceClient().auth.admin.deleteUser(u.id);
      }
    }
  });

  // ── delay events ────────────────────────────────────────────────────────────
  it("DELAYS: replaying the same queued item twice yields exactly ONE row", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertDelay(as, {
      orgId: orgA,
      jobId: jobA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(first.error, first.error?.message).toBeNull();

    const replay = await insertDelay(as, {
      orgId: orgA,
      jobId: jobA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(replay.error, "the replay must be REFUSED by the database").not.toBeNull();
    expect(replay.error?.code, "unique violation").toBe("23505");
    expect(await countByKey("delay_events", orgA, key)).toBe(1);
  });

  it("DELAYS: stays ONE row across mutated retries; the FIRST write survives", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertDelay(as, {
      orgId: orgA,
      jobId: jobA,
      clientKey: key,
      createdBy: member.id,
      description: "original words",
    });
    expect(first.error, first.error?.message).toBeNull();
    for (let i = 0; i < 3; i++) {
      const r = await insertDelay(as, {
        orgId: orgA,
        jobId: jobA,
        clientKey: key,
        createdBy: member.id,
        description: `mutated retry ${i}`,
      });
      expect(r.error?.code, `retry ${i}`).toBe("23505");
    }
    const row = await svc()
      .from("delay_events")
      .select("description")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    expect((row.data ?? [])[0]?.description).toBe("original words");
  });

  it("DELAYS: the index is ORG-SCOPED; NULL keys never collide (online history unaffected)", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const a = await insertDelay(as, { orgId: orgA, jobId: jobA, clientKey: key, createdBy: member.id });
    expect(a.error, a.error?.message).toBeNull();
    const b = await insertDelay(as, { orgId: orgB, jobId: jobB, clientKey: key, createdBy: member.id });
    expect(b.error, b.error?.message).toBeNull();
    expect(await countByKey("delay_events", orgA, key)).toBe(1);
    expect(await countByKey("delay_events", orgB, key)).toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await insertDelay(as, {
        orgId: orgA,
        jobId: jobA,
        clientKey: null,
        createdBy: member.id,
        description: `legacy online delay ${i}`,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
  });

  it("DELAYS: the DB alone does not prevent RE-HOMING — which is why the app pins the org", async () => {
    // A multi-org JWT satisfies RLS for both orgs and the index is per-org, so
    // only dispatchOfflineWrite's org_mismatch refusal keeps a queued delay out
    // of the wrong company. This pins the reason that check may never be removed.
    const key = crypto.randomUUID();
    const rehomed = await insertDelay(userClient(member.token), {
      orgId: orgB, // authored for A; nothing in the DB objects
      jobId: jobB,
      clientKey: key,
      createdBy: member.id,
    });
    expect(rehomed.error, rehomed.error?.message).toBeNull();
    expect(await countByKey("delay_events", orgB, key)).toBe(1);
  });

  it("DELAYS: a queued write does NOT bypass RLS — non-member and anon are refused", async () => {
    const key = crypto.randomUUID();
    const r = await insertDelay(userClient(outsider.token), {
      orgId: orgA,
      jobId: jobA,
      clientKey: key,
      createdBy: outsider.id,
    });
    expect(r.error, "RLS must refuse a non-member insert").not.toBeNull();
    const a = await insertDelay(anonClient(), { orgId: orgA, jobId: jobA, clientKey: key });
    expect(a.error).not.toBeNull();
    expect(await countByKey("delay_events", orgA, key)).toBe(0);
  });

  it("DELAYS: offline_authored_at round-trips as display-only provenance; born 'draft'", async () => {
    const key = crypto.randomUUID();
    const authored = "2026-07-31T16:02:00.000Z";
    const r = await insertDelay(userClient(member.token), {
      orgId: orgA,
      jobId: jobA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: authored,
    });
    expect(r.error, r.error?.message).toBeNull();
    const row = await svc()
      .from("delay_events")
      .select("offline_authored_at, created_at, status, recorded_at")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    const got = (row.data ?? [])[0];
    expect(new Date(String(got?.offline_authored_at)).toISOString()).toBe(authored);
    expect(got?.created_at).not.toBe(got?.offline_authored_at);
    // the replayed create carried NO lifecycle progress with it
    expect(got?.status).toBe("draft");
    expect(got?.recorded_at).toBeNull();
  });

  // ── site reports ──────────────────────────────────────────────────────────────
  it("REPORTS: replaying the same queued item twice yields exactly ONE row", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertReport(as, { orgId: orgA, clientKey: key, preparedBy: member.id });
    expect(first.error, first.error?.message).toBeNull();
    const replay = await insertReport(as, { orgId: orgA, clientKey: key, preparedBy: member.id });
    expect(replay.error, "the replay must be REFUSED").not.toBeNull();
    expect(replay.error?.code).toBe("23505");
    expect(await countByKey("site_reports", orgA, key)).toBe(1);
  });

  it("REPORTS: stays ONE row across mutated retries; the FIRST write survives", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertReport(as, {
      orgId: orgA,
      clientKey: key,
      preparedBy: member.id,
      title: "original title",
    });
    expect(first.error, first.error?.message).toBeNull();
    for (let i = 0; i < 3; i++) {
      const r = await insertReport(as, {
        orgId: orgA,
        clientKey: key,
        preparedBy: member.id,
        title: `mutated retry ${i}`,
      });
      expect(r.error?.code, `retry ${i}`).toBe("23505");
    }
    const row = await svc()
      .from("site_reports")
      .select("title")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    expect((row.data ?? [])[0]?.title).toBe("original title");
  });

  it("REPORTS: the index is ORG-SCOPED and partial, like every sibling", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const a = await insertReport(as, { orgId: orgA, clientKey: key, preparedBy: member.id });
    expect(a.error, a.error?.message).toBeNull();
    const b = await insertReport(as, { orgId: orgB, clientKey: key, preparedBy: member.id });
    expect(b.error, b.error?.message).toBeNull();
    for (let i = 0; i < 2; i++) {
      const r = await insertReport(as, {
        orgId: orgA,
        clientKey: null,
        preparedBy: member.id,
        title: `legacy online report ${i}`,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
  });

  it("REPORTS: a queued write does NOT bypass RLS — non-member and anon are refused", async () => {
    const key = crypto.randomUUID();
    const r = await insertReport(userClient(outsider.token), {
      orgId: orgA,
      clientKey: key,
      preparedBy: outsider.id,
    });
    expect(r.error, "RLS must refuse a non-member insert").not.toBeNull();
    const a = await insertReport(anonClient(), { orgId: orgA, clientKey: key });
    expect(a.error).not.toBeNull();
    expect(await countByKey("site_reports", orgA, key)).toBe(0);
  });

  it("REPORTS: offline_authored_at round-trips as display-only provenance; born 'draft'", async () => {
    const key = crypto.randomUUID();
    const authored = "2026-07-31T16:02:00.000Z";
    const r = await insertReport(userClient(member.token), {
      orgId: orgA,
      clientKey: key,
      preparedBy: member.id,
      offlineAuthoredAt: authored,
    });
    expect(r.error, r.error?.message).toBeNull();
    const row = await svc()
      .from("site_reports")
      .select("offline_authored_at, created_at, status, issued_at")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    const got = (row.data ?? [])[0];
    expect(new Date(String(got?.offline_authored_at)).toISOString()).toBe(authored);
    expect(got?.created_at).not.toBe(got?.offline_authored_at);
    expect(got?.status).toBe("draft");
    expect(got?.issued_at).toBeNull();
  });

  // ── teardown safety (the 20261052 lesson) ──────────────────────────────────
  it("org teardown still cascades with the new columns + indexes in place", async () => {
    const doomed = await mkOrg("doomed");
    const doomedJob = await mkJob(doomed);
    const m = await svc()
      .from("memberships")
      .insert({ org_id: doomed, user_id: member.id, role: "staff" });
    expect(m.error, m.error?.message).toBeNull();
    const as = userClient(member.token);

    const delay = await insertDelay(as, {
      orgId: doomed,
      jobId: doomedJob,
      clientKey: crypto.randomUUID(),
      createdBy: member.id,
    });
    expect(delay.error, delay.error?.message).toBeNull();
    const report = await insertReport(as, {
      orgId: doomed,
      clientKey: crypto.randomUUID(),
      preparedBy: member.id,
    });
    expect(report.error, report.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();
    for (const table of ["delay_events", "site_reports"]) {
      const left = await svc().from(table).select("id").eq("org_id", doomed);
      expect(left.data ?? [], table).toHaveLength(0);
    }
  });
});
