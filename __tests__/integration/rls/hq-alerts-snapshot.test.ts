import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { buildAlertsSnapshot } from "@/server/services/hq-alerts-snapshot";

/**
 * WAVE A.1 REGRESSION — HQ alerts snapshot ↔ demo_requests linkage.
 *
 * The defect (prod, 100%-failing crons `alerts-poll` + `hq-decision-autopropose`):
 * `buildAlertsSnapshot()` queried `demo_requests.org_id` and ordered by
 * `demo_requests.updated_at` — NEITHER column exists. `demo_requests` is a GLOBAL
 * marketing funnel that links to an org only via `linked_org_id` (stamped on
 * conversion), and its row-level stamp is `approved_at`, not `updated_at`. Every
 * run threw `column demo_requests.org_id does not exist`, so admin alerts and the
 * Phase-16 Decision-Centre auto-proposer never ran.
 *
 * This test runs the REAL query against REAL Postgres (the only thing that catches
 * a schema mismatch a unit mock hides) and pins the domain model:
 *   1. the snapshot builds without a column error (regression guard);
 *   2. a demo linked via linked_org_id is attributed to that org;
 *   3. a global (null-linked) demo is attributed to NO org;
 *   4. one org's demos never contain another org's demo (no cross-org leak).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
interface Ins extends PromiseLike<Res<Record<string, unknown>[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Record<string, unknown>>> };
}
interface Del extends PromiseLike<Res<null>> {
  in(column: string, values: unknown[]): Del;
}
interface Table {
  insert(rows: Record<string, unknown> | Record<string, unknown>[]): Ins;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-alerts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgA = "";
let orgB = "";
let demoLinkedA = "";
let demoLinkedB = "";
let demoGlobal = "";

describeIntegration("HQ alerts snapshot — demo_requests linkage (Wave A.1)", () => {
  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: `${TOKEN}-A`, slug: `${TOKEN}-a` })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = a.data!.id as string;

    const b = await svc
      .from("organizations")
      .insert({ name: `${TOKEN}-B`, slug: `${TOKEN}-b` })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = b.data!.id as string;

    const dA = await svc
      .from("demo_requests")
      .insert({
        name: `${TOKEN} A`,
        company: `${TOKEN} Co A`,
        email: `${TOKEN}-a@example.com`,
        status: "demo_booked",
        linked_org_id: orgA,
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(dA.error, dA.error?.message).toBeNull();
    demoLinkedA = dA.data!.id as string;

    const dB = await svc
      .from("demo_requests")
      .insert({
        name: `${TOKEN} B`,
        company: `${TOKEN} Co B`,
        email: `${TOKEN}-b@example.com`,
        status: "demo_booked",
        linked_org_id: orgB,
        approved_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(dB.error, dB.error?.message).toBeNull();
    demoLinkedB = dB.data!.id as string;

    const dG = await svc
      .from("demo_requests")
      .insert({
        name: `${TOKEN} G`,
        company: `${TOKEN} Co G`,
        email: `${TOKEN}-g@example.com`,
        status: "pending_demo",
        linked_org_id: null,
      })
      .select("id")
      .single();
    expect(dG.error, dG.error?.message).toBeNull();
    demoGlobal = dG.data!.id as string;
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    await svc.from("demo_requests").delete().in("id", [demoLinkedA, demoLinkedB, demoGlobal]);
    // Best-effort org cleanup (ephemeral CI DB); ignore FK residue from health recompute.
    await svc.from("admin_alert_state").delete().in("org_id", [orgA, orgB]);
    await svc.from("health_scores").delete().in("org_id", [orgA, orgB]);
    await svc.from("organizations").delete().in("id", [orgA, orgB]);
  });

  it("builds the snapshot without the demo_requests column error (regression)", async () => {
    // Before the fix this threw: column demo_requests.org_id does not exist.
    const { snapshot } = await buildAlertsSnapshot();
    expect(Array.isArray(snapshot.rows)).toBe(true);
  });

  it("attributes a demo to its org via linked_org_id, and never cross-org", async () => {
    const { snapshot } = await buildAlertsSnapshot();
    const rowA = snapshot.rows.find((r) => r.org.id === orgA);
    const rowB = snapshot.rows.find((r) => r.org.id === orgB);
    expect(rowA, "seeded org A must appear in the estate snapshot").toBeTruthy();
    expect(rowB, "seeded org B must appear in the estate snapshot").toBeTruthy();

    const demoIdsA = rowA!.demos.map((d) => d.id);
    const demoIdsB = rowB!.demos.map((d) => d.id);

    // (2) linkage
    expect(demoIdsA).toContain(demoLinkedA);
    expect(demoIdsB).toContain(demoLinkedB);
    // (4) no cross-org leak
    expect(demoIdsA).not.toContain(demoLinkedB);
    expect(demoIdsB).not.toContain(demoLinkedA);
  });

  it("does not attribute a global (null-linked) demo to any org", async () => {
    const { snapshot } = await buildAlertsSnapshot();
    for (const row of snapshot.rows) {
      expect(row.demos.map((d) => d.id)).not.toContain(demoGlobal);
    }
  });
});
