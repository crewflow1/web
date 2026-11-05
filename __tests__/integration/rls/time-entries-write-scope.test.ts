import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Clock-in / timesheet WRITE boundary (time_entries) against real Postgres.
 *
 * SELECT self-scoping is already covered by workforce-self-scope.test.ts
 * (migration 20261251000000). This file covers the WRITE side of the same
 * table (policies from 20260525000000_field_operations), which had no
 * dedicated regression test:
 *
 *   INSERT — "own or admin": a worker may clock IN only as themselves; an
 *            owner/admin may clock a worker in; a worker CANNOT forge an
 *            entry under another worker's user_id; cross-tenant + anon denied.
 *   UPDATE — "own or admin" AND payroll_line_id is null: a worker edits their
 *            own open entry (e.g. clock out), but once an entry is attached to
 *            a payroll line it is FROZEN — nobody (not even an admin) may
 *            mutate it through the API. A worker cannot edit another worker's
 *            entry.
 *   DELETE — admin-only AND payroll_line_id is null: a worker cannot delete a
 *            timesheet; an admin can delete an un-run one but NOT a
 *            payroll-locked one.
 *
 * These are money-adjacent integrity rules: a falsified or post-payroll-edited
 * timesheet is a pay-fraud / double-pay vector, so they are asserted end to end
 * with real JWTs, not just read behaviour.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  in(c: string, v: unknown[]): Sel;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
}
interface Del extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Del;
}
interface Ins extends PromiseLike<Res<null>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const svc = () => db(serviceClient());
const TOKEN = `tew-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let orgA = "", orgB = "", jobA = "";
const tok: Record<string, string> = {};
const uid: Record<string, string> = {};

async function mkUser(s: string): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${s}@example.test`;
  const password = `Pw-${TOKEN}-${s}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  const id = created.data.user?.id ?? "";
  await svc().from("users").insert({ id, email, full_name: `TE ${s}` });
  const token = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`mint ${s}`);
  return { id, token };
}
const insId = async (table: string, r: Row): Promise<string> =>
  String((await svc().from(table).insert(r).select("id").single()).data?.id ?? "");

/**
 * A CLOSED time entry (started_at + ended_at set) at a unique instant. The
 * table has a partial unique index `one open per user` (user_id where
 * ended_at is null), so every seeded entry that is not deliberately an open
 * clock-in must be closed, or a second seed for the same worker collides.
 */
let seq = 0;
function closed(extra: Row): Row {
  seq += 1;
  const start = new Date(Date.UTC(2026, 0, 1, 0, seq, 0)).toISOString();
  const end = new Date(Date.UTC(2026, 0, 1, 1, seq, 0)).toISOString();
  return { started_at: start, ended_at: end, ...extra };
}

describeIntegration("rls · time_entries write scope (clock-in boundary)", () => {
  beforeAll(async () => {
    orgA = await insId("organizations", { name: `TE A ${TOKEN}`, slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: `TE B ${TOKEN}`, slug: `${TOKEN}-b` });
    for (const who of ["owner", "staffA", "staffB", "otherOrg"]) {
      const u = await mkUser(who);
      uid[who] = u.id; tok[who] = u.token;
    }
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.owner, role: "owner" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffA, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgA, user_id: uid.staffB, role: "staff" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: uid.otherOrg, role: "staff" });
    jobA = await insId("jobs", { org_id: orgA, status: "new" });
  });

  it("INSERT: a worker clocks in as themselves (own entry allowed + persisted)", async () => {
    const r = await db(userClient(tok.staffA!))
      .from("time_entries")
      .insert({ org_id: orgA, user_id: uid.staffA, job_id: jobA })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data?.id ?? "");
    expect(id).not.toBe("");
    // Persistence ground-truth via service role.
    const truth = await svc().from("time_entries").select("id").eq("id", id);
    expect((truth.data ?? []).length).toBe(1);
  });

  it("INSERT: a worker CANNOT forge an entry under another worker's user_id", async () => {
    const r = await db(userClient(tok.staffA!))
      .from("time_entries")
      .insert({ org_id: orgA, user_id: uid.staffB, job_id: jobA })
      .select("id")
      .single();
    // RLS with_check denies — PostgREST surfaces an error, no row created.
    expect(r.error, "forging another worker's timesheet must be denied").not.toBeNull();
    const truth = await svc().from("time_entries").select("id").eq("user_id", uid.staffB).eq("org_id", orgA);
    expect((truth.data ?? []).length, "no forged row persisted").toBe(0);
  });

  it("INSERT: an admin/owner may clock a worker in", async () => {
    const r = await db(userClient(tok.owner!))
      .from("time_entries")
      .insert({ org_id: orgA, user_id: uid.staffB, job_id: jobA })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    expect(String(r.data?.id ?? "")).not.toBe("");
  });

  it("INSERT: cross-tenant + anon cannot write into org A", async () => {
    const cross = await db(userClient(tok.otherOrg!))
      .from("time_entries")
      .insert({ org_id: orgA, user_id: uid.otherOrg, job_id: jobA })
      .select("id")
      .single();
    expect(cross.error, "cross-tenant insert denied").not.toBeNull();
    const anon = await db(anonClient())
      .from("time_entries")
      .insert({ org_id: orgA, user_id: uid.staffA })
      .select("id")
      .single();
    expect(anon.error, "anon insert denied").not.toBeNull();
  });

  it("UPDATE: a worker edits their own open entry; cannot edit another worker's", async () => {
    const mine = await insId("time_entries", closed({ org_id: orgA, user_id: uid.staffA }));
    const theirs = await insId("time_entries", closed({ org_id: orgA, user_id: uid.staffB }));

    const ok = await db(userClient(tok.staffA!))
      .from("time_entries")
      .update({ note: "clocked out" })
      .eq("id", mine);
    expect(ok.error, "own edit allowed").toBeNull();
    const mineTruth = await svc().from("time_entries").select("note").eq("id", mine);
    expect(((mineTruth.data ?? [])[0] as Row | undefined)?.note).toBe("clocked out");

    const bad = await db(userClient(tok.staffA!))
      .from("time_entries")
      .update({ note: "tampered" })
      .eq("id", theirs);
    // RLS update matches zero rows (no error, but nothing changed).
    const theirsTruth = await svc().from("time_entries").select("note").eq("id", theirs);
    expect(((theirsTruth.data ?? [])[0] as Row | undefined)?.note ?? null).not.toBe("tampered");
    expect(bad.error ?? null).toBeNull(); // scoped-out, not an error
  });

  it("UPDATE: a payroll-locked entry is FROZEN — even an admin cannot mutate it", async () => {
    // Build a payroll line and lock an entry to it (service role; mirrors the
    // payroll run attaching the timesheet).
    const runId = await insId("payroll_runs", {
      org_id: orgA,
      cycle: "monthly", period_start: "2026-02-01",
      period_end: "2026-02-28",
    });
    const lineId = await insId("payroll_lines", {
      org_id: orgA,
      payroll_run_id: runId,
      user_id: uid.staffA,
    });
    const lockedId = await insId("time_entries", closed({
      org_id: orgA,
      user_id: uid.staffA,
      payroll_line_id: lineId,
    }));

    // Worker (owner of the row) blocked by the `payroll_line_id is null` USING.
    const asWorker = await db(userClient(tok.staffA!))
      .from("time_entries")
      .update({ note: "retro-edit" })
      .eq("id", lockedId);
    // Admin also blocked — the freeze is absolute, not a role gate.
    const asAdmin = await db(userClient(tok.owner!))
      .from("time_entries")
      .update({ note: "admin-retro-edit" })
      .eq("id", lockedId);

    expect(asWorker.error ?? null).toBeNull(); // scoped out, zero rows
    expect(asAdmin.error ?? null).toBeNull();
    const truth = await svc().from("time_entries").select("note").eq("id", lockedId);
    const note = ((truth.data ?? [])[0] as Row | undefined)?.note ?? null;
    expect(note, "locked entry must be unchanged").toBeNull();
  });

  it("DELETE: a worker cannot delete a timesheet; admin can delete an un-run one but not a locked one", async () => {
    const own = await insId("time_entries", closed({ org_id: orgA, user_id: uid.staffA }));
    // Worker delete is denied (admin-only policy) → zero rows removed.
    await db(userClient(tok.staffA!)).from("time_entries").delete().eq("id", own);
    let truth = await svc().from("time_entries").select("id").eq("id", own);
    expect((truth.data ?? []).length, "worker cannot delete own timesheet").toBe(1);

    // Admin deletes the un-run entry.
    await db(userClient(tok.owner!)).from("time_entries").delete().eq("id", own);
    truth = await svc().from("time_entries").select("id").eq("id", own);
    expect((truth.data ?? []).length, "admin deletes un-run entry").toBe(0);

    // Admin CANNOT delete a payroll-locked entry.
    const runId = await insId("payroll_runs", {
      org_id: orgA,
      cycle: "monthly", period_start: "2026-03-01",
      period_end: "2026-03-31",
    });
    const lineId = await insId("payroll_lines", {
      org_id: orgA,
      payroll_run_id: runId,
      user_id: uid.staffA,
    });
    const locked = await insId("time_entries", closed({
      org_id: orgA,
      user_id: uid.staffA,
      payroll_line_id: lineId,
    }));
    await db(userClient(tok.owner!)).from("time_entries").delete().eq("id", locked);
    truth = await svc().from("time_entries").select("id").eq("id", locked);
    expect((truth.data ?? []).length, "admin cannot delete payroll-locked entry").toBe(1);
  });
});
