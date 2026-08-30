import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * H2-CIS G5 — `cis_subcontractors.verification_source`, against real Postgres
 * (migration 20261224000000).
 *
 * The provenance column that separates a manually-typed HMRC outcome from one
 * the (dark) HMRC verification adapter obtained. Proven at the database, where
 * a mock cannot:
 *
 *   • every existing/new row defaults to 'manual' — TRUE for all of history,
 *     since no other way to record a verification has ever existed;
 *   • 'hmrc_api' is accepted alongside a verification write of the exact shape
 *     recordVerification produces (status + derived rate + date + source), so
 *     the rate-authority CHECK and the source CHECK compose;
 *   • any other source value is REFUSED by the named CHECK — the vocabulary is
 *     closed, matching lib/cis/types.ts CIS_VERIFICATION_SOURCES.
 *
 * Writes use the service-role client: RLS on this table is proven separately
 * (integration/rls/cis-subcontractors.test.ts); the subject here is the column
 * contract, which binds every role including service_role.
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

const T = `it-cisvs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H2-CIS G5 verification_source (real Postgres)", () => {
  let orgId = "";
  let supplierId = "";
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    orgId = String(
      (
        await svc()
          .from("organizations")
          .insert({ name: "CIS VS", slug: `${T}-a` })
          .select("id")
          .single()
      ).data?.id,
    );
    supplierId = String(
      (
        await svc()
          .from("suppliers")
          .insert({ org_id: orgId, name: `${T} Brickwork` })
          .select("id")
          .single()
      ).data?.id,
    );
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  it("a new profile defaults verification_source to 'manual'", async () => {
    const ins = await svc()
      .from("cis_subcontractors")
      .insert({
        org_id: orgId,
        supplier_id: supplierId,
        legal_name: "VS Test Ltd",
        utr: "1234567890",
      })
      .select("supplier_id, cis_status, verification_source")
      .maybeSingle();
    expect(ins.error, ins.error?.message).toBeNull();
    expect(ins.data?.verification_source).toBe("manual");
  });

  it("accepts 'hmrc_api' alongside a recordVerification-shaped outcome write", async () => {
    const upd = await svc()
      .from("cis_subcontractors")
      .update({
        cis_status: "standard_20",
        deduction_rate: 20,
        verification_reference: "V1234567890",
        verification_source: "hmrc_api",
        verified_at: "2026-08-29",
        verification_expires_at: "2029-04-05",
      })
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId);
    expect(upd.error, upd.error?.message).toBeNull();

    const sel = await svc()
      .from("cis_subcontractors")
      .select("verification_source, cis_status, deduction_rate")
      .eq("org_id", orgId)
      .maybeSingle();
    expect(sel.data?.verification_source).toBe("hmrc_api");
    expect(sel.data?.cis_status).toBe("standard_20");
    expect(Number(sel.data?.deduction_rate)).toBe(20);
  });

  it("REFUSES any source outside the closed vocabulary", async () => {
    const upd = await svc()
      .from("cis_subcontractors")
      .update({ verification_source: "spreadsheet" })
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId);
    expect(upd.error, "an unknown source must be refused by the CHECK").not.toBeNull();
    expect(upd.error?.message ?? "").toMatch(/verification_source_known|check constraint/i);

    // The row is untouched — still the hmrc_api outcome from the previous test.
    const sel = await svc()
      .from("cis_subcontractors")
      .select("verification_source")
      .eq("org_id", orgId)
      .maybeSingle();
    expect(sel.data?.verification_source).toBe("hmrc_api");
  });
});
