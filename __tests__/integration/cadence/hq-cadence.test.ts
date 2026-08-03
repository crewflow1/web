import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * HQ cadence clock (20261108) — the tick against a LIVE Postgres.
 *
 * The security tier pins the source contract; this tier proves the BEHAVIOUR a
 * mock cannot, against a real DB with the migration applied:
 *
 *   • a due, enabled cadence fires ONCE and advances next_run_at + last_run_at;
 *   • three CONCURRENT ticks fire an occurrence exactly once (the optimistic CAS);
 *   • a disabled (dark) cadence never fires;
 *   • RLS:hq denies every JWT client (anon AND authenticated) on both tables —
 *     the tables are HQ-global infrastructure, never tenant-visible;
 *   • a fired occurrence appends an immutable run-log row (UPDATE/DELETE rejected).
 *
 * The tick is driven with an INJECTED counting dispatch, so the claim/advance
 * logic is exercised against real Postgres WITHOUT invoking the heavy real drains
 * (which need AI/network). Routing to the real authorities is pinned in the
 * security tier. The tick reads across ALL enabled cadences, so the suite pauses
 * every seeded cadence in beforeAll and enables exactly the row under test, then
 * restores the dark default in afterAll — the shared local DB is left as found.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  single(): Thenable<Row>;
  maybeSingle(): Thenable<Row>;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
  select(columns?: string): Sel;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): { select(columns?: string): Sel } & Thenable<Row[]>;
  update(values: Row): UpdChain;
  delete(): { eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }> };
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;

