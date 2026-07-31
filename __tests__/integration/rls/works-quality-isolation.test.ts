import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Works Quality (ITP) — tenant isolation + the hold-point gate, against real
 * Postgres with migration 20261076 applied.
 *
 * THREE properties, each proven separately:
 *
 *  1. OUTER BOUNDARY (RLS). anon sees nothing; an AUTHENTICATED NON-MEMBER sees
 *     nothing and cannot write. The gate is org MEMBERSHIP, not mere
 *     authentication — the property a cross-tenant leak would violate.
 *
 *  2. ACTIVE-ORG SCOPING (the #456/#463/#468 defect class). A genuine DUAL-ORG
 *     member is a legitimate member of both companies, so `current_org_ids()`
 *     returns both and RLS alone CANNOT separate them. The test first proves the
 *     PREMISE (an unpinned read really does blend the two — otherwise the
 *     isolation assertions could pass for the wrong reason), then proves the
 *     pinned predicate the app actually issues isolates, and that switching the
 *     pin flips the result so nothing is hidden for ever.
 *
 *  3. THE HOLD-POINT GATE + evidence integrity. The gate is DB-authoritative and
 *     WARN-only: a sign-off past an open hold point is ACCEPTED and STAMPED, not
 *     refused. Immutability, void-and-redo, one-live-per-item and the
 *     non-deletability of evidence are all asserted against real triggers.
 *
 * Fixtures are namespaced by a per-run TOKEN and every assertion is made against
 * ids created by THIS run, so the file is residue-independent.
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

const TOKEN = `it-wq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Fixture = {
  orgId: string;
  jobId: string;
  planId: string;
  itemIds: string[];
  reference: string;
};

/** Build one org's fixture: a job, an ISSUED 4-item plan (items 2 and 4 are hold points). */
async function buildOrg(label: string, userId: string): Promise<Fixture> {
  const svc = db(serviceClient());

  const org = await svc.from("organizations").insert({ name: `WQ ${label}`, slug: `${TOKEN}-${label}` }).select("id").single();
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

  // Deliberately NEAR-IDENTICAL across orgs — only org_id differs — so a passing
  // isolation assertion cannot be an artefact of some other column.
  const plan = await svc
    .from("inspection_test_plans")
    .insert({ org_id: orgId, job_id: jobId, title: "Drainage ITP", work_package: "Below-ground drainage" })
    .select("id")
    .single();
  expect(plan.error, plan.error?.message).toBeNull();
  const planId = String(plan.data?.id ?? "");

  // NOTE: every row supplies EVERY optional column on purpose. In a multi-row
  // PostgREST insert, a column omitted from one row but present in another is
  // sent as an explicit NULL rather than falling back to the column DEFAULT — so
  // a heterogeneous batch would fail the NOT NULL on control_point /
  // is_hold_point. The app inserts one item per request, so this is a batch-only
  // trap; it is written out here so nobody "tidies" these rows back.
  const items = await svc
    .from("inspection_plan_items")
    .insert([
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 1, title: "Trench excavated", acceptance_criteria: "Depth to D-101", control_point: "inspect", is_hold_point: false, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 2, title: "Pipe laid", acceptance_criteria: "Falls 1:80", control_point: "witness", is_hold_point: true, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 3, title: "Air test", acceptance_criteria: "BS EN 1610", control_point: "inspect", is_hold_point: false, required: true },
      { org_id: orgId, inspection_test_plan_id: planId, item_number: 4, title: "Backfill", acceptance_criteria: "150mm layers", control_point: "approve", is_hold_point: true, required: true },
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

describeIntegration("works quality ITP · tenant isolation + hold-point gate", () => {
  let dualUserId = "";
  let dualToken = "";
  let outsiderUserId = "";
  let outsiderToken = "";
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    const svc = db(serviceClient());

    // The DUAL-ORG member: a legitimate member of BOTH companies.
    const dualEmail = `${TOKEN}-dual@example.test`;
    const dualPw = `Pw-${TOKEN}-dual`;
    const dual = await serviceClient().auth.admin.createUser({
      email: dualEmail,
      password: dualPw,
      email_confirm: true,
    });
    expect(dual.error, dual.error?.message).toBeNull();
    dualUserId = dual.data.user?.id ?? "";

    // An authenticated NON-MEMBER of either company.
    const outEmail = `${TOKEN}-out@example.test`;
    const outPw = `Pw-${TOKEN}-out`;
    const out = await serviceClient().auth.admin.createUser({
      email: outEmail,
      password: outPw,
      email_confirm: true,
    });
    expect(out.error, out.error?.message).toBeNull();
    outsiderUserId = out.data.user?.id ?? "";

    // No auth.users → public.users trigger in this schema, so mirror the rows
    // ourselves (memberships.user_id and inspection_signoffs.inspected_by both
    // FK public.users) — the active-org-list-scoping.test.ts idiom.
    const mirrored = await svc.from("users").insert([
      { id: dualUserId, email: dualEmail, full_name: dualEmail },
      { id: outsiderUserId, email: outEmail, full_name: outEmail },
    ]);
    expect(mirrored.error, mirrored.error?.message).toBeNull();

    a = await buildOrg("A", dualUserId);
    b = await buildOrg("B", dualUserId);

    const signedIn = await anonClient().auth.signInWithPassword({ email: dualEmail, password: dualPw });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    dualToken = signedIn.data.session?.access_token ?? "";
    const signedIn2 = await anonClient().auth.signInWithPassword({ email: outEmail, password: outPw });
    expect(signedIn2.error, signedIn2.error?.message).toBeNull();
    outsiderToken = signedIn2.data.session?.access_token ?? "";
    if (!dualToken || !outsiderToken) throw new Error("failed to mint authenticated tokens");
  });

  afterAll(async () => {
    // Order matters and is itself part of the proof: the org cascade must remove
    // every plan/item/signoff BEFORE the users are deleted, otherwise
    // inspected_by's ON DELETE RESTRICT would block the user delete.
    for (const orgId of [a?.orgId, b?.orgId]) {
      if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    }
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderUserId) await serviceClient().auth.admin.deleteUser(outsiderUserId);
  });

  // ── 1. OUTER BOUNDARY ────────────────────────────────────────────────────
  it("service_role sees the plan it created (RLS bypassed — positive control)", async () => {
    const res = await db(serviceClient())
      .from("inspection_test_plans")
      .select("id, reference")
      .eq("id", a.planId);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(1);
  });

  it("anon sees no plan, no item and no sign-off (RLS enforced)", async () => {
    for (const [table, col, id] of [
      ["inspection_test_plans", "id", a.planId],
      ["inspection_plan_items", "inspection_test_plan_id", a.planId],
    ] as const) {
      const { data } = await db(anonClient()).from(table).select("id").eq(col, id);
      expect(data ?? [], `anon must not read ${table}`).toHaveLength(0);
    }
    const view = await db(anonClient())
      .from("works_quality_plan_status")
      .select("plan_id")
      .eq("plan_id", a.planId);
    expect(view.data ?? [], "the security_invoker view must not launder RLS").toHaveLength(0);
  });

  it("an authenticated NON-MEMBER sees nothing (the gate is membership, not auth)", async () => {
    const plans = await db(userClient(outsiderToken))
      .from("inspection_test_plans")
      .select("id")
      .eq("id", a.planId);
    expect(plans.data ?? []).toHaveLength(0);
    const items = await db(userClient(outsiderToken))
      .from("inspection_plan_items")
      .select("id")
      .eq("inspection_test_plan_id", a.planId);
    expect(items.data ?? []).toHaveLength(0);
    const view = await db(userClient(outsiderToken))
      .from("works_quality_plan_status")
      .select("plan_id")
      .eq("plan_id", a.planId);
    expect(view.data ?? []).toHaveLength(0);
  });

  it("an authenticated NON-MEMBER cannot write an item into the org's plan", async () => {
    const { error } = await db(userClient(outsiderToken)).from("inspection_plan_items").insert({
      org_id: a.orgId,
      inspection_test_plan_id: a.planId,
      item_number: 99,
      title: "intruder",
      acceptance_criteria: "x",
    });
    expect(error, "a non-member insert must be refused").not.toBeNull();
  });

  it("an authenticated NON-MEMBER cannot record a sign-off, even naming themselves", async () => {
    const { error } = await db(userClient(outsiderToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[0],
      plan_version: a.reference,
      result: "pass",
      inspected_by: outsiderUserId,
      signed_name: "Intruder",
    });
    expect(error, "a non-member sign-off must be refused").not.toBeNull();
  });

  it("a member cannot sign off AS SOMEONE ELSE (the signature is personal)", async () => {
    const { error } = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[0],
      plan_version: a.reference,
      result: "pass",
      inspected_by: outsiderUserId, // not auth.uid()
      signed_name: "Not me",
    });
    expect(error, "signing for another user must be refused").not.toBeNull();
  });

  it("org A cannot bind a plan to org B's job", async () => {
    const { error } = await db(serviceClient()).from("inspection_test_plans").insert({
      org_id: a.orgId,
      job_id: b.jobId,
      title: "Cross-tenant",
      work_package: "WP",
    });
    expect(error?.message ?? "").toMatch(/does not belong to this organisation/);
  });

  // ── 2. ACTIVE-ORG SCOPING ────────────────────────────────────────────────
  it("PREMISE: an UNPINNED read really does blend the dual-org member's two companies", async () => {
    // If this ever stops being true, current_org_ids() changed and the whole
    // active-org slice below should be revisited.
    const { data, error } = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .select("id, org_id")
      .in("id", [a.planId, b.planId]);
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.id)).sort();
    expect(ids).toEqual([a.planId, b.planId].sort());
  });

  it("the PINNED predicate the app issues returns only the active org's plan", async () => {
    const active = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .select("id")
      .eq("org_id", a.orgId)
      .in("id", [a.planId, b.planId]);
    expect(active.error, active.error?.message).toBeNull();
    expect((active.data ?? []).map((r) => String(r.id))).toEqual([a.planId]);
  });

  it("switching the active org flips the result — nothing is hidden for ever", async () => {
    const active = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .select("id")
      .eq("org_id", b.orgId)
      .in("id", [a.planId, b.planId]);
    expect((active.data ?? []).map((r) => String(r.id))).toEqual([b.planId]);
  });

  it("the register read-model blends too when unpinned, and isolates when pinned", async () => {
    // The view is what the register and the job-hub tile read, so the same
    // pinning discipline has to hold there or the hold-point count is wrong.
    const blended = await db(userClient(dualToken))
      .from("works_quality_plan_status")
      .select("plan_id")
      .in("plan_id", [a.planId, b.planId]);
    expect((blended.data ?? []).length).toBe(2);

    const pinned = await db(userClient(dualToken))
      .from("works_quality_plan_status")
      .select("plan_id")
      .eq("org_id", a.orgId)
      .in("plan_id", [a.planId, b.planId]);
    expect((pinned.data ?? []).map((r) => String(r.plan_id))).toEqual([a.planId]);
  });

  it("items and sign-offs isolate on the same predicate", async () => {
    const items = await db(userClient(dualToken))
      .from("inspection_plan_items")
      .select("id, inspection_test_plan_id")
      .eq("org_id", a.orgId)
      .in("inspection_test_plan_id", [a.planId, b.planId]);
    expect(items.error, items.error?.message).toBeNull();
    for (const r of items.data ?? []) expect(String(r.inspection_test_plan_id)).toBe(a.planId);
    expect((items.data ?? []).length).toBe(4);
  });

  // ── 3. THE HOLD-POINT GATE ───────────────────────────────────────────────
  it("the gate starts at the FIRST hold point (item 2)", async () => {
    const { data, error } = await db(serviceClient()).rpc("works_quality_open_hold_point", {
      p_plan_id: a.planId,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toBe(2);
  });

  it("an item's org_id is DERIVED from its parent — a spoofed org_id is ignored", async () => {
    // Add to a fresh DRAFT plan (items are frozen on an issued one).
    const svc = db(serviceClient());
    const draft = await svc
      .from("inspection_test_plans")
      .insert({ org_id: a.orgId, job_id: a.jobId, title: "Spoof probe", work_package: `spoof-${TOKEN}` })
      .select("id")
      .single();
    expect(draft.error, draft.error?.message).toBeNull();
    const item = await svc
      .from("inspection_plan_items")
      .insert({
        org_id: b.orgId, // ← the spoof
        inspection_test_plan_id: String(draft.data?.id),
        item_number: 1,
        title: "probe",
        acceptance_criteria: "x",
      })
      .select("id, org_id")
      .single();
    expect(item.error, item.error?.message).toBeNull();
    expect(item.data?.org_id, "org_id must come from the parent, not the client").toBe(a.orgId);
  });

  it("signing off item 1 records NO breach (the gate at item 2 is not behind it)", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[0],
        plan_version: a.reference,
        result: "pass",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
      })
      .select("id, hold_point_breach, open_hold_item_number, recorded_at")
      .single();
    expect(error, error?.message).toBeNull();
    expect(data?.hold_point_breach).toBe(false);
    expect(data?.open_hold_item_number).toBeNull();
    expect(data?.recorded_at, "the record time is server-pinned").toBeTruthy();
  });

  it("WARN NOT BLOCK: signing off item 3 past the open hold point is ACCEPTED and STAMPED", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[2],
        plan_version: a.reference,
        result: "pass",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
      })
      .select("id, hold_point_breach, open_hold_item_number")
      .single();
    // THE load-bearing assertion for the WARN seam: no error.
    expect(error, "the gate must NOT refuse the write — it is a WARN seam").toBeNull();
    expect(data?.hold_point_breach).toBe(true);
    expect(data?.open_hold_item_number).toBe(2);
  });

  it("a FAIL on the hold point does not release it", async () => {
    const ins = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: a.orgId,
        inspection_plan_item_id: a.itemIds[1],
        plan_version: a.reference,
        result: "fail",
        comments: "Falls 1:120 — too shallow",
        inspected_by: dualUserId,
        signed_name: "A Inspector",
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();

    const gate = await db(serviceClient()).rpc("works_quality_open_hold_point", { p_plan_id: a.planId });
    expect(gate.data, "a failed check leaves the hold point OPEN").toBe(2);

    // …and the read-model counts it as outstanding, never as done.
    const view = await db(serviceClient())
      .from("works_quality_plan_status")
      .select("open_hold_points, failed_items, outstanding_required_items, hold_point_breaches")
      .eq("plan_id", a.planId);
    const row = (view.data ?? [])[0]!;
    expect(row.open_hold_points).toBe(2);
    expect(row.failed_items).toBe(1);
    expect(row.hold_point_breaches).toBe(1);
    expect(row.outstanding_required_items).toBe(2);
  });

  it("a non-pass without a comment is refused", async () => {
    const { error } = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[3],
      plan_version: a.reference,
      result: "fail",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
    });
    expect(error, "an unexplained failure is not evidence").not.toBeNull();
  });

  it("a wrong version anchor is refused", async () => {
    const { error } = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[3],
      plan_version: "ITP-9999",
      result: "pass",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
    });
    expect(error?.message ?? "").toMatch(/version mismatch/);
  });

  it("only ONE live sign-off per item", async () => {
    const { error } = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[1], // already has the live fail
      plan_version: a.reference,
      result: "pass",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
    });
    expect(error, "a second live sign-off must be refused").not.toBeNull();
  });

  it("a recorded sign-off is IMMUTABLE (an edit is refused)", async () => {
    const live = await db(serviceClient())
      .from("inspection_signoffs")
      .select("id")
      .eq("inspection_plan_item_id", a.itemIds[1])
      .is("voided_at", null);
    const id = String((live.data ?? [])[0]?.id);
    const { error } = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .update({ result: "pass", comments: "actually fine" })
      .eq("id", id);
    expect(error?.message ?? "").toMatch(/immutable; void it and record a new one/);
  });

  it("void-and-redo is the correction path, and it clears the gate", async () => {
    const live = await db(serviceClient())
      .from("inspection_signoffs")
      .select("id")
      .eq("inspection_plan_item_id", a.itemIds[1])
      .is("voided_at", null);
    const id = String((live.data ?? [])[0]?.id);

    const voided = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .update({
        voided_at: new Date().toISOString(),
        voided_by: dualUserId,
        void_reason: "Re-laid to correct falls; re-inspected",
      })
      .eq("id", id);
    expect(voided.error, voided.error?.message).toBeNull();

    // A voided row is terminal.
    const again = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .update({ void_reason: "changed my mind" })
      .eq("id", id);
    expect(again.error?.message ?? "").toMatch(/terminal and cannot be changed/);

    // The redo releases the hold point; the gate moves to the next one (item 4).
    const redo = await db(userClient(dualToken)).from("inspection_signoffs").insert({
      org_id: a.orgId,
      inspection_plan_item_id: a.itemIds[1],
      plan_version: a.reference,
      result: "pass",
      inspected_by: dualUserId,
      signed_name: "A Inspector",
    });
    expect(redo.error, redo.error?.message).toBeNull();

    const gate = await db(serviceClient()).rpc("works_quality_open_hold_point", { p_plan_id: a.planId });
    expect(gate.data).toBe(4);

    // The historical breach on item 3 SURVIVES the later release — the fact that
    // work went past an open hold point is not erased by fixing it afterwards.
    const view = await db(serviceClient())
      .from("works_quality_plan_status")
      .select("hold_point_breaches, failed_items")
      .eq("plan_id", a.planId);
    expect((view.data ?? [])[0]!.hold_point_breaches).toBe(1);
    expect((view.data ?? [])[0]!.failed_items, "the voided fail no longer counts").toBe(0);
  });

  it("a sign-off can never be DELETED, not even by the service role", async () => {
    const live = await db(serviceClient())
      .from("inspection_signoffs")
      .select("id")
      .eq("inspection_plan_item_id", a.itemIds[0]);
    const id = String((live.data ?? [])[0]?.id);
    const { error } = await db(serviceClient()).from("inspection_signoffs").delete().eq("id", id);
    expect(error?.message ?? "").toMatch(/cannot be deleted; void it instead/);
  });

  it("an ISSUED plan is immutable and undeletable; its items are frozen", async () => {
    const edit = await db(userClient(dualToken))
      .from("inspection_test_plans")
      .update({ title: "renamed" })
      .eq("id", a.planId);
    expect(edit.error?.message ?? "").toMatch(/immutable; supersede it with a new plan/);

    const addItem = await db(userClient(dualToken)).from("inspection_plan_items").insert({
      org_id: a.orgId,
      inspection_test_plan_id: a.planId,
      item_number: 5,
      title: "late addition",
      acceptance_criteria: "x",
    });
    expect(addItem.error?.message ?? "").toMatch(/cannot modify the items of a issued inspection plan/);

    const del = await db(serviceClient()).from("inspection_test_plans").delete().eq("id", a.planId);
    expect(del.error?.message ?? "").toMatch(/quality evidence and cannot be deleted/);
  });

  it("issuing a second plan for the same (job, work package) supersedes the first", async () => {
    const svc = db(serviceClient());
    const replacement = await svc
      .from("inspection_test_plans")
      .insert({ org_id: a.orgId, job_id: a.jobId, title: "Drainage ITP rev B", work_package: "Below-ground drainage" })
      .select("id")
      .single();
    expect(replacement.error, replacement.error?.message).toBeNull();
    const newId = String(replacement.data?.id);
    const it1 = await svc.from("inspection_plan_items").insert({
      org_id: a.orgId,
      inspection_test_plan_id: newId,
      item_number: 1,
      title: "Trench",
      acceptance_criteria: "D-101 rev B",
    });
    expect(it1.error, it1.error?.message).toBeNull();

    const issued = await svc.rpc("issue_inspection_plan", { p_id: newId });
    expect(issued.error, issued.error?.message).toBeNull();

    const rows = await svc
      .from("inspection_test_plans")
      .select("id, status, supersedes_id")
      .in("id", [a.planId, newId]);
    const byId = new Map((rows.data ?? []).map((r) => [String(r.id), r]));
    expect(byId.get(a.planId)!.status, "the prior plan is superseded").toBe("superseded");
    expect(byId.get(newId)!.status).toBe("issued");
    expect(byId.get(newId)!.supersedes_id, "the new plan points at what it replaced").toBe(a.planId);

    // Sign-offs stay attached to the version they were recorded against.
    const kept = await svc
      .from("inspection_signoffs")
      .select("id, plan_version")
      .eq("inspection_plan_item_id", a.itemIds[0]);
    expect((kept.data ?? [])[0]!.plan_version).toBe(a.reference);
  });

  it("evidence attached to a sign-off cannot be removed (append-only)", async () => {
    const svc = db(serviceClient());
    const live = await svc
      .from("inspection_signoffs")
      .select("id")
      .eq("inspection_plan_item_id", a.itemIds[0]);
    const signoffId = String((live.data ?? [])[0]?.id);

    const att = await svc
      .from("tenant_attachments")
      .insert({
        org_id: a.orgId,
        target_table: "inspection_signoffs",
        target_id: signoffId,
        filename: "trench.jpg",
        storage_path: `${a.orgId}/inspection_signoffs/${TOKEN}-trench.jpg`,
      })
      .select("id")
      .single();
    // Proves the widened target_table CHECK actually accepts the new target.
    expect(att.error, att.error?.message).toBeNull();

    const del = await svc.from("tenant_attachments").delete().eq("id", String(att.data?.id));
    expect(del.error?.message ?? "").toMatch(/frozen — add new files, never remove or replace one/);
  });

  it("ORG TEARDOWN still commits with plans, items, sign-offs and evidence present", async () => {
    // The 20261052 class: a RESTRICT anywhere on this cascade path, or a
    // delete-guard without the org-existence escape, would abort tenant teardown
    // (and therefore GDPR erasure) for every org that ever ran an inspection.
    const svc = db(serviceClient());
    const before = await svc.from("inspection_test_plans").select("id").eq("org_id", b.orgId);
    expect((before.data ?? []).length).toBeGreaterThan(0);

    // Give org B a sign-off + evidence first, so the teardown has the full chain.
    const sg = await db(userClient(dualToken))
      .from("inspection_signoffs")
      .insert({
        org_id: b.orgId,
        inspection_plan_item_id: b.itemIds[0],
        plan_version: b.reference,
        result: "pass",
        inspected_by: dualUserId,
        signed_name: "B Inspector",
      })
      .select("id")
      .single();
    expect(sg.error, sg.error?.message).toBeNull();
    const ev = await svc.from("tenant_attachments").insert({
      org_id: b.orgId,
      target_table: "inspection_signoffs",
      target_id: String(sg.data?.id),
      filename: "b.jpg",
      storage_path: `${b.orgId}/inspection_signoffs/${TOKEN}-b.jpg`,
    });
    expect(ev.error, ev.error?.message).toBeNull();

    const torn = await svc.from("organizations").delete().eq("id", b.orgId);
    expect(torn.error, torn.error?.message).toBeNull();

    for (const [table, col] of [
      ["inspection_test_plans", "org_id"],
      ["inspection_plan_items", "org_id"],
      ["inspection_signoffs", "org_id"],
    ] as const) {
      const left = await svc.from(table).select("id").eq(col, b.orgId);
      expect(left.data ?? [], `${table} must be gone with the org`).toHaveLength(0);
    }
    const attLeft = await svc.from("tenant_attachments").select("id").eq("org_id", b.orgId);
    expect(attLeft.data ?? []).toHaveLength(0);

    // Mark B as already torn down so afterAll doesn't double-delete.
    b = { ...b, orgId: "" };
  });
});
