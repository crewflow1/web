import { afterAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import {
  cleanup,
  countOrgObjects,
  countRows,
  db,
  mkOrg,
  mkUser,
  newMarkers,
  residue,
  seedMemberFootprint,
  seedOrgBusinessData,
  uploadOrgObjects,
} from "./_fixtures";
import { eraseOrg } from "@/server/services/gdpr-erase";

/**
 * CHARACTERISATION of the PRE-EXISTING org erasure (`eraseOrg` →
 * `public.gdpr_erase_org`, migration 20261169) — what it actually does when it
 * is run against a populated company on real Postgres.
 *
 * These cases pin today's behaviour as EVIDENCE (DELETION-EVIDENCE.md §1); they
 * are not a specification. The path is dark (`FEATURE_GDPR_ERASURE` off) and is
 * superseded by the company-deletion flow. When it is retired or repaired,
 * delete or invert these cases — do not "fix" them by weakening an assertion.
 */

const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

describeIntegration("privacy · baseline: what the existing gdpr_erase_org does", () => {
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("on a company with ordinary data it FAILS, rolls the database back — and has already destroyed the files", async () => {
    const m = newMarkers("base");
    const owner = await mkUser(m, "owner");
    const staff = await mkUser(m, "staff");
    created.users.push(owner.id, staff.id);
    const org = await mkOrg(m, "co", [
      { user: owner, role: "owner" },
      { user: staff, role: "staff" },
    ]);
    created.orgs.push(org.id);
    const seed = await seedOrgBusinessData(org, m); // includes one comm_events row
    await seedMemberFootprint(org, seed, staff, m, { withPayroll: true });
    await uploadOrgObjects(org.id, m);
    expect(await countOrgObjects(org.id)).toBe(4);
    const before = (await residue(m)).length;

    // The append-only comms log refuses the targeted delete; one transaction ⇒
    // everything rolls back.
    await expect(eraseOrg({ orgId: org.id, confirm: org.slug, requestedBy: null })).rejects.toThrow(
      /comm_events is append-only/,
    );

    // Database: byte-for-byte as it was — nothing erased.
    expect(await countRows("customers", { org_id: org.id })).toBe(1);
    expect(await countRows("messages", { org_id: org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: org.id })).toBe(2);
    expect(await countRows("gdpr_erasure_log", { org_id: org.id })).toBe(0);
    // Storage: ALREADY EMPTY. The service removes files before the DB step, so a
    // failed erasure leaves the company with its records but without its files.
    expect(await countOrgObjects(org.id)).toBe(0);
    // Only the storage-path markers are gone; every database marker is still there.
    const after = await residue(m);
    expect(after.length).toBeGreaterThan(before - 4);
    expect(after.filter((r) => r.location.startsWith("storage.")).length).toBe(0);
  }, 120_000);

  it("a single default CIS subcontractor makes the PII scrub violate a CHECK constraint", async () => {
    const m = newMarkers("basecis");
    const owner = await mkUser(m, "owner");
    created.users.push(owner.id);
    const org = await mkOrg(m, "co", [{ user: owner, role: "owner" }]);
    created.orgs.push(org.id);
    const sup = await db().from("suppliers").insert({ org_id: org.id, name: `${m.name} Supplies` }).select("id").single();
    expect(sup.error, sup.error?.message).toBeNull();
    const cis = await db().from("cis_subcontractors").insert({
      org_id: org.id,
      supplier_id: (sup.data as { id: string }).id,
      legal_name: `${m.name} Groundworks`,
    });
    expect(cis.error, cis.error?.message).toBeNull();

    await expect(eraseOrg({ orgId: org.id, confirm: org.slug, requestedBy: null })).rejects.toThrow(
      /cis_subcontractors_outcome_dated/,
    );
    expect(await countRows("cis_subcontractors", { org_id: org.id })).toBe(1);
    expect(await countRows("gdpr_erasure_log", { org_id: org.id })).toBe(0);
  }, 120_000);

  it("where it does complete (a near-empty company) it leaves the org shell, every login and all user-keyed data", async () => {
    const m = newMarkers("basethin");
    const owner = await mkUser(m, "owner");
    created.users.push(owner.id);
    const org = await mkOrg(m, "co", [{ user: owner, role: "owner" }]);
    created.orgs.push(org.id);
    await db().from("customers").insert({ org_id: org.id, name: `${m.name} Customer`, phone: m.phone });
    await db().from("staff_compensation").insert({ user_id: owner.id, emergency_contact: { name: `${m.name} kin`, phone: m.phone } });

    const summary = await eraseOrg({ orgId: org.id, confirm: org.slug, requestedBy: null });
    expect(summary.status).toBe("erased");
    expect(await countRows("customers", { org_id: org.id })).toBe(0);
    expect(await countRows("memberships", { org_id: org.id })).toBe(0);

    // What it MISSES — found by the catalogue-wide marker scan, not by assumption:
    const left = (await residue(m)).map((r) => r.location);
    expect(left).toEqual(
      expect.arrayContaining([
        "public.organizations.name", // the company shell, name / slug / phone / address intact
        "public.organizations.phone",
        "public.users.full_name", // the owner's profile
        "public.users.email",
        "public.users.phone",
        "public.staff_compensation.emergency_contact", // a third party's contact details
        "auth.users.email", // the login itself
      ]),
    );
    expect(await countRows("organizations", { id: org.id })).toBe(1);
  }, 120_000);
});
