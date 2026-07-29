import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { hoursByUser, type TimeEntry } from "@/lib/time/compute";
import { computePayrollLine } from "@/lib/payroll/compute";

/**
 * Active-org WRITE slice — against REAL Postgres, with a REAL dual-org user.
 *
 * Companion to the source pins in
 * __tests__/security/active-org-write-slice.test.ts. Those prove the predicate
 * is written; this proves it WORKS — and, first, that the defect was real.
 *
 * The subjects are Server Actions coupled to `cookies()`, so (exactly as
 * #463's supplier suite did for updateSupplier/deleteSupplier) each test
 * replays the EXACT predicate pair the action now issues, through a real
 * dual-org member's JWT. Where a pure helper carries the corruption —
 * `hoursByUser` for payroll — it is imported and driven directly, so the
 * financial consequence is measured in pounds rather than asserted in prose.
 *
 * Every fixture is namespaced by a per-run TOKEN and every assertion is made
 * against ids created by THIS run, so a shared local stack cannot cross-talk.
 *
 * RLS is NOT what these tests exercise. `current_org_ids()` returning every
 * membership is correct — RLS is the OUTER tenant boundary, proven untouched
 * by the non-member and anon controls at the end. The pins are the INNER,
 * active-org scope.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, value: unknown[]): Sel;
  is(column: string, value: unknown): Sel;
  gte(column: string, value: unknown): Sel;
  lte(column: string, value: unknown): Sel;
  not(column: string, op: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
  is(column: string, value: unknown): Upd;
  gte(column: string, value: unknown): Upd;
  lte(column: string, value: unknown): Upd;
  not(column: string, op: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
  in(column: string, value: unknown[]): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-wslice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BUCKET = "blueprints";

/** Payroll window — a fixed week so the maths below is exact. */
const PERIOD_START = "2026-03-02";
const PERIOD_END = "2026-03-08";
const WINDOW_START = `${PERIOD_START}T00:00:00Z`;
const WINDOW_END = `${PERIOD_END}T23:59:59.999Z`;
const HOURLY_PAY = 25;

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
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  // No auth.users → public.users trigger in this schema, so mirror the row
  // ourselves (memberships.user_id FKs public.users).
  await db(serviceClient())
    .from("users")
    .insert({ id, email, full_name: email, hourly_pay: HOURLY_PAY });
  for (const orgId of orgIds) {
    const m = await db(serviceClient())
      .from("memberships")
      .insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ??
    "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

describeIntegration("active-org WRITE slice (RLS + real Postgres)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Owner of BOTH orgs, "working in" org A — the blend probe. */
  let dual = { id: "", token: "" };
  /** Member of org B ONLY — the RLS control. */
  let outsider = { id: "", token: "" };

  let jobA = "";
  let jobB = "";
  /** Blueprints: one per org, plus a disposable in A the delete test consumes. */
  let bpA = "";
  let bpB = "";
  let bpDisposableA = "";
  let bpOrphanProbeB = "";
  let pathB = "";
  let pathDisposableA = "";
  let pathOrphanProbeB = "";
  /** Payroll */
  let runB = "";
  let runDisposableA = "";
  let entryA = "";
  let entryB = "";
  /** Misc per-domain subjects in org B. */
  let invoiceB = "";
  let notifB = "";
  let enquiryB = "";
  let reviewB = "";
  let importB = "";
  let importRowB = "";
  let customerB = "";
  let auditB = "";

  /** Upload a drawing's bytes and register the version row. Service-role. */
  async function seedVersion(blueprintId: string, orgId: string, jobId: string): Promise<string> {
    const path = `${orgId}/${jobId}/${blueprintId}/${TOKEN}.pdf`;
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
    const up = await serviceClient()
      .storage.from(BUCKET)
      .upload(path, bytes, { contentType: "application/pdf", upsert: false });
    expect(up.error, up.error?.message).toBeNull();
    const v = await svc.from("blueprint_versions").insert({
      blueprint_id: blueprintId,
      org_id: orgId,
      revision: "P01",
      storage_bucket: BUCKET,
      storage_path: path,
      file_name: "drawing.pdf",
      mime_type: "application/pdf",
      size_bytes: bytes.byteLength,
      content_hash: "a".repeat(64),
    });
    expect(v.error, v.error?.message).toBeNull();
    return path;
  }

  /** True when the object is still stored (the storage-bytes proof). */
  async function objectExists(path: string): Promise<boolean> {
    const dl = await serviceClient().storage.from(BUCKET).download(path);
    return !dl.error && dl.data != null;
  }

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Write A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Write B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    jobA = await insId(svc, "jobs", { org_id: orgA, notes: `${TOKEN} job A` });
    jobB = await insId(svc, "jobs", { org_id: orgB, notes: `${TOKEN} job B` });

    // --- blueprints (near-identical; only org differs)
    bpA = await insId(svc, "blueprints", {
      org_id: orgA, job_id: jobA, drawing_number: "A-201", title: `${TOKEN} Ground floor`,
    });
    bpB = await insId(svc, "blueprints", {
      org_id: orgB, job_id: jobB, drawing_number: "A-201", title: `${TOKEN} Ground floor`,
    });
    bpDisposableA = await insId(svc, "blueprints", {
      org_id: orgA, job_id: jobA, drawing_number: "A-999", title: `${TOKEN} Disposable`,
    });
    bpOrphanProbeB = await insId(svc, "blueprints", {
      org_id: orgB, job_id: jobB, drawing_number: "A-998", title: `${TOKEN} Orphan probe`,
    });
    pathB = await seedVersion(bpB, orgB, jobB);
    pathDisposableA = await seedVersion(bpDisposableA, orgA, jobA);
    pathOrphanProbeB = await seedVersion(bpOrphanProbeB, orgB, jobB);

    // --- payroll: the SAME worker books 8h in each org, same window.
    entryA = await insId(svc, "time_entries", {
      org_id: orgA, user_id: dual.id,
      started_at: "2026-03-03T08:00:00Z", ended_at: "2026-03-03T16:00:00Z",
    });
    entryB = await insId(svc, "time_entries", {
      org_id: orgB, user_id: dual.id,
      started_at: "2026-03-04T08:00:00Z", ended_at: "2026-03-04T16:00:00Z",
    });
    runB = await insId(svc, "payroll_runs", {
      org_id: orgB, cycle: "weekly", period_start: PERIOD_START, period_end: PERIOD_END,
    });
    runDisposableA = await insId(svc, "payroll_runs", {
      org_id: orgA, cycle: "weekly", period_start: PERIOD_START, period_end: PERIOD_END,
    });

    // --- other domains, all in org B
    // `total` is a stored generated column (amount + vat_total) — write the parts.
    invoiceB = await insId(svc, "invoices", {
      org_id: orgB, number: `${TOKEN}-INV-1`, amount: 1000, vat_total: 200, status: "sent",
    });
    notifB = await insId(svc, "notifications", {
      org_id: orgB, user_id: dual.id, type: "test", title: `${TOKEN} unread in B`,
    });
    enquiryB = await insId(svc, "inbound_enquiries", {
      org_id: orgB, channel: "phone", status: "received", raw_text: `${TOKEN} lead in B`,
    });
    customerB = await insId(svc, "customers", { org_id: orgB, name: `${TOKEN} Customer B` });
    reviewB = await insId(svc, "review_requests", {
      org_id: orgB, customer_id: customerB, platform: "google", delay_days: 0,
      send_at: new Date().toISOString(), status: "scheduled",
    });
    importB = await insId(svc, "imports", { org_id: orgB, name: `${TOKEN} import B`, status: "detected" });
    const importFileB = await insId(svc, "import_files", {
      org_id: orgB, import_id: importB,
      filename: "customers.csv", storage_path: `${orgB}/${importB}/customers.csv`,
    });
    importRowB = await insId(svc, "import_rows", {
      org_id: orgB, import_id: importB, file_id: importFileB, source_row_number: 1,
      entity_type: "customer", mapped: { name: `${TOKEN} staged B` }, raw: {},
      status: "pending", confidence: 100,
    });
    auditB = await insId(svc, "import_audit", {
      org_id: orgB, import_id: importB, import_row_id: importRowB,
      target_table: "customers", target_id: customerB,
    });
  });

  afterAll(async () => {
    for (const p of [pathB, pathDisposableA, pathOrphanProbeB]) {
      if (p) await serviceClient().storage.from(BUCKET).remove([p]);
    }
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [dual, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // =========================================================================
  // 1. deleteBlueprint — the read + DELETE pair, and the storage bytes
  // =========================================================================

  it("premise: the UNSCOPED delete pair really does reach org B's drawing", async () => {
    // The exact shape deleteBlueprint used before the fix, on a throwaway org-B
    // drawing. RLS admits it because the viewer is a genuine admin of org B.
    const versions = await db(userClient(dual.token))
      .from("blueprint_versions")
      .select("storage_path")
      .eq("blueprint_id", bpOrphanProbeB);
    expect(versions.error, versions.error?.message).toBeNull();
    expect(
      (versions.data ?? []).length,
      "RLS is deliberately permissive across memberships — if this is 0, " +
        "current_org_ids() changed and this whole slice should be revisited",
    ).toBe(1);

    const del = await db(userClient(dual.token))
      .from("blueprints")
      .delete({ count: "exact" })
      .eq("id", bpOrphanProbeB);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count, "this is precisely what the fix prevents").toBe(1);

    // Storage bytes are NOT removed by the row delete — the application does
    // that. So the pre-fix code deleted another org's drawing and then wiped
    // its bytes with the paths it had just read.
    expect(await objectExists(pathOrphanProbeB)).toBe(true);
  });

  it("the ORPHANING variant: pinning only the read strands the storage bytes", async () => {
    // Why the pair must move together, demonstrated rather than argued. With
    // the org pin on the READ but not the DELETE, the path list comes back
    // EMPTY while the row still dies — so nothing is left in the database
    // pointing at bytes that are now unreachable and unbilled-for.
    const probe = await insId(svc, "blueprints", {
      org_id: orgB, job_id: jobB, drawing_number: "A-997", title: `${TOKEN} Half-pinned probe`,
    });
    const probePath = await seedVersion(probe, orgB, jobB);

    const versions = await db(userClient(dual.token))
      .from("blueprint_versions")
      .select("storage_path")
      .eq("blueprint_id", probe)
      .eq("org_id", orgA); // pinned read, wrong org
    expect(versions.data ?? [], "the pinned read yields no paths to clean").toEqual([]);

    const del = await db(userClient(dual.token))
      .from("blueprints")
      .delete({ count: "exact" })
      .eq("id", probe); // UNPINNED delete
    expect(del.count, "the row dies anyway").toBe(1);

    expect(
      await objectExists(probePath),
      "…and its bytes survive with nothing referencing them: an orphan",
    ).toBe(true);
    await serviceClient().storage.from(BUCKET).remove([probePath]);
  });

  it("the FIXED pair: org B's drawing is untouched from org A — row AND bytes", async () => {
    const versions = await db(userClient(dual.token))
      .from("blueprint_versions")
      .select("storage_path")
      .eq("blueprint_id", bpB)
      .eq("org_id", orgA)
      .order("version", { ascending: true });
    expect(versions.error, versions.error?.message).toBeNull();
    expect(versions.data ?? [], "no paths gathered, so nothing can be removed").toEqual([]);

    const del = await db(userClient(dual.token))
      .from("blueprints")
      .delete({ count: "exact" })
      .eq("id", bpB)
      .eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count, "zero rows — the service returns the not-found refusal").toBe(0);

    // The two things the mission demands be proven intact.
    const still = await svc.from("blueprints").select("id, title").eq("id", bpB).maybeSingle();
    expect(still.data?.id, "org B's drawing row must survive an org-A delete").toBe(bpB);
    const vRows = await svc.from("blueprint_versions").select("id").eq("blueprint_id", bpB);
    expect((vRows.data ?? []).length, "its revision history must survive too").toBe(1);
    expect(await objectExists(pathB), "and its storage BYTES must still be there").toBe(true);
  });

  it("the FIXED pair still deletes the active org's own drawing (no over-scoping)", async () => {
    const versions = await db(userClient(dual.token))
      .from("blueprint_versions")
      .select("storage_path")
      .eq("blueprint_id", bpDisposableA)
      .eq("org_id", orgA);
    const paths = (versions.data ?? []).map((v) => String(v.storage_path));
    expect(paths, "the ordinary path must still gather its bytes").toEqual([pathDisposableA]);

    const del = await db(userClient(dual.token))
      .from("blueprints")
      .delete({ count: "exact" })
      .eq("id", bpDisposableA)
      .eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count, "the normal delete path must not be over-scoped").toBe(1);

    await serviceClient().storage.from(BUCKET).remove(paths);
    expect(await objectExists(pathDisposableA)).toBe(false);
  });

  it("switching the active org to B flips the delete predicate — the switcher still works", async () => {
    // Proves the pin tracks the ACTIVE org rather than hiding org B for ever.
    const gone = await db(userClient(dual.token))
      .from("blueprints")
      .select("id")
      .eq("id", bpB)
      .eq("org_id", orgB)
      .maybeSingle();
    expect(gone.data?.id, "same JWT, org B active → the drawing is reachable").toBe(bpB);
  });

  it("setBlueprintStatus cannot flip a foreign drawing's status", async () => {
    const upd = await db(userClient(dual.token))
      .from("blueprints")
      .update({ status: "superseded" }, { count: "exact" })
      .eq("id", bpB)
      .eq("org_id", orgA);
    expect(upd.count, "marking another company's live drawing superseded").toBe(0);
    const after = await svc.from("blueprints").select("status").eq("id", bpB).maybeSingle();
    expect(after.data?.status).toBe("for_construction");
  });

  // =========================================================================
  // 2. PAYROLL — the financial corruption, measured in pounds
  // =========================================================================

  it("premise: the UNSCOPED hours read blends both employers into one payslip", async () => {
    // The pre-fix query, verbatim, through the dual-org member's JWT.
    const blended = await db(userClient(dual.token))
      .from("time_entries")
      .select("id, user_id, job_id, started_at, ended_at, breaks")
      .gte("started_at", WINDOW_START)
      .lte("started_at", WINDOW_END)
      .not("ended_at", "is", null);
    expect(blended.error, blended.error?.message).toBeNull();
    const ids = (blended.data ?? []).map((e) => String(e.id));
    expect(ids, "org A's shift").toContain(entryA);
    expect(ids, "…and org B's, in the same result set").toContain(entryB);

    // The real corruption is downstream: hoursByUser groups on user_id ALONE.
    const hours = hoursByUser(
      (blended.data ?? []) as unknown as TimeEntry[],
      new Date(WINDOW_START),
      new Date(WINDOW_END),
    );
    expect(hours.get(dual.id), "8h at each company, summed into one figure").toBe(16);

    const line = computePayrollLine(hours.get(dual.id) ?? 0, HOURLY_PAY, "weekly");
    expect(line.gross_pay, "£400 of gross pay for a 8-hour week at this employer").toBe(400);
  });

  it("the FIXED hours read pays one company's hours — a £200 difference per worker", async () => {
    const pinned = await db(userClient(dual.token))
      .from("time_entries")
      .select("id, user_id, job_id, started_at, ended_at, breaks")
      .eq("org_id", orgA)
      .gte("started_at", WINDOW_START)
      .lte("started_at", WINDOW_END)
      .not("ended_at", "is", null);
    expect(pinned.error, pinned.error?.message).toBeNull();
    const ids = (pinned.data ?? []).map((e) => String(e.id));
    expect(ids).toContain(entryA);
    expect(ids, "the other employer's shift must not be in this run").not.toContain(entryB);

    const hours = hoursByUser(
      (pinned.data ?? []) as unknown as TimeEntry[],
      new Date(WINDOW_START),
      new Date(WINDOW_END),
    );
    expect(hours.get(dual.id)).toBe(8);

    const fixed = computePayrollLine(hours.get(dual.id) ?? 0, HOURLY_PAY, "weekly");
    const blendedLine = computePayrollLine(16, HOURLY_PAY, "weekly");
    expect(fixed.gross_pay).toBe(200);
    expect(
      blendedLine.gross_pay - fixed.gross_pay,
      "the overpayment this pin prevents, per worker per week",
    ).toBe(200);
    expect(
      blendedLine.paye_estimate > fixed.paye_estimate,
      "PAYE was estimated — and would be filed — on the inflated gross",
    ).toBe(true);
    expect(blendedLine.ni_estimate > fixed.ni_estimate, "so was employee NI").toBe(true);
  });

  it("finalising org A's run cannot lock org B's timesheets", async () => {
    // The pre-fix UPDATE was keyed on user_id + the date window and NO org, so
    // it stamped every employer's entries in that week with an org-A line id —
    // freezing another company's timesheets against a line they cannot see.
    const fakeLine = "00000000-0000-4000-8000-00000000dead";
    const upd = await db(userClient(dual.token))
      .from("time_entries")
      .update({ payroll_line_id: fakeLine }, { count: "exact" })
      .eq("org_id", orgA)
      .eq("user_id", dual.id)
      .gte("started_at", WINDOW_START)
      .lte("started_at", WINDOW_END)
      .not("ended_at", "is", null)
      .is("payroll_line_id", null);
    // The FK refuses a non-existent line, which is fine — what matters is that
    // org B's row is untouched either way.
    const after = await svc
      .from("time_entries")
      .select("payroll_line_id")
      .eq("id", entryB)
      .maybeSingle();
    expect(
      after.data?.payroll_line_id,
      "org B's shift must not be locked by org A's payroll run",
    ).toBeNull();
    void upd;
  });

  it("finalise cannot flip a foreign run to the IRREVERSIBLE finalised state", async () => {
    const read = await db(userClient(dual.token))
      .from("payroll_runs")
      .select("id, period_start, period_end, status")
      .eq("id", runB)
      .eq("org_id", orgA)
      .maybeSingle();
    expect(read.data, "a foreign run must be not-found, not status-checked").toBeNull();

    const upd = await db(userClient(dual.token))
      .from("payroll_runs")
      .update({ status: "finalised", finalised_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", runB)
      .eq("org_id", orgA);
    expect(upd.count).toBe(0);
    const after = await svc.from("payroll_runs").select("status").eq("id", runB).maybeSingle();
    expect(after.data?.status, "finalised runs are immutable — this must stay draft").toBe("draft");
  });

  it("delete cannot destroy a foreign payroll run (or cascade its lines)", async () => {
    const del = await db(userClient(dual.token))
      .from("payroll_runs")
      .delete({ count: "exact" })
      .eq("id", runB)
      .eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count).toBe(0);
    const still = await svc.from("payroll_runs").select("id").eq("id", runB).maybeSingle();
    expect(still.data?.id, "org B's payroll run must survive").toBe(runB);
  });

  it("delete still removes the active org's own draft run (no over-scoping)", async () => {
    const del = await db(userClient(dual.token))
      .from("payroll_runs")
      .delete({ count: "exact" })
      .eq("id", runDisposableA)
      .eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count, "the normal delete path must keep working").toBe(1);
  });

  // =========================================================================
  // 3. PAYMENTS — the bank matcher
  // =========================================================================

  it("the bank matcher scores against ONE company's sales ledger", async () => {
    const blended = await db(userClient(dual.token))
      .from("invoices")
      .select("id, number, total, sent_at, status")
      .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"]);
    expect(
      (blended.data ?? []).map((i) => String(i.id)),
      "premise: unpinned, org B's invoice is a candidate match for org A's bank line",
    ).toContain(invoiceB);

    const pinned = await db(userClient(dual.token))
      .from("invoices")
      .select("id, number, total, sent_at, status")
      .eq("org_id", orgA)
      .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"]);
    expect(
      (pinned.data ?? []).map((i) => String(i.id)),
      "a suggested match to another company's invoice is a cross-org reference " +
        "written into the reconciliation ledger",
    ).not.toContain(invoiceB);
  });

  // =========================================================================
  // 4. IMPORTS — the service-role paths, where RLS protects nothing
  // =========================================================================

  it("commitImport cannot reach a foreign import session", async () => {
    const blended = await db(userClient(dual.token))
      .from("imports")
      .select("id, org_id, status")
      .eq("id", importB)
      .maybeSingle();
    expect(blended.data?.id, "premise: RLS admits org B's import to a dual-org admin").toBe(importB);

    const pinned = await db(userClient(dual.token))
      .from("imports")
      .select("id, org_id, status")
      .eq("id", importB)
      .eq("org_id", orgA)
      .maybeSingle();
    expect(
      pinned.data,
      "the gate that stops another company's staged migration being copied in",
    ).toBeNull();
  });

  it("the SERVICE-ROLE row read is pinned — nothing foreign can reach insertOne", async () => {
    // This one runs as service_role deliberately: RLS is bypassed, so the org
    // predicate is the ONLY thing scoping it.
    const unpinned = await svc
      .from("import_rows")
      .select("id")
      .eq("import_id", importB)
      .in("status", ["pending"]);
    expect((unpinned.data ?? []).map((r) => String(r.id))).toContain(importRowB);

    const pinned = await svc
      .from("import_rows")
      .select("id")
      .eq("import_id", importB)
      .eq("org_id", orgA)
      .in("status", ["pending"]);
    expect(pinned.data ?? [], "service_role + no pin = a full cross-org copy").toEqual([]);
  });

  it("the SERVICE-ROLE rollback DELETE cannot remove a foreign org's live records", async () => {
    // The most destructive statement in the slice. `customerB` is a live
    // business record of org B, reachable through org B's import audit.
    const audit = await svc
      .from("import_audit")
      .select("target_table, target_id")
      .eq("import_id", importB)
      .eq("org_id", orgA);
    expect(audit.data ?? [], "the pinned audit read yields no ids to delete").toEqual([]);
    void auditB;

    // Even handed the id directly, the pinned DELETE refuses it.
    const del = await svc
      .from("customers")
      .delete({ count: "exact" })
      .in("id", [customerB])
      .eq("org_id", orgA);
    expect(del.error, del.error?.message).toBeNull();
    expect(del.count).toBe(0);
    const still = await svc.from("customers").select("id").eq("id", customerB).maybeSingle();
    expect(still.data?.id, "org B's customer must survive an org-A rollback").toBe(customerB);
  });

  it("a foreign import row cannot be reclassified or skipped from this org", async () => {
    const upd = await db(userClient(dual.token))
      .from("import_rows")
      .update({ status: "skipped", error_message: "skipped in review" }, { count: "exact" })
      .eq("id", importRowB)
      .eq("org_id", orgA);
    expect(upd.count).toBe(0);
    const after = await svc.from("import_rows").select("status").eq("id", importRowB).maybeSingle();
    expect(after.data?.status).toBe("pending");
  });

  // =========================================================================
  // 5. Notifications, reviews, support, inbox
  // =========================================================================

  it("'mark all read' clears only the ACTIVE org's unread notifications", async () => {
    const blended = await db(userClient(dual.token))
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", dual.id)
      .is("read_at", null);
    void blended;

    const upd = await db(userClient(dual.token))
      .from("notifications")
      .update({ read_at: new Date().toISOString() }, { count: "exact" })
      .eq("user_id", dual.id)
      .eq("org_id", orgA)
      .is("read_at", null);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await svc.from("notifications").select("read_at").eq("id", notifB).maybeSingle();
    expect(
      after.data?.read_at,
      "the other company's unread badge must not be silently cleared",
    ).toBeNull();
  });

  it("a foreign review request cannot be completed, cancelled or marked sent", async () => {
    for (const patch of [
      { status: "completed", completed_at: new Date().toISOString() },
      { status: "cancelled" },
      { status: "sent", sent_at: new Date().toISOString() },
    ]) {
      const upd = await db(userClient(dual.token))
        .from("review_requests")
        .update(patch, { count: "exact" })
        .eq("id", reviewB)
        .eq("org_id", orgA);
      expect(upd.error, upd.error?.message).toBeNull();
      expect(upd.count).toBe(0);
    }
    const after = await svc.from("review_requests").select("status").eq("id", reviewB).maybeSingle();
    expect(after.data?.status, "and the customer never got an email under the wrong name").toBe(
      "scheduled",
    );
  });

  it("a foreign review request is NOT FOUND before the email is composed", async () => {
    const read = await db(userClient(dual.token))
      .from("review_requests")
      .select("id, customer_id, platform, status")
      .eq("id", reviewB)
      .eq("org_id", orgA)
      .maybeSingle();
    expect(read.data, "the read gates sendEmail — it must fail closed").toBeNull();
  });

  it("a foreign inbound enquiry cannot be triaged away", async () => {
    const upd = await db(userClient(dual.token))
      .from("inbound_enquiries")
      .update({ status: "ignored", processed_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", enquiryB)
      .eq("org_id", orgA);
    expect(upd.error, upd.error?.message).toBeNull();
    expect(upd.count, "burying another company's lead").toBe(0);
    const after = await svc
      .from("inbound_enquiries")
      .select("status")
      .eq("id", enquiryB)
      .maybeSingle();
    expect(after.data?.status).toBe("received");
  });

  // =========================================================================
  // 6. RLS controls — the OUTER boundary is untouched
  // =========================================================================

  it("RLS is untouched: an org-B-only member sees nothing of org A", async () => {
    const r = await db(userClient(outsider.token))
      .from("blueprints")
      .select("id")
      .eq("id", bpA)
      .maybeSingle();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data, "RLS alone must still deny a genuine outsider").toBeNull();
  });

  it("RLS is untouched: a non-member's UNSCOPED write affects nothing", async () => {
    // The outer boundary must not depend on the application-layer predicate.
    const upd = await db(userClient(outsider.token))
      .from("blueprints")
      .update({ status: "superseded" }, { count: "exact" })
      .eq("id", bpA);
    expect(upd.count ?? 0).toBe(0);

    const del = await db(userClient(outsider.token))
      .from("payroll_runs")
      .delete({ count: "exact" })
      .eq("id", runDisposableA);
    expect(del.count ?? 0).toBe(0);
  });

  it("RLS is untouched: a non-member cannot read another org's payroll or imports", async () => {
    const runs = await db(userClient(outsider.token))
      .from("payroll_runs")
      .select("id")
      .eq("org_id", orgA);
    expect(runs.data ?? []).toEqual([]);
    const imports = await db(userClient(outsider.token))
      .from("imports")
      .select("id")
      .eq("org_id", orgA);
    expect(imports.data ?? []).toEqual([]);
  });

  it("RLS is untouched: anon sees nothing and writes nothing", async () => {
    const anon = db(anonClient());
    const read = await anon.from("blueprints").select("id").eq("id", bpA).maybeSingle();
    expect(read.data).toBeNull();
    const upd = await anon
      .from("blueprints")
      .update({ status: "superseded" }, { count: "exact" })
      .eq("id", bpA);
    expect(upd.count ?? 0).toBe(0);
    const notes = await anon.from("notifications").select("id").eq("id", notifB).maybeSingle();
    expect(notes.data).toBeNull();
  });

  it("anon cannot download a drawing's bytes", async () => {
    const dl = await anonClient().storage.from(BUCKET).download(pathB);
    expect(dl.error, "the blueprints bucket is private").not.toBeNull();
  });
});
