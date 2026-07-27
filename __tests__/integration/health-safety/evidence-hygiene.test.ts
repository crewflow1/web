import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Evidence-hygiene hardening (H&S M6, final review F-A/F-B, 20261023). DB-enforced
 * for every caller: a permit's lifecycle timestamps move ONLY on a real status
 * transition (so closed_at — printed on the evidence PDF — can't be back-dated),
 * and org + creation provenance freeze once a RAMS / permit is issued.
 */

type Res = { data: unknown; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res> }
interface Ins extends PromiseLike<Res> { select(c?: string): { single(): PromiseLike<{ data: Row | null; error: unknown }> } }
interface Upd extends PromiseLike<Res> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res> { eq(c: string, v: unknown): Del }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(p: Row): Upd; delete(): Del }
const db = (c: unknown) => c as unknown as { from(t: string): Table };
const TOKEN = `it-hyg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H&S evidence hygiene · timestamps + provenance are frozen", () => {
  let orgA = "", orgB = "";
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "Hyg A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "Hyg B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
  });
  afterAll(async () => {
    for (const o of [orgA, orgB]) if (o) await svc().from("organizations").delete().eq("id", o);
  });

  it("[F-A] a closed permit's closed_at cannot be back-dated (status unchanged)", async () => {
    const id = String((await svc().from("permits_to_work").insert({
      org_id: orgA, permit_type: "general", title: "p", scope: "s",
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString(),
    }).select("id").single()).data?.id);
    await svc().from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}`, issued_at: new Date().toISOString() }).eq("id", id);
    // Legit close sets closed_at on the transition (must succeed — no regression).
    const closed = await svc().from("permits_to_work").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", id);
    expect(closed.error, closed.error?.message).toBeNull();
    // Back-dating closed_at with the status unchanged must be refused.
    const tamper = await svc().from("permits_to_work").update({ closed_at: "2020-01-01T00:00:00Z" }).eq("id", id);
    expect(tamper.error, "closed_at must be immutable once the permit is closed").not.toBeNull();
  });

  it("[F-B] an issued permit's org_id is immutable (no cross-org re-homing of evidence)", async () => {
    const id = String((await svc().from("permits_to_work").insert({
      org_id: orgA, permit_type: "general", title: "p", scope: "s",
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString(),
    }).select("id").single()).data?.id);
    await svc().from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-b`, issued_at: new Date().toISOString() }).eq("id", id);
    const move = await svc().from("permits_to_work").update({ org_id: orgB }).eq("id", id);
    expect(move.error, "an issued permit's org_id must be frozen").not.toBeNull();
  });

  it("[F-B] an issued RAMS's org_id is immutable", async () => {
    const id = String((await svc().from("risk_assessments").insert({ org_id: orgA, title: "r", activity: "x" }).select("id").single()).data?.id);
    await svc().from("risk_assessment_hazards").insert({ org_id: orgA, risk_assessment_id: id, hazard: "H", likelihood: 2, severity: 2, control_measures: "c" });
    await svc().from("risk_assessments").update({ status: "issued", reference: `RA-${TOKEN}`, issued_at: new Date().toISOString() }).eq("id", id);
    const move = await svc().from("risk_assessments").update({ org_id: orgB }).eq("id", id);
    expect(move.error, "an issued RAMS's org_id must be frozen").not.toBeNull();
  });

  it("[regression] a normal permit lifecycle (issue → activate) still sets its stamp", async () => {
    const id = String((await svc().from("permits_to_work").insert({
      org_id: orgA, permit_type: "general", title: "p", scope: "s",
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString(),
    }).select("id").single()).data?.id);
    await svc().from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}-r`, issued_at: new Date().toISOString() }).eq("id", id);
    const activate = await svc().from("permits_to_work").update({ status: "active", activated_at: new Date().toISOString() }).eq("id", id);
    expect(activate.error, activate.error?.message).toBeNull();
    const row = (await svc().from("permits_to_work").select("activated_at").eq("id", id).maybeSingle()).data as { activated_at: string | null };
    expect(row.activated_at).not.toBeNull();
  });
});
