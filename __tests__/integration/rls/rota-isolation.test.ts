import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  listRotaJobOptions,
  listUserShiftsOnDay,
  listWeekRotaEntries,
  type RotaClient,
} from "@/server/services/rota";

/**
 * Staff rota — active-org pinning against REAL Postgres.
 *
 * Same class as #456 and job-site-hub: `current_org_ids()` returns EVERY org
 * the viewer belongs to, so an RLS-only read blends orgs for a dual-org
 * member. The probe user is a member of org A AND org B, with rota entries in
 * BOTH orgs in the SAME week, so each unpinned read fails this suite:
 *
 *   1. the weekly rota grid would render org B's shifts inside org A's grid;
 *   2. the job picker would list org B's jobs (and customer names);
 *   3. the createRotaEntry overlap window would refuse a legitimate org A
 *      shift because of a clash that exists only in org B.
 *
 * The page and the action call these exact functions, so deleting a pin in
 * server/services/rota.ts goes red here — not just in review.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(c: string, v: unknown): PromiseLike<Res<null>>;
}
interface Table {
  insert(r: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-rota-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// One fixed week, entries well inside it so the window bounds are not load-bearing.
const WEEK_START_ISO = "2026-03-02T00:00:00Z"; // a Monday
const WEEK_END_ISO = "2026-03-08T23:59:59Z";
const DAY = "2026-03-04"; // the Wednesday both orgs schedule the dual user

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

describeIntegration("staff rota · active-org pinning (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  /** Member of BOTH orgs — the blend probe, and the person on both rotas. */
  let dual = { id: "", token: "" };
  /** Member of org B only. */
  let outsider = { id: "", token: "" };

  let entryA = ""; // dual's org A shift (09:00–12:00 on DAY)
  let entryB = ""; // dual's org B shift (10:00–17:00 on DAY — overlaps entryA's window)

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Rota A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Rota B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    jobA = await insId(svc, "jobs", { org_id: orgA, status: "in-progress" });
    jobB = await insId(svc, "jobs", { org_id: orgB, status: "in-progress" });

    entryA = await insId(svc, "rota_entries", {
      org_id: orgA,
      user_id: dual.id,
      job_id: jobA,
      starts_at: `${DAY}T09:00:00Z`,
      ends_at: `${DAY}T12:00:00Z`,
      created_by: dual.id,
    });
    entryB = await insId(svc, "rota_entries", {
      org_id: orgB,
      user_id: dual.id,
      job_id: jobB,
      starts_at: `${DAY}T10:00:00Z`,
      ends_at: `${DAY}T17:00:00Z`,
      created_by: dual.id,
    });
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [dual, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  it("weekly rota read returns ONLY the active org's entries for a dual-org member", async () => {
    const client = userClient(dual.token) as unknown as RotaClient;

    const inA = await listWeekRotaEntries(client, orgA, WEEK_START_ISO, WEEK_END_ISO);
    const idsA = inA.map((e) => e.id);
    expect(idsA).toContain(entryA);
    expect(idsA, "org B's shift rendered inside org A's grid").not.toContain(entryB);

    // And the mirror image — org B's grid shows only org B's entry.
    const inB = await listWeekRotaEntries(client, orgB, WEEK_START_ISO, WEEK_END_ISO);
    const idsB = inB.map((e) => e.id);
    expect(idsB).toContain(entryB);
    expect(idsB, "org A's shift rendered inside org B's grid").not.toContain(entryA);
  });

  it("job picker lists ONLY the active org's jobs for a dual-org member", async () => {
    const client = userClient(dual.token) as unknown as RotaClient;
    const options = await listRotaJobOptions(client, orgA);
    const ids = options.map((o) => o.id);
    expect(ids).toContain(jobA);
    expect(ids, "org B's job offered in org A's assign-shift picker").not.toContain(jobB);
  });

  it("overlap window sees ONLY the active org — a clash in the user's other org cannot block a shift here", async () => {
    const client = userClient(dual.token) as unknown as RotaClient;

    // Org A's window on DAY holds only the 09:00–12:00 org A shift…
    const windowsA = await listUserShiftsOnDay(client, orgA, dual.id, DAY);
    expect(windowsA.map((w) => w.starts_at)).toEqual([`${DAY}T09:00:00+00:00`]);

    // …so a 13:00–15:00 org A shift has no in-org conflict, even though it sits
    // inside the 10:00–17:00 ORG B shift. Replicate createRotaEntry's exact
    // in-process comparison over the window the action now receives.
    const ns = new Date(`${DAY}T13:00:00Z`).getTime();
    const ne = new Date(`${DAY}T15:00:00Z`).getTime();
    const hit = windowsA.find((s) => {
      const a = new Date(s.starts_at).getTime();
      const b = new Date(s.ends_at).getTime();
      return ns < b && a < ne;
    });
    expect(hit, "org B's shift blocked a legitimate org A shift").toBeUndefined();

    // Control: the SAME comparison inside org B does conflict — the check
    // still catches real in-org clashes.
    const windowsB = await listUserShiftsOnDay(client, orgB, dual.id, DAY);
    const hitB = windowsB.find((s) => {
      const a = new Date(s.starts_at).getTime();
      const b = new Date(s.ends_at).getTime();
      return ns < b && a < ne;
    });
    expect(hitB).toBeDefined();
  });

  it("RLS still holds underneath: an org-B-only member sees nothing of org A, anon sees nothing", async () => {
    const outsiderClient = userClient(outsider.token) as unknown as RotaClient;
    // The pin is scoping, not the security boundary — even ASKING for org A
    // returns nothing, because RLS never serves org A's rows to this viewer.
    expect(await listWeekRotaEntries(outsiderClient, orgA, WEEK_START_ISO, WEEK_END_ISO)).toEqual([]);
    expect(await listRotaJobOptions(outsiderClient, orgA)).toEqual([]);
    expect(await listUserShiftsOnDay(outsiderClient, orgA, dual.id, DAY)).toEqual([]);

    const anon = anonClient() as unknown as RotaClient;
    expect(await listWeekRotaEntries(anon, orgA, WEEK_START_ISO, WEEK_END_ISO)).toEqual([]);
  });
});
