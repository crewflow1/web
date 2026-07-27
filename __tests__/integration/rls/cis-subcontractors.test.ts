import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * H2-CIS M1 — `cis_subcontractors` isolation + integrity, against real Postgres.
 *
 * This table holds UTRs (tax identifiers), so its RLS is deliberately STRICTER
 * than the operational-table norm: a single admin-only `for all` policy, the
 * staff_secrets shape. That means a plain member of the SAME org must see and
 * write nothing — which is the main thing this file proves, because it is the
 * property most easily broken by someone "fixing" the policy to match the
 * member-read/admin-write pattern used elsewhere.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row): Ins;
  update(v: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
type Client = { from(t: string): Table };
const db = (c: unknown) => c as unknown as Client;

const T = `it-cis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H2-CIS cis_subcontractors (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let supplierA = "";
  let supplierB = "";
  let admin = { id: "", token: "" };
  let member = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  const svc = () => db(serviceClient());
  const asAdmin = () => db(userClient(admin.token));
  const asMember = () => db(userClient(member.token));
  const asAdminB = () => db(userClient(adminB.token));

  async function mkMember(orgId: string, role: string, tag: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "CIS A", slug: `${T}-a` }).select("id").single())
        .data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "CIS B", slug: `${T}-b` }).select("id").single())
        .data?.id,
    );
    supplierA = String(
      (await svc().from("suppliers").insert({ org_id: orgA, name: `${T} Groundworks` }).select("id").single())
        .data?.id,
    );
    supplierB = String(
      (await svc().from("suppliers").insert({ org_id: orgB, name: `${T} Roofing` }).select("id").single())
        .data?.id,
    );

    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB]) {
      if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
    }
  });

  // -------------------------------------------------------------------------
  // Positive control — the admin path works, so the denials below mean something
  // -------------------------------------------------------------------------

  it("an org ADMIN can create and read a CIS profile", async () => {
    const ins = await asAdmin()
      .from("cis_subcontractors")
      .insert({
        org_id: orgA,
        supplier_id: supplierA,
        legal_name: "D J Smith Ltd",
        utr: "1234567890",
      })
      .select("supplier_id, cis_status, deduction_rate")
      .maybeSingle();
    expect(ins.error, ins.error?.message).toBeNull();
    expect(ins.data?.cis_status, "a new profile is born unverified").toBe("unverified");
    expect(ins.data?.deduction_rate, "an unverified profile has NO rate").toBeNull();

    const sel = await asAdmin()
      .from("cis_subcontractors")
      .select("supplier_id, utr")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(sel.error, sel.error?.message).toBeNull();
    expect(sel.data?.utr).toBe("1234567890");
  });

  // -------------------------------------------------------------------------
  // RLS — same-org NON-ADMIN
  // -------------------------------------------------------------------------

  it("a NON-ADMIN member of the SAME org cannot READ the profile (no rows, no UTR)", async () => {
    const sel = await asMember().from("cis_subcontractors").select("supplier_id, utr").eq("org_id", orgA);
    // RLS filters rather than errors: the proof is an EMPTY set.
    expect(sel.error).toBeNull();
    expect((sel.data ?? []).length, "a staff member must see zero CIS rows").toBe(0);
  });

  it("a NON-ADMIN member of the SAME org cannot INSERT a profile", async () => {
    const ins = await asMember().from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: supplierB,
      legal_name: "Sneaky Ltd",
    });
    expect(ins.error, "staff must be RLS-denied CIS creation").not.toBeNull();
  });

  it("a NON-ADMIN member of the SAME org cannot UPDATE a profile", async () => {
    const upd = await asMember()
      .from("cis_subcontractors")
      .update({ legal_name: "Tampered" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    // An update the policy hides matches zero rows — assert the row is unchanged.
    const after = await svc()
      .from("cis_subcontractors")
      .select("legal_name")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.legal_name, "a staff update must not land").toBe("D J Smith Ltd");
    // Either an explicit denial or a silent no-op is acceptable; a success is not.
    if (!upd.error) expect(after.data?.legal_name).not.toBe("Tampered");
  });

  it("a NON-ADMIN member of the SAME org cannot DELETE a profile", async () => {
    await asMember().from("cis_subcontractors").delete().eq("supplier_id", supplierA);
    const after = await svc()
      .from("cis_subcontractors")
      .select("supplier_id")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data, "a staff delete must not land").not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // RLS — other tenant and anon
  // -------------------------------------------------------------------------

  it("an ADMIN of ANOTHER org sees nothing", async () => {
    const sel = await asAdminB().from("cis_subcontractors").select("supplier_id, utr").eq("org_id", orgA);
    expect(sel.error).toBeNull();
    expect((sel.data ?? []).length, "cross-tenant read must return zero rows").toBe(0);

    const all = await asAdminB().from("cis_subcontractors").select("supplier_id, utr");
    const leaked = (all.data ?? []).some((r) => r.supplier_id === supplierA);
    expect(leaked, "an unfiltered read must not leak another tenant's row").toBe(false);
  });

  it("an ANONYMOUS caller sees nothing", async () => {
    const sel = await db(anonClient()).from("cis_subcontractors").select("supplier_id, utr");
    expect((sel.data ?? []).length, "anon must see zero CIS rows").toBe(0);
  });

  it("an ANONYMOUS caller cannot insert", async () => {
    const ins = await db(anonClient()).from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: supplierB,
      legal_name: "Anon Ltd",
    });
    expect(ins.error, "anon must be RLS-denied").not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Integrity — UTR format
  // -------------------------------------------------------------------------

  it("the UTR CHECK rejects a 9-digit value", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ utr: "123456789" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "", "a short UTR must be refused").toMatch(/utr|check|constraint/i);
  });

  it("the UTR CHECK rejects a value containing letters", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ utr: "12345678AB" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "", "a non-numeric UTR must be refused").toMatch(
      /utr|check|constraint/i,
    );
  });

  it("the UTR CHECK rejects an 11-digit value", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ utr: "12345678901" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "").toMatch(/utr|check|constraint/i);
  });

  // -------------------------------------------------------------------------
  // Integrity — status/rate consistency
  // -------------------------------------------------------------------------

  it("a FORGED rate that contradicts the status is REJECTED", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "higher_30", deduction_rate: 5, verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "", "30% status with a 5% rate must be refused").toMatch(
      /rate_matches_status|check|constraint/i,
    );
  });

  it("filing a 30% result as a 20% deduction is REJECTED", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "higher_30", deduction_rate: 20, verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "").toMatch(/rate_matches_status|check|constraint/i);
  });

  it("the rate is DERIVED when the status is set without one", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "standard_20", verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await asAdmin()
      .from("cis_subcontractors")
      .select("cis_status, deduction_rate")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.cis_status).toBe("standard_20");
    expect(Number(after.data?.deduction_rate), "20% must be derived from the status").toBe(20);
  });

  it("a rate cannot be edited away from its status afterwards", async () => {
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ deduction_rate: 0 })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error?.message ?? "", "zeroing a 20% rate must be refused").toMatch(
      /rate_matches_status|check|constraint/i,
    );
  });

  it("a pre-outcome status cannot END UP carrying a rate", async () => {
    // Supplying a rate equal to the row's CURRENT rate is indistinguishable from
    // not supplying one (Postgres gives a BEFORE trigger the same NEW either
    // way), so this is corrected rather than refused. The invariant under test is
    // the one that matters: what is STORED is always consistent with the status.
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "verification_required", deduction_rate: 20 })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await asAdmin()
      .from("cis_subcontractors")
      .select("cis_status, deduction_rate")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.cis_status).toBe("verification_required");
    expect(after.data?.deduction_rate, "a pre-outcome status must store NO rate").toBeNull();
  });

  it("a 30% result filed at the old 20% rate STORES 30 — it never rounds down", async () => {
    // The compliance-critical direction of the ambiguous case above: when the
    // supplied rate coincides with the previous one the status still wins, and
    // it wins upward. Under-deducting is the failure HMRC penalises.
    await svc()
      .from("cis_subcontractors")
      .update({ cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);

    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "higher_30", deduction_rate: 20, verified_at: "2026-07-03" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await asAdmin()
      .from("cis_subcontractors")
      .select("cis_status, deduction_rate")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.cis_status).toBe("higher_30");
    expect(Number(after.data?.deduction_rate), "must store 30, never the supplied 20").toBe(30);
  });

  it("an HMRC no-match ('failed') carries the HIGHER rate, never the standard one", async () => {
    // Reset to a known starting state so this does not depend on test order.
    await svc()
      .from("cis_subcontractors")
      .update({ cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);

    // The path the app actually takes: the service derives the rate and sends it
    // explicitly, so the pair is already correct when it reaches the CHECK.
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "failed", deduction_rate: 30, verified_at: "2026-07-02" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await asAdmin()
      .from("cis_subcontractors")
      .select("cis_status, deduction_rate")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.cis_status).toBe("failed");
    expect(Number(after.data?.deduction_rate)).toBe(30);
  });

  it("setting a status WITHOUT mentioning the rate re-derives it (PATCH-safe)", async () => {
    await svc()
      .from("cis_subcontractors")
      .update({ cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-07-01" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);

    // A direct PostgREST PATCH of cis_status alone must not leave a stale 20%
    // under a gross status.
    const upd = await asAdmin()
      .from("cis_subcontractors")
      .update({ cis_status: "gross" })
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await asAdmin()
      .from("cis_subcontractors")
      .select("cis_status, deduction_rate")
      .eq("org_id", orgA)
      .eq("supplier_id", supplierA)
      .maybeSingle();
    expect(after.data?.cis_status).toBe("gross");
    expect(Number(after.data?.deduction_rate), "gross must deduct nothing").toBe(0);
  });

  // -------------------------------------------------------------------------
  // Integrity — cross-tenant supplier binding
  // -------------------------------------------------------------------------

  it("a profile cannot bind to a supplier in ANOTHER org (composite FK)", async () => {
    const ins = await asAdmin().from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: supplierB, // belongs to orgB
      legal_name: "Cross Tenant Ltd",
    });
    expect(ins.error?.message ?? "", "a forged supplier_id must be refused").toMatch(
      /foreign key|supplier_fk|violates/i,
    );
  });

  it("even service_role cannot bind a profile across tenants", async () => {
    // The composite FK is not an RLS policy — it binds every role, including the
    // one a compromised server action would run as.
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: supplierB,
      legal_name: "Service Cross Tenant Ltd",
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|supplier_fk|violates/i);
  });

  // -------------------------------------------------------------------------
  // Integrity — outcome must be dated
  // -------------------------------------------------------------------------

  it("an outcome status without a verification date is REJECTED", async () => {
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgB,
      supplier_id: supplierB,
      legal_name: "Undated Ltd",
      cis_status: "standard_20",
    });
    expect(ins.error?.message ?? "", "an undated 'verified' claim must be refused").toMatch(
      /outcome_dated|check|constraint/i,
    );
  });

  it("an 'unverified' profile cannot claim a verification date", async () => {
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgB,
      supplier_id: supplierB,
      legal_name: "Contradictory Ltd",
      cis_status: "unverified",
      verified_at: "2026-07-01",
    });
    expect(ins.error?.message ?? "").toMatch(/outcome_dated|check|constraint/i);
  });

  // -------------------------------------------------------------------------
  // Lifecycle — supplier delete cascades the profile away
  // -------------------------------------------------------------------------

  it("deleting the supplier removes its CIS profile (no orphaned UTR)", async () => {
    const supplierC = String(
      (await svc().from("suppliers").insert({ org_id: orgA, name: `${T} Temp` }).select("id").single())
        .data?.id,
    );
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: supplierC,
      legal_name: "Temp Ltd",
      utr: "9876543210",
    });
    expect(ins.error, ins.error?.message).toBeNull();

    await svc().from("suppliers").delete().eq("id", supplierC);

    const after = await svc()
      .from("cis_subcontractors")
      .select("supplier_id")
      .eq("supplier_id", supplierC);
    expect((after.data ?? []).length, "the UTR must not outlive its supplier").toBe(0);
  });
});
