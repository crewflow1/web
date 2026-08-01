import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Works Quality M2 — NCRs, corrective actions, witness invitations, templates
 * and revision lineage, against real Postgres with migration 20261081 applied.
 *
 * FOUR properties, each proven separately (the works-quality-isolation.test.ts
 * structure, extended to the five new tables):
 *
 *  1. OUTER BOUNDARY (RLS). anon and an authenticated NON-MEMBER see nothing on
 *     any of the five new tables (guessed ids return empty, never an error that
 *     confirms existence) and cannot write into another org — a cross-org NCR
 *     raise, corrective action, witness invitation, template or template item
 *     is refused.
 *
 *  2. LIFECYCLE AUTHORITY LIVES IN THE DB. The NCR's middle statuses are
 *     DERIVED (marker-gated): a direct status update is refused for a member
 *     with a perfectly valid JWT. The corrective-action decision is write-once
 *     and admin-gated AT THE DATABASE. The cascade's divergence guard is LIVE
 *     code: deciding an action whose NCR was cancelled mid-flight raises,
 *     rolling the decision back (the FOUND-capture regression — a FOUND check
 *     placed after the marker-clearing PERFORM would always pass).
 *
 *  3. WITNESS + TEMPLATE + REVISION invariants: invitation gates (control
 *     point, issued plan), terminal outcomes, sign-off↔invitation same-item
 *     binding; one-published-per-family and frozen published versions;
 *     self-rooted lineage, no forked series, cross-org roots refused.
 *
 *  4. ORG TEARDOWN commits with the full M2 object graph present.
 *
 * Fixtures are namespaced by a per-run TOKEN and every assertion is made
 * against ids created by THIS run, so the file is residue-independent.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  in(c: string, v: unknown[]): Sel;
  is(c: string, v: unknown): Sel;
  order(c: string, o: { ascending: boolean }): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
  select(c?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): Ins;
  update(r: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
};

