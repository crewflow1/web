import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * OFFLINE WRITE EXPANSION (Train 5) — the database-level guarantees for the two
 * new verticals, proven against real Postgres (migration 20261083000000).
 * Mirrors __tests__/integration/rls/offline-write-idempotency.test.ts (the
 * diary proof); read that file's header for why these are demonstrated on the
 * AUTHENTICATED user client rather than the privileged one.
 *
 * What is new here beyond the diary's shape:
 *   - material requests are a TWO-statement create (header + lines), so the
 *     proof covers the stranded-header recovery and the concurrent-recovery
 *     race that (material_request_id, sort_order) exists to close;
 *   - a same-key header replay is refused even though the NUMBER differs —
 *     the key identifies the write, not its allocated number.
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

const TOKEN = `it-offx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("offline write expansion · DB idempotency (20261083)", () => {
  const svc = () => db(serviceClient());
  let orgA = "";
  let orgB = "";
  /** A genuinely MULTI-ORG member — the shape the app-level org pin exists for. */
  let member = { id: "", token: "" };
  /** Authenticated, but a member of neither org. */
  let outsider = { id: "", token: "" };

  const mkOrg = async (label: string) => {
    const r = await svc()
      .from("organizations")
      .insert({ name: `Offline Expansion ${label}`, slug: `${TOKEN}-${label}` })
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
    await svc().from("users").insert({ id, email });
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!token) throw new Error(`failed to mint a token for ${label}`);
    return { id, token };
  };

  /** One snag insert, exactly as createSnagRecord builds it. */
  const insertSnag = (
    client: unknown,
    args: {
      orgId: string;
      clientKey: string | null;
      reportedBy?: string | null;
      title?: string;
      offlineAuthoredAt?: string | null;
    },
  ) =>
    db(client)
      .from("snags")
      .insert({
        org_id: args.orgId,
        title: args.title ?? "Cracked tile in the ensuite",
        priority: "medium",
        status: "open",
        reported_by: args.reportedBy ?? null,
        client_write_key: args.clientKey,
        offline_authored_at: args.offlineAuthoredAt ?? null,
      });

  /** One request header, exactly as createMaterialRequestDraftRecord builds it. */
  const insertHeader = (
    client: unknown,
    args: {
      orgId: string;
      clientKey: string | null;
      number: string;
      requestedBy?: string | null;
      offlineAuthoredAt?: string | null;
    },
  ) =>
    db(client)
      .from("material_requests")
      .insert({
        org_id: args.orgId,
        number: args.number,
        status: "draft",
        priority: "normal",
        requested_by: args.requestedBy ?? null,
        created_by: args.requestedBy ?? null,
        client_write_key: args.clientKey,
        offline_authored_at: args.offlineAuthoredAt ?? null,
      })
      .select("id")
      .single();

  const insertLines = (client: unknown, orgId: string, requestId: string) =>
    db(client)
      .from("material_request_lines")
      .insert(
        [
          { description: "Cement 25kg", qty: 20, unit: "bag" },
          { description: "Sharp sand", qty: 2, unit: "t" },
        ].map((l, idx) => ({
          org_id: orgId,
          material_request_id: requestId,
          ...l,
          sort_order: idx,
        })),
      );

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

  // ── snags: the diary's guarantee, verbatim ─────────────────────────────────
  it("SNAGS: replaying the same queued item twice yields exactly ONE row", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertSnag(as, {
      orgId: orgA,
      clientKey: key,
      reportedBy: member.id,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(first.error, first.error?.message).toBeNull();

    const replay = await insertSnag(as, {
      orgId: orgA,
      clientKey: key,
      reportedBy: member.id,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(replay.error, "the replay must be REFUSED by the database").not.toBeNull();
    expect(replay.error?.code, "unique violation").toBe("23505");
    expect(await countByKey("snags", orgA, key)).toBe(1);
  });

  it("SNAGS: stays ONE row across mutated retries; the FIRST write survives", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertSnag(as, {
      orgId: orgA,
      clientKey: key,
      reportedBy: member.id,
      title: "original words",
    });
    expect(first.error, first.error?.message).toBeNull();
    for (let i = 0; i < 3; i++) {
      const r = await insertSnag(as, {
        orgId: orgA,
        clientKey: key,
        reportedBy: member.id,
        title: `mutated retry ${i}`,
      });
      expect(r.error?.code, `retry ${i}`).toBe("23505");
    }
    const row = await svc()
      .from("snags")
      .select("title")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    expect((row.data ?? [])[0]?.title).toBe("original words");
  });

  it("SNAGS: the index is ORG-SCOPED; NULL keys never collide (pre-existing rows unaffected)", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const a = await insertSnag(as, { orgId: orgA, clientKey: key, reportedBy: member.id });
    expect(a.error, a.error?.message).toBeNull();
    const b = await insertSnag(as, { orgId: orgB, clientKey: key, reportedBy: member.id });
    expect(b.error, b.error?.message).toBeNull();
    expect(await countByKey("snags", orgA, key)).toBe(1);
    expect(await countByKey("snags", orgB, key)).toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await insertSnag(as, {
        orgId: orgA,
        clientKey: null,
        reportedBy: member.id,
        title: `legacy online snag ${i}`,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
  });

  it("SNAGS: the DB alone does not prevent RE-HOMING — which is why the app pins the org", async () => {
    // Same deliberately uncomfortable proof as the diary's: a multi-org JWT
    // satisfies RLS for both orgs and the index is per-org, so only
    // dispatchOfflineWrite's org_mismatch refusal keeps a queued snag out of
    // the wrong company. This pins the reason that check may never be removed.
    const key = crypto.randomUUID();
    const rehomed = await insertSnag(userClient(member.token), {
      orgId: orgB, // authored for A; nothing in the DB objects
      clientKey: key,
      reportedBy: member.id,
    });
    expect(rehomed.error, rehomed.error?.message).toBeNull();
    expect(await countByKey("snags", orgB, key)).toBe(1);
  });

  it("SNAGS: a queued write does NOT bypass RLS — non-member and anon are refused", async () => {
    const key = crypto.randomUUID();
    const r = await insertSnag(userClient(outsider.token), {
      orgId: orgA,
      clientKey: key,
      reportedBy: outsider.id,
    });
    expect(r.error, "RLS must refuse a non-member insert").not.toBeNull();
    const a = await insertSnag(anonClient(), { orgId: orgA, clientKey: key });
    expect(a.error).not.toBeNull();
    expect(await countByKey("snags", orgA, key)).toBe(0);
  });

  // ── material requests: header idempotency + line recovery ─────────────────
  it("REQUESTS: a same-key header replay is refused even with a DIFFERENT number", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const first = await insertHeader(as, {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-1a`,
      requestedBy: member.id,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(first.error, first.error?.message).toBeNull();

    // The replay allocates a fresh number (numbers are minted at sync time) —
    // the KEY, not the number, identifies the write.
    const replay = await insertHeader(as, {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-1b`,
      requestedBy: member.id,
    });
    expect(replay.error, "the replay must be REFUSED").not.toBeNull();
    expect(replay.error?.code).toBe("23505");
    expect(await countByKey("material_requests", orgA, key)).toBe(1);
  });

  it("REQUESTS: stranded-header recovery — lines land once; a concurrent recovery is refused", async () => {
    const as = userClient(member.token);
    const key = crypto.randomUUID();
    // The stranded state: a header whose line insert never happened.
    const header = await insertHeader(as, {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-2`,
      requestedBy: member.id,
    });
    expect(header.error, header.error?.message).toBeNull();
    const requestId = String(header.data?.id ?? "");

    // Recovery inserts the lines...
    const recovery = await insertLines(as, orgA, requestId);
    expect(recovery.error, recovery.error?.message).toBeNull();

    // ...and the RACING second recovery (two tabs both saw "zero lines") is
    // refused by (material_request_id, sort_order) instead of doubling the ask.
    const race = await insertLines(as, orgA, requestId);
    expect(race.error, "the second recovery must be REFUSED").not.toBeNull();
    expect(race.error?.code).toBe("23505");

    const lines = await svc()
      .from("material_request_lines")
      .select("id")
      .eq("org_id", orgA)
      .eq("material_request_id", requestId);
    expect((lines.data ?? []).length).toBe(2); // once, not twice
  });

  it("REQUESTS: the header key index is ORG-SCOPED and partial, like every sibling", async () => {
    const key = crypto.randomUUID();
    const as = userClient(member.token);
    const a = await insertHeader(as, {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-3a`,
      requestedBy: member.id,
    });
    expect(a.error, a.error?.message).toBeNull();
    const b = await insertHeader(as, {
      orgId: orgB,
      clientKey: key,
      number: `MR-${TOKEN}-3b`,
      requestedBy: member.id,
    });
    expect(b.error, b.error?.message).toBeNull();
    // NULL keys still never collide — the online history is untouched.
    for (let i = 0; i < 2; i++) {
      const r = await insertHeader(as, {
        orgId: orgA,
        clientKey: null,
        number: `MR-${TOKEN}-3n${i}`,
        requestedBy: member.id,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
  });

  it("REQUESTS: a queued write does NOT bypass RLS — non-member and anon are refused", async () => {
    // The diary proof, on the two-statement entity: carrying an idempotency key
    // grants nothing. A non-member cannot land a header, and without a header
    // there is nothing for a line recovery to attach to either.
    const key = crypto.randomUUID();
    const r = await insertHeader(userClient(outsider.token), {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-rls`,
      requestedBy: outsider.id,
    });
    expect(r.error, "RLS must refuse a non-member header insert").not.toBeNull();
    const a = await insertHeader(anonClient(), {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-rls-anon`,
    });
    expect(a.error).not.toBeNull();
    expect(await countByKey("material_requests", orgA, key)).toBe(0);
  });

  it("REQUESTS: offline_authored_at round-trips as display-only provenance", async () => {
    const key = crypto.randomUUID();
    const authored = "2026-07-31T16:02:00.000Z";
    const r = await insertHeader(userClient(member.token), {
      orgId: orgA,
      clientKey: key,
      number: `MR-${TOKEN}-4`,
      requestedBy: member.id,
      offlineAuthoredAt: authored,
    });
    expect(r.error, r.error?.message).toBeNull();
    const row = await svc()
      .from("material_requests")
      .select("offline_authored_at, created_at, status, submitted_at")
      .eq("org_id", orgA)
      .eq("client_write_key", key);
    const got = (row.data ?? [])[0];
    expect(new Date(String(got?.offline_authored_at)).toISOString()).toBe(authored);
    expect(got?.created_at).not.toBe(got?.offline_authored_at);
    // and the replayed create carried NO lifecycle progress with it
    expect(got?.status).toBe("draft");
    expect(got?.submitted_at).toBeNull();
  });

  // ── teardown safety (the 20261052 lesson) ──────────────────────────────────
  it("org teardown still cascades with the new columns + indexes in place", async () => {
    const doomed = await mkOrg("doomed");
    const m = await svc()
      .from("memberships")
      .insert({ org_id: doomed, user_id: member.id, role: "staff" });
    expect(m.error, m.error?.message).toBeNull();
    const as = userClient(member.token);

    const snag = await insertSnag(as, {
      orgId: doomed,
      clientKey: crypto.randomUUID(),
      reportedBy: member.id,
    });
    expect(snag.error, snag.error?.message).toBeNull();
    const header = await insertHeader(as, {
      orgId: doomed,
      clientKey: crypto.randomUUID(),
      number: `MR-${TOKEN}-doom`,
      requestedBy: member.id,
    });
    expect(header.error, header.error?.message).toBeNull();
    const lines = await insertLines(as, doomed, String(header.data?.id ?? ""));
    expect(lines.error, lines.error?.message).toBeNull();

    // A migration that added a referencing object with RESTRICT would break here.
    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();
    for (const table of ["snags", "material_requests", "material_request_lines"]) {
      const left = await svc().from(table).select("id").eq("org_id", doomed);
      expect(left.data ?? [], table).toHaveLength(0);
    }
  });
});