function expectDenied(res: Res<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const SEEDED = [
  "research-drain",
  "qualification-drain",
  "outreach-drain",
  "notifications-drain",
  "automation-schedules-drain",
];

let USER_TOKEN = "";
let userId = "";

describeIntegration("HQ cadence clock · deterministic tick + RLS:hq", () => {
  let tickCadences: typeof import("@/server/services/hq-cadence").tickCadences;

  // A counting dispatch over every seeded key — proves the claim path without the
  // real drains. Reset per test via resetCounts().
  const counts: Record<string, number> = {};
  const dispatch: Record<string, () => Promise<Record<string, unknown>>> = {};
  for (const k of SEEDED) {
    dispatch[k] = async () => {
      counts[k] = (counts[k] ?? 0) + 1;
      return { ok: true, counted: k };
    };
  }
  const resetCounts = () => SEEDED.forEach((k) => (counts[k] = 0));

  async function setRow(key: string, patch: Record<string, unknown>): Promise<void> {
    const r = await db(serviceClient()).from("hq_ai_schedules").update(patch).eq("cadence_key", key);
    expect(r.error, r.error?.message).toBeNull();
  }

  async function getRow(key: string): Promise<Row> {
    const r = await db(serviceClient())
      .from("hq_ai_schedules")
      .select("id, cadence_key, enabled, next_run_at, last_run_at")
      .eq("cadence_key", key)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    return r.data ?? {};
  }

  beforeAll(async () => {
    tickCadences = (await import("@/server/services/hq-cadence")).tickCadences;
    // Every seeded cadence dark, next_run_at null — the tick's starting truth.
    for (const k of SEEDED) await setRow(k, { enabled: false, next_run_at: null });

    const svc = serviceClient();
    const email = `it-cadence-${Date.now()}-${alpha(6)}@probe.crewflow.test`;
    const password = `Pw!${alpha(10)}${Date.now()}`;
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    userId = created.data.user?.id ?? "";
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    USER_TOKEN = signedIn.data.session?.access_token ?? "";
    if (!USER_TOKEN) throw new Error("probe user has no access token");
  });

  afterAll(async () => {
    // Restore the dark default so the shared local DB is left exactly as found.
    for (const k of SEEDED) await setRow(k, { enabled: false, next_run_at: null });
    if (userId) await serviceClient().auth.admin.deleteUser(userId);
  });

  it("fires a due, enabled cadence once and advances next_run_at + last_run_at", async () => {
    resetCounts();
    const key = "research-drain";
    const past = new Date(Date.now() - 60_000).toISOString();
    await setRow(key, { enabled: true, next_run_at: past });

    const now = new Date();
    const out = await tickCadences({ now, client: serviceClient() as never, dispatch });
    const mine = out.results.find((r) => r.cadence_key === key);
    expect(mine?.status).toBe("fired");
    expect(counts[key]).toBe(1);

    const after = await getRow(key);
    expect(new Date(String(after.next_run_at)).getTime()).toBeGreaterThan(now.getTime());
    expect(after.last_run_at).toBeTruthy();

    // An immutable run-log row was appended for this occurrence.
    const log = await db(serviceClient())
      .from("hq_ai_schedule_runs")
      .select("id, cadence_key, outcome")
      .eq("schedule_id", String(after.id));
    expect(log.error, log.error?.message).toBeNull();
    expect((log.data ?? []).some((r) => r.outcome === "dispatched")).toBe(true);

    await setRow(key, { enabled: false, next_run_at: null });
  });

  it("three CONCURRENT ticks fire a due occurrence exactly once", async () => {
    resetCounts();
    const key = "outreach-drain";
    const past = new Date(Date.now() - 120_000).toISOString();
    await setRow(key, { enabled: true, next_run_at: past });

    const now = new Date();
    const results = await Promise.all([
      tickCadences({ now, client: serviceClient() as never, dispatch }),
      tickCadences({ now, client: serviceClient() as never, dispatch }),
      tickCadences({ now, client: serviceClient() as never, dispatch }),
    ]);
    const fires = results
      .flatMap((r) => r.results)
      .filter((r) => r.cadence_key === key && r.status === "fired");
    expect(fires).toHaveLength(1);
    expect(counts[key]).toBe(1);

    await setRow(key, { enabled: false, next_run_at: null });
  });

  it("a disabled (dark) cadence never fires", async () => {
    resetCounts();
    const key = "qualification-drain";
    // Dark, but with a PAST next_run_at — the scan must still ignore it.
    await setRow(key, { enabled: false, next_run_at: new Date(Date.now() - 60_000).toISOString() });

    const out = await tickCadences({ now: new Date(), client: serviceClient() as never, dispatch });
    expect(out.results.find((r) => r.cadence_key === key)).toBeUndefined();
    expect(counts[key] ?? 0).toBe(0);

    await setRow(key, { enabled: false, next_run_at: null });
  });

  it("RLS:hq denies every JWT client (anon AND authenticated) on both tables", async () => {
    const row = await getRow("research-drain");
    // service_role (BYPASSRLS) sees the registry…
    expect(row.id).toBeTruthy();
    // …but no JWT client may read either table.
    for (const table of ["hq_ai_schedules", "hq_ai_schedule_runs"]) {
      expectDenied(await db(anonClient()).from(table).select("id"));
      expectDenied(await db(userClient(USER_TOKEN)).from(table).select("id"));
    }
    // A JWT insert is refused too (no policy admits it).
    const anonInsert = await db(anonClient())
      .from("hq_ai_schedules")
      .insert({ cadence_key: `jwt-${alpha(6)}`, cron_expr: "* * * * *" });
    expect(anonInsert.error, "anon insert must be denied").toBeTruthy();
  });

  it("the run-log is append-only — UPDATE and DELETE are rejected under service-role", async () => {
    // Produce a run-log row first.
    const key = "notifications-drain";
    await setRow(key, { enabled: true, next_run_at: new Date(Date.now() - 60_000).toISOString() });
    await tickCadences({ now: new Date(), client: serviceClient() as never, dispatch });
    await setRow(key, { enabled: false, next_run_at: null });

    const row = await getRow(key);
    const log = await db(serviceClient())
      .from("hq_ai_schedule_runs")
      .select("id")
      .eq("schedule_id", String(row.id));
    expect(log.error, log.error?.message).toBeNull();
    const logId = String((log.data ?? [])[0]?.id ?? "");
    expect(logId).toBeTruthy();

    const upd = await db(serviceClient())
      .from("hq_ai_schedule_runs")
      .update({ outcome: "no_dispatch" })
      .eq("id", logId);
    expect(upd.error, "UPDATE must be blocked").toBeTruthy();

    const del = await db(serviceClient()).from("hq_ai_schedule_runs").delete().eq("id", logId);
    expect(del.error, "DELETE must be blocked").toBeTruthy();
  });
});