const TOKEN = `it-wq2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Fixture = {
  orgId: string;
  jobId: string;
  planId: string;
  /** item ids ordered by item_number: [inspect, witness-hold, inspect, approve] */
  itemIds: string[];
  reference: string;
};

/** One org's fixture: a job and an ISSUED 4-item plan (item 2 is a witness hold point, item 4 an approve point). */
async function buildOrg(label: string, userId: string): Promise<Fixture> {
  const svc = db(serviceClient());

  const org = await svc.from("organizations").insert({ name: `WQ2 ${label}`, slug: `${TOKEN}-${label}` }).select("id").single();
  expect(org.error, org.error?.message).toBeNull();
  const orgId = String(org.data?.id ?? "");

  const mem = await svc.from("memberships").insert({ org_id: orgId, user_id: userId, role: "owner" });
  expect(mem.error, mem.error?.message).toBeNull();

  const cust = await svc.from("customers").insert({ org_id: orgId, name: `Cust ${label}` }).select("id").single();
  expect(cust.error, cust.error?.message).toBeNull();

  const job = await svc
    .from("jobs")
    .insert({ org_id: orgId, customer_id: String(cust.data?.id), status: "in-progress" })
    .select("id")
    .single();
  expect(job.error, job.error?.message).toBeNull();
  const jobId = String(job.data?.id ?? "");

  const plan = await svc
    .from("inspection_test_plans")
    .insert({ org_id: orgId, job_id: jobId, title: "Drainage ITP", work_package: "Below-ground drainage" })
    .select("id")
    .single();
  expect(plan.error, plan.error?.message).toBeNull();
  const planId = String(plan.data?.id ?? "");

  // Every row supplies EVERY optional column (the PostgREST batch NULL trap —
  // see works-quality-isolation.test.ts for the full note).
  const items = await svc
    .from("inspection_plan_items")
    .insert([
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 1, title: "Trench excavated", acceptance_criteria: "Depth to D-101", control_point: "inspect", is_hold_point: false, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 2, title: "Pipe laid", acceptance_criteria: "Falls 1:80", control_point: "witness", is_hold_point: true, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 3, title: "Air test", acceptance_criteria: "BS EN 1610", control_point: "inspect", is_hold_point: false, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 4, title: "Backfill accepted", acceptance_criteria: "150mm layers", control_point: "approve", is_hold_point: false, required: true },
    ]);
  expect(items.error, items.error?.message).toBeNull();

  const issued = await svc.rpc("issue_inspection_plan", { p_id: planId });
  expect(issued.error, issued.error?.message).toBeNull();
  const reference = String(issued.data ?? "");
  expect(reference).toMatch(/^ITP-\d{4}$/);

  const ordered = await svc
    .from("inspection_plan_items")
    .select("id, item_number")
    .eq("inspection_test_plan_id", planId)
    .order("item_number", { ascending: true });
  expect(ordered.error, ordered.error?.message).toBeNull();

  return {
    orgId,
    jobId,
    planId,
    itemIds: (ordered.data ?? []).map((r) => String(r.id)),
    reference,
  };
}

describeIntegration("works quality M2 · NCRs, corrective actions, witnesses, templates, revisions", () => {
  let dualUserId = "";
  let dualToken = "";
  let staffUserId = "";
  let staffToken = "";
  let outsiderUserId = "";
  let outsiderToken = "";
  let a: Fixture;
  let b: Fixture;

  // State threaded through the ordered tests below.
  let failSignoffId = ""; // live FAIL on A item 1 (the NCR source)
  let passSignoffId = ""; // live PASS on A item 3 (proves "source must be a fail")
  let ncr1Id = ""; // walked open → … → closed
  let ncr2Id = ""; // cancelled mid-flight (the divergence-guard proof)
  let action1Id = "";
  let action2Id = "";
  let inv1Id = ""; // honoured
  let inv2Id = ""; // cancelled
  let inv3Id = ""; // stays invited (tidy-up delete proof)
  let tplV1Id = "";
  let tplV2Id = "";
  let revisionDraftId = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const mk = async (tag: string) => {
      const email = `${TOKEN}-${tag}@example.test`;
      const password = `Pw-${TOKEN}-${tag}`;
      const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error, created.error?.message).toBeNull();
      return { id: created.data.user?.id ?? "", email, password };
    };

    // DUAL owner of both orgs; a plain STAFF member of org A (NOT an admin —
    // the decision-gate proof); an authenticated NON-MEMBER of either.
    const dual = await mk("dual");
    const staff = await mk("staff");
    const out = await mk("out");
    dualUserId = dual.id;
    staffUserId = staff.id;
    outsiderUserId = out.id;

    // Mirror into public.users (no auth trigger in this schema; raised_by /
    // inspected_by / decided_by all FK public.users).
    const mirrored = await svc.from("users").insert([
      { id: dualUserId, email: dual.email, full_name: dual.email },
      { id: staffUserId, email: staff.email, full_name: staff.email },
      { id: outsiderUserId, email: out.email, full_name: out.email },
    ]);
    expect(mirrored.error, mirrored.error?.message).toBeNull();

    a = await buildOrg("A", dualUserId);
    b = await buildOrg("B", dualUserId);

    const staffMem = await svc.from("memberships").insert({ org_id: a.orgId, user_id: staffUserId, role: "staff" });
    expect(staffMem.error, staffMem.error?.message).toBeNull();

    for (const [who, setToken] of [
      [dual, (t: string) => (dualToken = t)],
      [staff, (t: string) => (staffToken = t)],
      [out, (t: string) => (outsiderToken = t)],
    ] as const) {
      const signedIn = await anonClient().auth.signInWithPassword({ email: who.email, password: who.password });
      expect(signedIn.error, signedIn.error?.message).toBeNull();
      setToken(signedIn.data.session?.access_token ?? "");
    }
    if (!dualToken || !staffToken || !outsiderToken) throw new Error("failed to mint authenticated tokens");

    // The live FAIL on A item 1 that NCR-0001 is raised from, and the live
    // PASS on A item 3 that proves a pass can never be an NCR source.
    const fail = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[0],
        plan_version: a.reference,
        result: "fail",
        comments: "Falls 1:120 — out of tolerance",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
      })
      .select("id")
      .single();
    expect(fail.error, fail.error?.message).toBeNull();
    failSignoffId = String(fail.data?.id ?? "");

    const pass = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[2],
        plan_version: a.reference,
        result: "pass",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
      })
      .select("id")
      .single();
    expect(pass.error, pass.error?.message).toBeNull();
    passSignoffId = String(pass.data?.id ?? "");
  });

  afterAll(async () => {
    for (const orgId of [a?.orgId, b?.orgId]) {
      if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    }
    for (const uid of [dualUserId, staffUserId, outsiderUserId]) {
      if (uid) await serviceClient().auth.admin.deleteUser(uid);
    }
  });

  // ── 1. RAISING — the DB owns org, reference, provenance ──────────────────
  it("a member raises an NCR from the failed sign-off; NCR-0001 is DB-allocated and the client's reference is ignored", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[0],
        source_signoff_id: failSignoffId,
        reference: "NCR-9999", // ignored — the trigger allocates
        title: "Falls out of tolerance",
        description: "Measured 1:120 against 1:80 required.",
        severity: "major",
        responsible_subcontractor: "J Smith Groundworks",
        raised_by: dualUserId,
      })
      .select("id, reference, status, raised_by, org_id")
      .single();
    expect(error, error?.message).toBeNull();
    ncr1Id = String(data?.id ?? "");
    expect(data?.reference, "the DB allocates, the client proposes nothing").toBe("NCR-0001");
    expect(data?.status).toBe("open");
    expect(data?.raised_by).toBe(dualUserId);
  });

  it("a second NCR takes NCR-0002; org B's first takes NCR-0001 (allocation is org-scoped)", async () => {
    const second = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[2],
        reference: "x",
        title: "Air test anomaly",
        description: "Pressure drop marginally over the limit.",
        severity: "minor",
        responsible_user_id: dualUserId,
        raised_by: dualUserId,
      })
      .select("id, reference")
      .single();
    expect(second.error, second.error?.message).toBeNull();
    ncr2Id = String(second.data?.id ?? "");
    expect(second.data?.reference).toBe("NCR-0002");

    const bFirst = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .insert({
        org_id: b.orgId,
        inspection_plan_item_id: b.itemIds[0],
        reference: "x",
        title: "B nonconformity",
        description: "Standalone observation against the issued plan.",
        severity: "minor",
        responsible_subcontractor: "B Subbie",
        raised_by: dualUserId,
      })
      .select("reference")
      .single();
    expect(bFirst.error, bFirst.error?.message).toBeNull();
    expect(bFirst.data?.reference, "each org counts from NCR-0001").toBe("NCR-0001");
  });

  it("a spoofed org_id is ignored — the NCR's org is DERIVED from the plan item", async () => {
    const { data, error } = await db(serviceClient())
      .from("non_conformance_reports")
      .insert({
        org_id: b.orgId, // ← the spoof
        inspection_plan_item_id: a.itemIds[3],
        reference: "x",
        title: "Spoof probe",
        description: "org_id must come from the parent item.",
        severity: "minor",
        responsible_subcontractor: "Probe",
        raised_by: dualUserId,
      })
      .select("org_id")
      .single();
    expect(error, error?.message).toBeNull();
    expect(data?.org_id).toBe(a.orgId);
  });

  it("an NCR cannot be born closed, cannot cite a PASS as its source, and cannot target a DRAFT plan", async () => {
    const bornClosed = await db(userClient(dualToken)).from("non_conformance_reports").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[0],
      reference: "x",
      title: "t",
      description: "d",
      severity: "minor",
      responsible_subcontractor: "s",
      raised_by: dualUserId,
      status: "closed",
    });
    expect(bornClosed.error, "a direct INSERT must not mint a closed NCR").not.toBeNull();

    const passSource = await db(userClient(dualToken)).from("non_conformance_reports").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[2],
      source_signoff_id: passSignoffId,
      reference: "x",
      title: "t",
      description: "d",
      severity: "minor",
      responsible_subcontractor: "s",
      raised_by: dualUserId,
    });
    expect(passSource.error?.message ?? "").toMatch(/must be a failed sign-off/);

    const svc = db(serviceClient());
    const draft = await svc
      .from("inspection_test_plans")
      .insert({ org_id: a.orgId, job_id: a.jobId, title: "Draft only", work_package: `draft-${TOKEN}` })
      .select("id")
      .single();
    expect(draft.error, draft.error?.message).toBeNull();
    const draftItem = await svc
      .from("inspection_plan_items")
      .insert({ org_id: a.orgId, inspection_test_plan_id: String(draft.data?.id), item_number: 1, title: "unissued", acceptance_criteria: "x", control_point: "witness", is_hold_point: false, required: true })
      .select("id")
      .single();
    expect(draftItem.error, draftItem.error?.message).toBeNull();

    const onDraft = await db(userClient(dualToken)).from("non_conformance_reports").insert({
      org_id: a.orgId,
      inspection_plan_item_id: String(draftItem.data?.id),
      reference: "x",
      title: "t",
      description: "d",
      severity: "minor",
      responsible_subcontractor: "s",
      raised_by: dualUserId,
    });
    expect(onDraft.error?.message ?? "").toMatch(/issued inspection plan/);

    // The draft's witness item also refuses an invitation — invitations need an
    // ISSUED plan (used again in the witness block below).
    const inviteOnDraft = await db(userClient(dualToken)).from("inspection_witness_invitations").insert({
      org_id: a.orgId,
      inspection_plan_item_id: String(draftItem.data?.id),
      witness_name: "J Carter",
      witness_organisation: "Building Control",
    });
    expect(inviteOnDraft.error?.message ?? "").toMatch(/issued plan/);
  });

  // ── 2. OUTER BOUNDARY — guessed ids fail, cross-org writes refused ───────
  it("anon and an authenticated NON-MEMBER see NOTHING on any of the five new tables", async () => {
    // A guessed id returns EMPTY — never an error that confirms existence.
    for (const client of [anonClient(), userClient(outsiderToken)]) {
      for (const [table, col, id] of [
        ["non_conformance_reports", "id", ncr1Id],
        ["ncr_corrective_actions", "ncr_id", ncr1Id],
        ["inspection_witness_invitations", "inspection_plan_item_id", a.itemIds[1]],
        ["inspection_plan_templates", "org_id", a.orgId],
        ["inspection_plan_template_items", "org_id", a.orgId],
      ] as const) {
        const { data } = await db(client).from(table).select("id").eq(col, id);
        expect(data ?? [], `guessed-id read of ${table} must be empty`).toHaveLength(0);
      }
    }
  });

  it("a NON-MEMBER cannot raise an NCR against the org's plan item (cross-org raise fails)", async () => {
    const { error } = await db(userClient(outsiderToken)).from("non_conformance_reports").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[0],
      reference: "x",
      title: "intruder",
      description: "d",
      severity: "critical",
      responsible_subcontractor: "s",
      raised_by: outsiderUserId,
    });
    expect(error, "a non-member NCR raise must be refused").not.toBeNull();
  });

  it("a NON-MEMBER cannot propose an action, invite a witness, or create a template in the org", async () => {
    const action = await db(userClient(outsiderToken)).from("ncr_corrective_actions").insert({
      org_id: a.orgId,
      ncr_id: ncr1Id,
      description: "intruder fix",
    });
    expect(action.error, "a non-member proposal must be refused").not.toBeNull();

    const invite = await db(userClient(outsiderToken)).from("inspection_witness_invitations").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[1],
      witness_name: "Intruder",
      witness_organisation: "Nowhere",
    });
    expect(invite.error, "a non-member invitation must be refused").not.toBeNull();

    const tpl = await db(userClient(outsiderToken)).from("inspection_plan_templates").insert({
      org_id: a.orgId,
      name: "Intruder template",
    });
    expect(tpl.error, "a non-member template must be refused").not.toBeNull();
  });

  // ── 3. THE LIFECYCLE IS DB-AUTHORITATIVE ─────────────────────────────────
  it("a member with a valid JWT CANNOT walk the derived edges by hand (PostgREST bypass refused)", async () => {
    for (const status of ["corrective_action_proposed", "corrective_action_approved", "completed", "closed"]) {
      const { error } = await db(userClient(dualToken))
        .from("non_conformance_reports")
        .update({ status })
        .eq("id", ncr1Id);
      expect(error, `open → ${status} by hand must be refused`).not.toBeNull();
    }
    const still = await db(serviceClient()).from("non_conformance_reports").select("status").eq("id", ncr1Id);
    expect((still.data ?? [])[0]?.status).toBe("open");
  });

  it("proposing a corrective action cascades the NCR to corrective_action_proposed; a second pending proposal is refused", async () => {
    const proposed = await db(userClient(staffToken))
      .from("ncr_corrective_actions")
      .insert({
        org_id: a.orgId,
        ncr_id: ncr1Id,
        description: "Re-lay the run to 1:80 and re-test.",
      })
      .select("id, proposed_by")
      .single();
    expect(proposed.error, proposed.error?.message).toBeNull();
    action1Id = String(proposed.data?.id ?? "");
    expect(proposed.data?.proposed_by, "the proposer is the session, never form input").toBe(staffUserId);

    const ncr = await db(serviceClient()).from("non_conformance_reports").select("status").eq("id", ncr1Id);
    expect((ncr.data ?? [])[0]?.status).toBe("corrective_action_proposed");

    const second = await db(userClient(dualToken)).from("ncr_corrective_actions").insert({
      org_id: a.orgId,
      ncr_id: ncr1Id,
      description: "A competing idea",
    });
    expect(second.error, "one undecided proposal per NCR").not.toBeNull();
  });

  it("the decision is ADMIN-gated at the DB: a staff member's accept is refused", async () => {
    const { error } = await db(userClient(staffToken))
      .from("ncr_corrective_actions")
      .update({ decision: "accepted" })
      .eq("id", action1Id);
    expect(error?.message ?? "").toMatch(/only an owner or admin/);
  });

  it("an admin's accept lands, is pinned to the session, and cascades the NCR to approved", async () => {
    // decided_by names someone else on the wire — the trigger must overwrite it.
    const { error } = await db(userClient(dualToken))
      .from("ncr_corrective_actions")
      .update({ decision: "accepted", decided_by: staffUserId })
      .eq("id", action1Id);
    expect(error, error?.message).toBeNull();

    const after = await db(serviceClient())
      .from("ncr_corrective_actions")
      .select("decision, decided_by, decided_at")
      .eq("id", action1Id);
    const row = (after.data ?? [])[0]!;
    expect(row.decision).toBe("accepted");
    expect(row.decided_by, "the decider is the session, never the wire").toBe(dualUserId);
    expect(row.decided_at).toBeTruthy();

    const ncr = await db(serviceClient()).from("non_conformance_reports").select("status").eq("id", ncr1Id);
    expect((ncr.data ?? [])[0]?.status).toBe("corrective_action_approved");
  });

  it("the decision is WRITE-ONCE at the DB — changing or blanking it is refused", async () => {
    const flip = await db(userClient(dualToken))
      .from("ncr_corrective_actions")
      .update({ decision: "rejected", decision_reason: "changed my mind" })
      .eq("id", action1Id);
    expect(flip.error?.message ?? "").toMatch(/write-once/);

    const blank = await db(serviceClient())
      .from("ncr_corrective_actions")
      .update({ decision: null, decided_at: null })
      .eq("id", action1Id);
    expect(blank.error, "even the service role cannot unwrite a decision").not.toBeNull();
  });

  it("completion requires acceptance + its comment, and is write-once", async () => {
    const noComment = await db(userClient(staffToken))
      .from("ncr_corrective_actions")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", action1Id);
    expect(noComment.error, "completion without its comment must be refused").not.toBeNull();

    const done = await db(userClient(staffToken))
      .from("ncr_corrective_actions")
      .update({ completed_at: new Date().toISOString(), completion_comment: "Re-laid and re-tested at 1:80." })
      .eq("id", action1Id);
    expect(done.error, done.error?.message).toBeNull();

    const ncr = await db(serviceClient()).from("non_conformance_reports").select("status").eq("id", ncr1Id);
    expect((ncr.data ?? [])[0]?.status, "completion cascades the NCR").toBe("completed");

    const again = await db(userClient(staffToken))
      .from("ncr_corrective_actions")
      .update({ completion_comment: "actually different" })
      .eq("id", action1Id);
    expect(again.error?.message ?? "").toMatch(/write-once|never edited/);
  });

  it("closing requires the comment, pins the verifier to the session, and closed is TERMINAL", async () => {
    const noComment = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .update({ status: "closed" })
      .eq("id", ncr1Id);
    expect(noComment.error?.message ?? "").toMatch(/closure comment/);

    const closed = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .update({ status: "closed", closure_comment: "Re-inspected — conforms to D-101." })
      .eq("id", ncr1Id);
    expect(closed.error, closed.error?.message).toBeNull();

    const row = (
      await db(serviceClient())
        .from("non_conformance_reports")
        .select("status, verified_by, verified_at, closure_comment")
        .eq("id", ncr1Id)
    ).data?.[0];
    expect(row?.status).toBe("closed");
    expect(row?.verified_by, "the verifier is the session").toBe(dualUserId);
    expect(row?.verified_at).toBeTruthy();

    const reopen = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .update({ status: "open" })
      .eq("id", ncr1Id);
    expect(reopen.error?.message ?? "").toMatch(/final/);
  });

  it("DIVERGENCE GUARD IS LIVE: deciding an action whose NCR was cancelled mid-flight RAISES and rolls back", async () => {
    // The FOUND-capture regression: PERFORM set_config sets FOUND itself, so a
    // guard that read FOUND after clearing the marker would ALWAYS pass and
    // this decision would land silently against a cancelled NCR.
    const proposed = await db(userClient(dualToken))
      .from("ncr_corrective_actions")
      .insert({ org_id: a.orgId, ncr_id: ncr2Id, description: "Repeat the air test after re-seal." })
      .select("id")
      .single();
    expect(proposed.error, proposed.error?.message).toBeNull();
    action2Id = String(proposed.data?.id ?? "");

    // While the proposal is still undecided: a rejection must carry its reason
    // (the BEFORE guard fires before any cascade can run).
    const noReason = await db(userClient(dualToken))
      .from("ncr_corrective_actions")
      .update({ decision: "rejected" })
      .eq("id", action2Id);
    expect(noReason.error?.message ?? "").toMatch(/requires a reason/);

    const cancelled = await db(userClient(dualToken))
      .from("non_conformance_reports")
      .update({ status: "cancelled" })
      .eq("id", ncr2Id);
    expect(cancelled.error, cancelled.error?.message).toBeNull();

    const decide = await db(userClient(dualToken))
      .from("ncr_corrective_actions")
      .update({ decision: "accepted" })
      .eq("id", action2Id);
    expect(decide.error?.message ?? "").toMatch(/not awaiting this decision/);

    // The refused decision must have rolled back WHOLE — the action is still
    // undecided, and the NCR is still cancelled. No silent disagreement.
    const action = (
      await db(serviceClient()).from("ncr_corrective_actions").select("decision, decided_at").eq("id", action2Id)
    ).data?.[0];
    expect(action?.decision).toBeNull();
    expect(action?.decided_at).toBeNull();
    const ncr = (
      await db(serviceClient()).from("non_conformance_reports").select("status").eq("id", ncr2Id)
    ).data?.[0];
    expect(ncr?.status).toBe("cancelled");
  });

  it("neither an NCR nor a corrective action can be hard-deleted, even by the service role", async () => {
    const ncrDel = await db(serviceClient()).from("non_conformance_reports").delete().eq("id", ncr1Id);
    expect(ncrDel.error?.message ?? "").toMatch(/cannot be deleted; cancel it instead/);
    const actDel = await db(serviceClient()).from("ncr_corrective_actions").delete().eq("id", action1Id);
    expect(actDel.error?.message ?? "").toMatch(/audit trail and cannot be deleted/);
  });

  it("NCR evidence rides tenant_attachments on the widened target", async () => {
    const att = await db(serviceClient())
      .from("tenant_attachments")
      .insert({
        org_id: a.orgId,
        target_table: "non_conformance_reports",
        target_id: ncr1Id,
        filename: "rework.jpg",
        storage_path: `${a.orgId}/non_conformance_reports/${TOKEN}-rework.jpg`,
      })
      .select("id")
      .single();
    expect(att.error, "the widened CHECK must accept the NCR target").toBeNull();
  });

  // ── 4. WITNESS INVITATIONS ───────────────────────────────────────────────
  it("an invitation needs a witness/approve control point (an inspect item is refused)", async () => {
    const { error } = await db(userClient(dualToken)).from("inspection_witness_invitations").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[0], // control_point = inspect
      witness_name: "J Carter",
      witness_organisation: "Building Control",
    });
    expect(error?.message ?? "").toMatch(/witness or approve control point/);
  });

  it("invitations are created invited, org-derived, with the inviter pinned to the session", async () => {
    const mkInvite = async () =>
      db(userClient(dualToken))
        .from("inspection_witness_invitations")
        .insert({
          org_id: a.orgId,
          inspection_plan_item_id: a.itemIds[1], // the witness hold point
          witness_name: "J Carter",
          witness_organisation: "Building Control",
        })
        .select("id, status, invited_by, org_id")
        .single();
    const one = await mkInvite();
    expect(one.error, one.error?.message).toBeNull();
    inv1Id = String(one.data?.id ?? "");
    expect(one.data?.status).toBe("invited");
    expect(one.data?.invited_by).toBe(dualUserId);
    const two = await mkInvite();
    expect(two.error, two.error?.message).toBeNull();
    inv2Id = String(two.data?.id ?? "");
    const three = await mkInvite();
    expect(three.error, three.error?.message).toBeNull();
    inv3Id = String(three.data?.id ?? "");
  });

  it("a sign-off cannot honour a CANCELLED invitation, nor one belonging to ANOTHER item", async () => {
    const cancel = await db(userClient(dualToken))
      .from("inspection_witness_invitations")
      .update({ status: "cancelled" })
      .eq("id", inv2Id);
    expect(cancel.error, cancel.error?.message).toBeNull();

    const honoursCancelled = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[1],
      plan_version: a.reference,
      result: "pass",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
      witness_invitation_id: inv2Id,
    });
    expect(honoursCancelled.error?.message ?? "").toMatch(/does not belong to this inspection item|cancelled/);

    const wrongItem = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[3], // the approve point — inv1 is on item 2
      plan_version: a.reference,
      result: "pass",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
      witness_invitation_id: inv1Id,
    });
    expect(wrongItem.error?.message ?? "").toMatch(/does not belong to this inspection item/);
  });

  it("a sign-off honours the SAME-ITEM live invitation, and the link is frozen with the record", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[1],
        plan_version: a.reference,
        result: "pass",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
        witness_name: "J Carter",
        witness_organisation: "Building Control",
        witness_invitation_id: inv1Id,
      })
      .select("id, witness_invitation_id")
      .single();
    expect(error, error?.message).toBeNull();
    expect(data?.witness_invitation_id).toBe(inv1Id);

    const relink = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .update({ witness_invitation_id: null })
      .eq("id", String(data?.id));
    expect(relink.error?.message ?? "").toMatch(/immutable/);
  });

  it("attendance is recorded by transition with pinned provenance, and every outcome is TERMINAL", async () => {
    const byHand = await db(userClient(dualToken))
      .from("inspection_witness_invitations")
      .update({ attendance_recorded_at: new Date().toISOString() })
      .eq("id", inv1Id);
    expect(byHand.error?.message ?? "").toMatch(/not by hand/);

    const attended = await db(userClient(staffToken))
      .from("inspection_witness_invitations")
      .update({ status: "attended" })
      .eq("id", inv1Id);
    expect(attended.error, attended.error?.message).toBeNull();

    const row = (
      await db(serviceClient())
        .from("inspection_witness_invitations")
        .select("status, attendance_recorded_by, attendance_recorded_at")
        .eq("id", inv1Id)
    ).data?.[0];
    expect(row?.status).toBe("attended");
    expect(row?.attendance_recorded_by, "the recorder is the session").toBe(staffUserId);
    expect(row?.attendance_recorded_at).toBeTruthy();

    const rewrite = await db(userClient(dualToken))
      .from("inspection_witness_invitations")
      .update({ status: "not_attended" })
      .eq("id", inv1Id);
    expect(rewrite.error?.message ?? "").toMatch(/final; invite them again/);
  });

  it("a recorded outcome cannot be deleted even by the service role; a still-invited row can be tidied up", async () => {
    const attendedDel = await db(serviceClient()).from("inspection_witness_invitations").delete().eq("id", inv1Id);
    expect(attendedDel.error?.message ?? "").toMatch(/part of the inspection record/);

    const invitedDel = await db(userClient(dualToken)).from("inspection_witness_invitations").delete().eq("id", inv3Id);
    expect(invitedDel.error, invitedDel.error?.message).toBeNull();
    const gone = await db(serviceClient()).from("inspection_witness_invitations").select("id").eq("id", inv3Id);
    expect(gone.data ?? []).toHaveLength(0);
  });

  // ── 5. TEMPLATES — versioned controlled documents ────────────────────────
  it("an empty draft cannot publish; a populated one publishes atomically with pinned provenance", async () => {
    const empty = await db(userClient(dualToken))
      .from("inspection_plan_templates")
      .insert({ org_id: a.orgId, name: `Empty ${TOKEN}` })
      .select("id")
      .single();
    expect(empty.error, empty.error?.message).toBeNull();
    const emptyPublish = await db(userClient(dualToken)).rpc("publish_inspection_plan_template", {
      p_id: String(empty.data?.id),
    });
    expect(emptyPublish.error?.message ?? "").toMatch(/at least one inspection item/);

    const v1 = await db(userClient(dualToken))
      .from("inspection_plan_templates")
      .insert({ org_id: a.orgId, name: `Drainage checks ${TOKEN}` })
      .select("id, status, version")
      .single();
    expect(v1.error, v1.error?.message).toBeNull();
    tplV1Id = String(v1.data?.id ?? "");
    expect(v1.data?.status).toBe("draft");
    expect(v1.data?.version).toBe(1);

    const item = await db(userClient(dualToken)).from("inspection_plan_template_items").insert({
      org_id: b.orgId, // ← spoof: must be DERIVED back to org A from the template
      template_id: tplV1Id,
      item_number: 1,
      title: "Bedding",
      acceptance_criteria: "100mm pea gravel",
      control_point: "witness",
      is_hold_point: true,
      required: true,
    });
    // RLS WITH CHECK sees the DERIVED row (org A), so the dual member passes —
    // and the stored org must be A, not the spoofed B.
    expect(item.error, item.error?.message).toBeNull();
    const storedItem = (
      await db(serviceClient()).from("inspection_plan_template_items").select("org_id").eq("template_id", tplV1Id)
    ).data?.[0];
    expect(storedItem?.org_id, "template item org is derived from the template").toBe(a.orgId);

    const published = await db(userClient(dualToken)).rpc("publish_inspection_plan_template", { p_id: tplV1Id });
    expect(published.error, published.error?.message).toBeNull();
    const row = (
      await db(serviceClient())
        .from("inspection_plan_templates")
        .select("status, published_by, published_at")
        .eq("id", tplV1Id)
    ).data?.[0];
    expect(row?.status).toBe("published");
    expect(row?.published_by).toBe(dualUserId);
    expect(row?.published_at).toBeTruthy();
  });

  it("a published version is FROZEN: no edits, no item changes, no delete — for any role", async () => {
    const edit = await db(userClient(dualToken))
      .from("inspection_plan_templates")
      .update({ name: "renamed" })
      .eq("id", tplV1Id);
    expect(edit.error?.message ?? "").toMatch(/immutable; create a new version/);

    const addItem = await db(userClient(dualToken)).from("inspection_plan_template_items").insert({
      org_id: a.orgId,
      template_id: tplV1Id,
      item_number: 2,
      title: "late",
      acceptance_criteria: "x",
      control_point: "inspect",
      is_hold_point: false,
      required: true,
    });
    expect(addItem.error?.message ?? "").toMatch(/cannot modify the items of a published template/);

    const del = await db(serviceClient()).from("inspection_plan_templates").delete().eq("id", tplV1Id);
    expect(del.error?.message ?? "").toMatch(/controlled document and cannot be deleted/);
  });

  it("publishing v2 archives v1 in the same transaction — ONE published version per family", async () => {
    const name = `Drainage checks ${TOKEN}`;
    const v2 = await db(userClient(dualToken))
      .from("inspection_plan_templates")
      .insert({ org_id: a.orgId, name, version: 2, supersedes_id: tplV1Id })
      .select("id")
      .single();
    expect(v2.error, v2.error?.message).toBeNull();
    tplV2Id = String(v2.data?.id ?? "");

    const item = await db(userClient(dualToken)).from("inspection_plan_template_items").insert({
      org_id: a.orgId,
      template_id: tplV2Id,
      item_number: 1,
      title: "Bedding (rev B)",
      acceptance_criteria: "100mm pea gravel, verified depth",
      control_point: "witness",
      is_hold_point: true,
      required: true,
    });
    expect(item.error, item.error?.message).toBeNull();

    const published = await db(userClient(dualToken)).rpc("publish_inspection_plan_template", { p_id: tplV2Id });
    expect(published.error, published.error?.message).toBeNull();

    const family = await db(serviceClient())
      .from("inspection_plan_templates")
      .select("id, status")
      .eq("org_id", a.orgId)
      .eq("name", name);
    const byId = new Map((family.data ?? []).map((r) => [String(r.id), String(r.status)]));
    expect(byId.get(tplV1Id), "v1 must be archived by v2's publish").toBe("archived");
    expect(byId.get(tplV2Id)).toBe("published");

    // Archived is terminal — v1 cannot come back and violate the partial unique.
    const revive = await db(serviceClient())
      .from("inspection_plan_templates")
      .update({ status: "published" })
      .eq("id", tplV1Id);
    expect(revive.error, "archived → published must be refused").not.toBeNull();
  });

  it("cross-org instantiation is impossible at the boundary: an outsider cannot READ the template and cannot WRITE a plan", async () => {
    // Instantiation = read the published template's items, then insert a draft
    // plan + items. Both halves are denied to a non-member, so there is no
    // cross-org path for the app flow to even start from.
    const read = await db(userClient(outsiderToken))
      .from("inspection_plan_template_items")
      .select("id")
      .eq("template_id", tplV2Id);
    expect(read.data ?? []).toHaveLength(0);

    const plan = await db(userClient(outsiderToken)).from("inspection_test_plans").insert({
      org_id: a.orgId,
      job_id: a.jobId,
      title: "Intruder plan",
      work_package: `intruder-${TOKEN}`,
    });
    expect(plan.error, "a non-member cannot create a plan in the org").not.toBeNull();
  });

  // ── 6. REVISION LINEAGE ──────────────────────────────────────────────────
  it("plans self-root; a revision draft carries (root, rev+1); a cross-org root is refused", async () => {
    const rooted = (
      await db(serviceClient())
        .from("inspection_test_plans")
        .select("root_plan_id, revision_number")
        .eq("id", a.planId)
    ).data?.[0];
    expect(rooted?.root_plan_id, "revision 1 self-roots (backfill + trigger)").toBe(a.planId);
    expect(rooted?.revision_number).toBe(1);

    const crossOrg = await db(userClient(dualToken)).from("inspection_test_plans").insert({
      org_id: b.orgId,
      job_id: b.jobId,
      title: "Cross-org revision",
      work_package: `xorg-${TOKEN}`,
      root_plan_id: a.planId, // org A's series, claimed from org B
      revision_number: 2,
    });
    // Strengthened guard (adversarial P2): the root must be a SERIES ORIGIN
    // (self-rooted revision 1) in this org. Org A's plan is neither an org-B
    // plan nor reachable, so the cross-org claim is refused with this message.
    expect(crossOrg.error?.message ?? "").toMatch(/not a series origin in this organisation/);

    const revision = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .insert({
        org_id: a.orgId,
        job_id: a.jobId,
        title: "Drainage ITP",
        work_package: "Below-ground drainage",
        root_plan_id: a.planId,
        revision_number: 2,
      })
      .select("id, status, root_plan_id, revision_number")
      .single();
    expect(revision.error, revision.error?.message).toBeNull();
    revisionDraftId = String(revision.data?.id ?? "");
    expect(revision.data?.status).toBe("draft");
    expect(revision.data?.root_plan_id).toBe(a.planId);
  });

  it("a series cannot FORK: a second concurrent revision draft is refused; lineage is frozen", async () => {
    const fork = await db(userClient(dualToken)).from("inspection_test_plans").insert({
      org_id: a.orgId,
      job_id: a.jobId,
      title: "Drainage ITP fork",
      work_package: "Below-ground drainage",
      root_plan_id: a.planId,
      revision_number: 3,
    });
    expect(fork.error, "one draft per series (partial unique)").not.toBeNull();

    const rewrite = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .update({ revision_number: 7 })
      .eq("id", revisionDraftId);
    expect(rewrite.error?.message ?? "").toMatch(/revision lineage is fixed at creation/);
  });

  // ── 7. ORG TEARDOWN with the full M2 graph present ───────────────────────
  it("org teardown commits with NCRs, actions, invitations and templates present", async () => {
    const svc = db(serviceClient());

    // Give org B one of everything M2 first.
    const bNcr = await svc
      .from("non_conformance_reports")
      .select("id")
      .eq("org_id", b.orgId);
    expect((bNcr.data ?? []).length, "org B already has its NCR from the allocation test").toBeGreaterThan(0);
    const bNcrId = String((bNcr.data ?? [])[0]?.id);

    const bAction = await svc.from("ncr_corrective_actions").insert({
      org_id: b.orgId,
      ncr_id: bNcrId,
      description: "B fix",
      proposed_by: dualUserId,
    });
    expect(bAction.error, bAction.error?.message).toBeNull();

    const bInvite = await svc.from("inspection_witness_invitations").insert({
      org_id: b.orgId,
      inspection_plan_item_id: b.itemIds[1],
      witness_name: "B Witness",
      witness_organisation: "B Org",
      invited_by: dualUserId,
    });
    expect(bInvite.error, bInvite.error?.message).toBeNull();

    const bTpl = await svc
      .from("inspection_plan_templates")
      .insert({ org_id: b.orgId, name: `B template ${TOKEN}` })
      .select("id")
      .single();
    expect(bTpl.error, bTpl.error?.message).toBeNull();
    const bTplItem = await svc.from("inspection_plan_template_items").insert({
      org_id: b.orgId,
      template_id: String(bTpl.data?.id),
      item_number: 1,
      title: "B item",
      acceptance_criteria: "x",
      control_point: "inspect",
      is_hold_point: false,
      required: true,
    });
    expect(bTplItem.error, bTplItem.error?.message).toBeNull();

    const torn = await svc.from("organizations").delete().eq("id", b.orgId);
    expect(torn.error, torn.error?.message).toBeNull();

    for (const table of [
      "non_conformance_reports",
      "ncr_corrective_actions",
      "inspection_witness_invitations",
      "inspection_plan_templates",
      "inspection_plan_template_items",
      "inspection_test_plans",
    ]) {
      const left = await svc.from(table).select("id").eq("org_id", b.orgId);
      expect(left.data ?? [], `${table} must be gone with the org`).toHaveLength(0);
    }

    b = { ...b, orgId: "" };
  });
});
