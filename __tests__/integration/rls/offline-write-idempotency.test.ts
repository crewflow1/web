import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * OFFLINE WRITE QUEUE — the idempotency guarantee, proven against real Postgres
 * (migration 20261077000000).
 *
 * The whole offline write feature rests on one claim: **a queued write that is
 * retried cannot create a duplicate row.** JavaScript cannot make that claim
 * credibly — a reinstalled service worker, a second tab, a crash between "sent" and
 * "recorded", or a user double-tapping in a basement all defeat an in-memory or even
 * an IndexedDB-side dedupe. So the guarantee is a partial unique index on
 * (org_id, client_write_key), and this file is where that is demonstrated rather
 * than asserted.
 *
 * Every insert here runs on the AUTHENTICATED user client — the same RLS-subject
 * path the app actually writes through — except where the service role is needed to
 * build or tear down a fixture. An idempotency guarantee that only held for the
 * privileged client would be worthless.
 *
 * It also proves the negative that makes the application-level org pin load-bearing:
 * the database ALONE does not stop a queued write being re-homed into another org
 * (the index is per-org by design), which is precisely why
 * server/services/offline-writes.ts refuses on org mismatch.
 */

type Err = { message: string; code?: string } | null;
type Res<T> = { data: T | null; error: Err };
interface Sel extends PromiseLike<Res<Record<string, unknown>[]>> {
  eq(column: string, value: unknown): Sel;
  is(column: string, value: unknown): Sel;
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

const TOKEN = `it-offq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("offline write queue · DB idempotency (20261077)", () => {
  const svc = () => db(serviceClient());
  let orgA = "";
  let orgB = "";
  /** A genuinely MULTI-ORG member — the shape the org pin exists for. */
  let member = { id: "", token: "" };
  /** Authenticated, but a member of neither org. */
  let outsider = { id: "", token: "" };

  const mkOrg = async (label: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name: `Offline Queue ${label}`, slug: `${TOKEN}-${label}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data?.id ?? "");
    if (!id) throw new Error(`failed to create org ${label}`);
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
    // created_by references public.users — mirror the row as the app does.
    await svc().from("users").insert({ id, email });
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!token) throw new Error(`failed to mint a token for ${label}`);
    return { id, token };
  };

  /** One diary insert, exactly as createDiaryEntryRecord builds it. */
  const insertEntry = (
    client: unknown,
    args: {
      orgId: string;
      clientKey: string | null;
      createdBy?: string | null;
      summary?: string;
      offlineAuthoredAt?: string | null;
      jobId?: string | null;
    },
  ) =>
    db(client)
      .from("site_diary_entries")
      .insert({
        org_id: args.orgId,
        entry_date: "2026-07-30",
        work_summary: args.summary ?? "basement pour, no signal all day",
        job_id: args.jobId ?? null,
        created_by: args.createdBy ?? null,
        client_write_key: args.clientKey,
        offline_authored_at: args.offlineAuthoredAt ?? null,
      });

  const countByKey = async (orgId: string, clientKey: string) => {
    const r = await svc()
      .from("site_diary_entries")
      .select("id")
      .eq("org_id", orgId)
      .eq("client_write_key", clientKey);
    expect(r.error, r.error?.message).toBeNull();
    return (r.data ?? []).length;
  };

  beforeAll(async () => {
    orgA = await mkOrg("A");
    orgB = await mkOrg("B");
    member = await mkUser("member");
    outsider = await mkUser("outsider");
    // The multi-org member belongs to BOTH orgs, so current_org_ids() returns both
    // and RLS alone cannot tell us which org a queued write belongs in.
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

  // ── THE guarantee ──────────────────────────────────────────────────────────
  it("REPLAYING the same queued item twice yields exactly ONE row", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token); // the real, RLS-subject write path

    const first = await insertEntry(as, {
      orgId: orgA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: "2026-07-30T16:02:00.000Z",
    });
    expect(first.error, first.error?.message).toBeNull();

    // The identical replay — same key, same payload, same session. This is what a
    // retry after a lost response, a reinstalled service worker or a second tab does.
    const replay = await insertEntry(as, {
      orgId: orgA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: "2026-07-30T16:02:00.000Z",
    });
    expect(replay.error, "the replay must be REFUSED by the database").not.toBeNull();
    expect(replay.error?.code, "unique violation").toBe("23505");

    expect(await countByKey(orgA, key)).toBe(1);
  });

  it("stays ONE row across many replays, including a changed payload", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertEntry(as, {
      orgId: orgA,
      clientKey: key,
      createdBy: member.id,
      summary: "original words",
    });
    expect(first.error, first.error?.message).toBeNull();

    for (let i = 0; i < 5; i++) {
      // Even a DIFFERENT payload under the same key is refused — the key identifies
      // the write, so a mutated retry can never fork into a second row.
      const r = await insertEntry(as, {
        orgId: orgA,
        clientKey: key,
        createdBy: member.id,
        summary: `mutated retry ${i}`,
      });
      expect(r.error?.code, `retry ${i}`).toBe("23505");
    }
    expect(await countByKey(orgA, key)).toBe(1);

    // and the row that survived is the FIRST one — a replay never overwrites.
    const row = await svc()
      .from("site_diary_entries")
      .select("work_summary")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    expect((row.data ?? [])[0]?.work_summary).toBe("original words");
  });

  it("the surviving row is findable by (org_id, client_write_key) — the duplicate branch", async () => {
    // server/services/offline-writes.ts answers a 23505 by looking the row up this
    // exact way and reporting "duplicate" with its id. Prove the lookup works under
    // the USER's own client, since that is who performs it.
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    await insertEntry(as, { orgId: orgA, clientKey: key, createdBy: member.id });
    const found = await db(as)
      .from("site_diary_entries")
      .select("id")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    expect(found.error, found.error?.message).toBeNull();
    expect(found.data ?? []).toHaveLength(1);
  });

  // ── scope of the index ─────────────────────────────────────────────────────
  it("the index is ORG-SCOPED: the same key in another org is a separate row", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const a = await insertEntry(as, { orgId: orgA, clientKey: key, createdBy: member.id });
    expect(a.error, a.error?.message).toBeNull();
    const b = await insertEntry(as, { orgId: orgB, clientKey: key, createdBy: member.id });
    expect(b.error, b.error?.message).toBeNull();
    // One tenant's replay can never collapse into — or be reported as — another's row.
    expect(await countByKey(orgA, key)).toBe(1);
    expect(await countByKey(orgB, key)).toBe(1);
  });

  it("THE DATABASE ALONE DOES NOT PREVENT RE-HOMING — which is why the app pins the org", async () => {
    /**
     * This is a deliberately uncomfortable test. A multi-org member's JWT satisfies
     * RLS for BOTH orgs, and the unique index is per-org, so nothing at the database
     * layer stops a queued write authored for org A being written into org B. A
     * builder's diary is dispute evidence; filing it against the wrong company is a
     * real defect, not a cosmetic one.
     *
     * The refusal therefore has to live in the application, and it does:
     * dispatchOfflineWrite compares item.orgId with ctx.org.id and returns
     * `rejected: org_mismatch` without writing anything
     * (__tests__/security/offline-write-queue.test.ts). This test pins the reason
     * that check may never be removed.
     */
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const rehomed = await insertEntry(as, {
      orgId: orgB, // authored for A; nothing in the DB objects
      clientKey: key,
      createdBy: member.id,
    });
    expect(rehomed.error, rehomed.error?.message).toBeNull();
    expect(await countByKey(orgB, key)).toBe(1);
  });

  it("NULL keys never collide (the index is partial) — pre-existing rows are unaffected", async () => {
    const as = userClient(member.token);
    for (let i = 0; i < 3; i++) {
      const r = await insertEntry(as, {
        orgId: orgA,
        clientKey: null,
        createdBy: member.id,
        summary: `legacy online entry ${i}`,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
    const nulls = await svc()
      .from("site_diary_entries")
      .select("id")
      .eq("org_id", orgA)
      .is("client_write_key", null);
    expect((nulls.data ?? []).length).toBeGreaterThanOrEqual(3);
  });

  // ── the offline path is not an authorization bypass ────────────────────────
  it("a queued write does NOT bypass RLS: a non-member is still refused", async () => {
    const key = crypto.randomUUID();
    const r = await insertEntry(userClient(outsider.token), {
      orgId: orgA,
      clientKey: key, // carrying an idempotency key grants nothing
      createdBy: outsider.id,
    });
    expect(r.error, "RLS must refuse a non-member insert").not.toBeNull();
    expect(await countByKey(orgA, key)).toBe(0);
  });

  it("anon is still refused, key or no key", async () => {
    const key = crypto.randomUUID();
    const r = await insertEntry(anonClient(), { orgId: orgA, clientKey: key });
    expect(r.error).not.toBeNull();
    expect(await countByKey(orgA, key)).toBe(0);
  });

  it("a queued write cannot reference a job from another org (the shared-core guard's target)", async () => {
    // The DB has no cross-org guard on site_diary_entries.job_id (documented in
    // app/(app)/diary/_data.ts), so this insert SUCCEEDS at the database layer —
    // exactly why createDiaryEntryRecord validates job_id against the active org
    // before inserting, for the online form and the queued replay alike.
    const job = await svc()
      .from("jobs")
      .insert({ org_id: orgB, status: "in-progress" })
      .select("id")
      .single();
    expect(job.error, job.error?.message).toBeNull();
    const key = crypto.randomUUID();
    const r = await insertEntry(userClient(member.token), {
      orgId: orgA,
      clientKey: key,
      createdBy: member.id,
      jobId: String(job.data?.id),
    });
    expect(r.error, r.error?.message).toBeNull(); // the DB permits it
    expect(await countByKey(orgA, key)).toBe(1);
  });

  it("offline_authored_at round-trips as device-clock provenance", async () => {
    const key = crypto.randomUUID();
    const authored = "2026-07-30T16:02:00.000Z";
    await insertEntry(userClient(member.token), {
      orgId: orgA,
      clientKey: key,
      createdBy: member.id,
      offlineAuthoredAt: authored,
    });
    const row = await svc()
      .from("site_diary_entries")
      .select("offline_authored_at, created_at")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    const got = (row.data ?? [])[0];
    expect(new Date(String(got?.offline_authored_at)).toISOString()).toBe(authored);
    // created_at is the SERVER's sync time and is a different thing entirely.
    expect(got?.created_at).not.toBe(got?.offline_authored_at);
  });

  // ── teardown safety (the 20261052 lesson) ─────────────────────────────────
  it("org teardown still cascades with the new column + index in place", async () => {
    const doomed = await mkOrg("doomed");
    const m = await svc()
      .from("memberships")
      .insert({ org_id: doomed, user_id: member.id, role: "staff" });
    expect(m.error, m.error?.message).toBeNull();
    for (let i = 0; i < 3; i++) {
      const r = await insertEntry(userClient(member.token), {
        orgId: doomed,
        clientKey: crypto.randomUUID(),
        createdBy: member.id,
        offlineAuthoredAt: "2026-07-30T16:02:00.000Z",
      });
      expect(r.error, r.error?.message).toBeNull();
    }
    // A migration that added a referencing object with RESTRICT would break here.
    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();
    const left = await svc()
      .from("site_diary_entries")
      .select("id")
      .eq("org_id", doomed);
    expect(left.data ?? []).toHaveLength(0);
    // and the survivor org is untouched
    const survivors = await svc()
      .from("site_diary_entries")
      .select("id")
      .eq("org_id", orgA);
    expect((survivors.data ?? []).length).toBeGreaterThan(0);
  });
});
