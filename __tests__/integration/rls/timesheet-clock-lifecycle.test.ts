import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { entryHours, totalBreakMs, isOpen, type TimeEntry, type Break } from "@/lib/time/compute";

/**
 * Timesheet clock lifecycle — real-Postgres coverage for the daily labour-capture
 * surface (launch audit commercial P2: the clock-in/out path was LIVE but had no
 * functional test). This exercises the DB-level invariants the server actions in
 * app/(app)/me/actions.ts rely on, against real Postgres:
 *
 *   - clock-in inserts an OPEN entry;
 *   - the double-clock guard (unique index time_entries_one_open_per_user) REJECTS a
 *     second open entry for the same user — the safety property clockIn's pre-check +
 *     comment ("DB unique index also enforces this") depend on;
 *   - clock-out closes it (and the break accounting + hours compute are correct on the
 *     real row via lib/time/compute); and
 *   - a new entry is allowed once the previous one is closed.
 */

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TAG = `tsclock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

let orgId = "";
let userId = "";

/** Build a full TimeEntry for the pure compute helpers from the real row's fields. */
const te = (p: { started_at: string; ended_at?: string | null; breaks?: Break[] | null }): TimeEntry => ({
  id: "entry",
  user_id: userId,
  job_id: null,
  started_at: p.started_at,
  ended_at: p.ended_at ?? null,
  breaks: p.breaks ?? null,
});

beforeAll(async () => {
  const org = await svc().from("organizations").insert({ name: `TS ${TAG}`, slug: TAG }).select("id").single();
  expect(org.error, org.error?.message).toBeNull();
  orgId = String(org.data.id);
  // public.users.id → auth.users.id, so mint a real auth user first (harness pattern).
  const email = `${TAG}@example.test`;
  const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${TAG}-x9`, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  userId = created.data.user?.id ?? "";
  const u = await svc().from("users").insert({ id: userId, email, full_name: `TS ${TAG}` }).select("id").single();
  expect(u.error, u.error?.message).toBeNull();
  await svc().from("memberships").insert({ org_id: orgId, user_id: userId, role: "staff" });
});

afterAll(async () => {
  if (userId) await svc().from("time_entries").delete().eq("user_id", userId);
  if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  if (userId) await svc().from("users").delete().eq("id", userId);
  if (userId) await serviceClient().auth.admin.deleteUser(userId).catch(() => {});
});

describeIntegration("timesheet clock lifecycle (real Postgres)", () => {
  it("clock-in inserts an OPEN entry", async () => {
    const r = await svc()
      .from("time_entries")
      .insert({ org_id: orgId, user_id: userId })
      .select("id, started_at, ended_at")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data.ended_at).toBeNull();
    expect(isOpen(te({ started_at: r.data.started_at as string }))).toBe(true);
  });

  it("DOUBLE-CLOCK is rejected — a second open entry for the same user violates the unique index", async () => {
    const r = await svc().from("time_entries").insert({ org_id: orgId, user_id: userId }).select("id");
    expect(r.error, "a second OPEN entry must be rejected by time_entries_one_open_per_user").not.toBeNull();
    expect(String(r.error?.code ?? "") + (r.error?.message ?? "")).toMatch(/23505|duplicate|unique/i);
  });

  it("clock-out closes the entry, with a break; hours + break accounting compute correctly", async () => {
    const open = await svc().from("time_entries").select("id, started_at").eq("user_id", userId).is("ended_at", null).single();
    expect(open.error, open.error?.message).toBeNull();
    const started = new Date(Date.now() - 4 * 3600_000).toISOString(); // 4h ago
    const breakStart = new Date(Date.now() - 3 * 3600_000).toISOString();
    const breakEnd = new Date(Date.now() - 2.5 * 3600_000).toISOString(); // 30-min break
    const ended = new Date().toISOString();
    const upd = await svc()
      .from("time_entries")
      .update({ started_at: started, ended_at: ended, breaks: [{ started_at: breakStart, ended_at: breakEnd }] })
      .eq("id", open.data.id)
      .select("started_at, ended_at, breaks")
      .single();
    expect(upd.error, upd.error?.message).toBeNull();
    const entry = te({ started_at: upd.data.started_at as string, ended_at: upd.data.ended_at as string, breaks: upd.data.breaks as Break[] });
    expect(isOpen(entry)).toBe(false);
    // ~30 minutes of break.
    expect(Math.round(totalBreakMs(entry.breaks ?? []) / 60000)).toBe(30);
    // 4h worked minus 0.5h break ≈ 3.5h (allow rounding tolerance).
    expect(entryHours(entry)).toBeGreaterThan(3.4);
    expect(entryHours(entry)).toBeLessThan(3.6);
  });

  it("a new clock-in is allowed once the previous entry is closed", async () => {
    const r = await svc().from("time_entries").insert({ org_id: orgId, user_id: userId }).select("id, ended_at").single();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data.ended_at).toBeNull();
  });
});
