/* eslint-disable @typescript-eslint/no-explicit-any -- catalogue-driven; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import {
  createWorld, destroyWorld, loadSurface, orgColumnOf, pkFilter, publicTables, qs, rawFetch, seedOrgRows, svc,
  type Surface, type SeedResult, type World,
} from "./_fixture";

/**
 * D-17 — who may READ a non-active company, proved over the WHOLE org-scoped catalogue with REAL
 * GoTrue sessions through PostgREST (migration 20261346 §7).
 *
 *   active                 — owner, admin and staff read their own company's rows (positive control)
 *   suspended / cancelled  — the OWNER still reads (read-only: billing, export, recovery);
 *                            an admin and a staff member read NOTHING
 *   pending / rejected     — nobody reads (the app locks them out; onboarding / approval use
 *                            the service role)
 *
 * The only tables a locked-out member can still read are the user's OWN information, listed in
 * OWN_INFORMATION with the reason — never company data.
 */
const OWN_INFORMATION: ReadonlyMap<string, string> = new Map([
  ["organizations", "the member's own company row (name, status) — the lock screen must be able to say why"],
  ["memberships", "the member's own membership row"],
  ["users", "the member's own profile"],
  ["payroll_lines", "a person's OWN pay record (can_read_compensation: target_user = auth.uid()) — own information, kept; reading anyone ELSE's needs an admitted owner/admin"],
]);

describeIntegration("D-17 · members of a non-active company read nothing; only the owner reads (read-only)", () => {
  let w: World | null = null;
  let surface: Surface;
  let seed: SeedResult;

  const setStatus = async (status: string) => {
    const r = await svc().from("organizations").update({ status }).eq("id", w!.A.id);
    if (r.error) throw new Error(`org status: ${r.error.message}`);
  };

  /** Tables (with a planted row) the bearer can read by primary key. */
  async function readable(bearer: string): Promise<string[]> {
    const out: string[] = [];
    for (const rel of publicTables(surface)) {
      const orgCol = orgColumnOf(rel);
      const row = seed.rows.get(rel.name);
      if (!orgCol || !row || !rel.authenticated.includes("SELECT")) continue;
      const filter = pkFilter(rel, row);
      if (!filter) continue;
      const r = await rawFetch(`/rest/v1/${rel.name}?${qs(filter)}`, { bearer });
      if (r.status >= 200 && r.status < 300 && Array.isArray(r.json) && r.json.length > 0) out.push(rel.name);
    }
    return out;
  }

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("d17-members");
    seed = await seedOrgRows(surface, w.A.id, w.A.owner.id, `${w.tag}-a`);
  }, 300_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 300_000);

  let control = 0;

  it("control · while ACTIVE the owner, admin and staff read a healthy share of the seeded catalogue", async () => {
    const world = w!;
    expect(seed.rows.size, "no rows seeded — the checks below would be vacuous").toBeGreaterThan(100);
    const owner = await readable(world.A.owner.token);
    const admin = await readable(world.A.admin.token);
    const staff = await readable(world.A.staff.token);
    control = owner.length;
    expect(owner.length).toBeGreaterThan(80);
    expect(admin.length).toBeGreaterThan(40);
    expect(staff.length).toBeGreaterThan(5);
  }, 300_000);

  for (const status of ["suspended", "cancelled"] as const) {
    it(`${status.toUpperCase()} · admin and staff read nothing of the company's; the owner still reads (read-only)`, async () => {
      const world = w!;
      try {
        await setStatus(status);
        for (const who of ["admin", "staff"] as const) {
          const leaked = (await readable(world.A[who].token)).filter((t) => !OWN_INFORMATION.has(t));
          expect(leaked, `${who} of a ${status} company can still read: ${leaked.join(", ")}`).toEqual([]);
        }
        const ownerReads = (await readable(world.A.owner.token)).filter((t) => !OWN_INFORMATION.has(t));
        expect(ownerReads.length, `owner keeps read-only access while ${status}`).toBeGreaterThan(control * 0.8 - 5);
      } finally {
        await setStatus("active");
      }
    }, 300_000);
  }

  for (const status of ["pending", "rejected"] as const) {
    it(`${status.toUpperCase()} · nobody — owner included — reads the company's data`, async () => {
      const world = w!;
      try {
        await setStatus(status);
        for (const who of ["owner", "admin", "staff"] as const) {
          const leaked = (await readable(world.A[who].token)).filter((t) => !OWN_INFORMATION.has(t));
          expect(leaked, `${who} of a ${status} company can read: ${leaked.join(", ")}`).toEqual([]);
        }
      } finally {
        await setStatus("active");
      }
    }, 300_000);
  }

  it("the member is still told WHY they are locked out: their own company row stays readable", async () => {
    const world = w!;
    try {
      await setStatus("suspended");
      const r = await rawFetch(`/rest/v1/organizations?id=eq.${world.A.id}&select=id,status`, { bearer: world.A.staff.token });
      expect(r.status).toBe(200);
      expect((r.json as any[])[0]?.status).toBe("suspended");
    } finally {
      await setStatus("active");
    }
  });
});
