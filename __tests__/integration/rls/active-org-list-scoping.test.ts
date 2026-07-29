import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * ACTIVE-ORG SCOPING — the LIST surfaces, proven against real Postgres with a
 * genuine MULTI-ORG user.
 *
 * The last enumerated slice of the defect class fixed by #456 (jobs), #459
 * (finance writes + routes), #461 (rota), #463 (suppliers) and #464 (asset/QR).
 * Those slices pinned by-id reads and writes. What remained was every LIST /
 * collection read: `current_org_ids()` returns EVERY org the viewer belongs to
 * — correct for RLS, which enforces the OUTER boundary — so a list read that
 * carried no org predicate INTERLEAVED both of a dual-org member's companies:
 * one register of plant, one address book, one sales ledger, one dashboard
 * whose every money tile was the SUM of two businesses, one HMRC VAT working
 * paper under one company's letterhead.
 *
 * This is NOT a cross-tenant breach — the viewer is a legitimate member of both
 * orgs. It is a correctness / data-integrity defect.
 *
 * WHAT THIS FILE PROVES, per domain, against real RLS and real JWTs:
 *   1. PREMISE   — the UNPINNED list read really does return the other org's
 *                  row for this user. If that ever stops being true,
 *                  `current_org_ids()` changed and this whole slice should be
 *                  revisited. (Without this the isolation assertions below
 *                  could pass for the wrong reason.)
 *   2. SCOPING   — the pinned read returns ONLY org A's row while A is active.
 *   3. NO OVER-SCOPING — switching the active org to B flips the result, so the
 *                  org switcher still works and nothing is hidden for ever.
 *   4. OUTER BOUNDARY — a member of B only sees B's row and never A's, and an
 *                  anonymous caller sees nothing. The application-layer
 *                  predicate is NOT load-bearing for the security boundary.
 *
 * Coverage: one representative row per domain touched by this slice. Each
 * fixture pair is deliberately NEAR-IDENTICAL — only `org_id` differs — so a
 * passing isolation assertion cannot be an artefact of some other column.
 *
 * The predicate under test is `.eq("org_id", <active org>)`, which is exactly
 * the shape the pages/services now issue (pinned line-by-line in
 * __tests__/security/active-org-list-scoping.test.ts, so the two tiers together
 * cover "the predicate isolates" AND "the shipped code carries it").
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: unknown[]): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-aol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Per-org fixture ids the dependent domains need (customer, job, invoice, …). */
type Deps = {
  orgId: string;
  userId: string;
  customerId: string;
  jobId: string;
  invoiceId: string;
  assetId: string;
  templateId: string;
  bankStatementId: string;
  payrollRunId: string;
  blueprintId: string;
  blueprintVersionId: string;
};

/**
 * The domains this slice pinned. `row` builds a NEAR-IDENTICAL row for whichever
 * org is passed — only tenancy (and the org's own dependency ids) differ.
 *
 * `surface` names the screen the read feeds, so a failure points at a page.
 */
type Domain = {
  /** Human name — also the test title. */
  name: string;
  table: string;
  /** The list surface(s) this read feeds. */
  surface: string;
  row: (d: Deps) => Row;
};

const DOMAINS: Domain[] = [
  {
    name: "assets",
    table: "assets",
    surface: "/assets (the register)",
    row: (d) => ({ org_id: d.orgId, name: `${TOKEN} Hilti TE-70` }),
  },
  {
    name: "asset holdings",
    table: "asset_assignments",
    surface: "/assets/holdings",
    row: (d) => ({
      org_id: d.orgId,
      asset_id: d.assetId,
      assignment_type: "stored_at_depot",
      status: "open",
      location: `${TOKEN} depot`,
    }),
  },
  {
    name: "asset inspections",
    table: "asset_inspections",
    surface: "/assets/inspections",
    row: (d) => ({
      org_id: d.orgId,
      asset_id: d.assetId,
      title: `${TOKEN} LOLER thorough examination`,
      status: "draft",
      due_at: "2026-09-01T09:00:00Z",
    }),
  },
  {
    name: "inspection templates",
    table: "asset_inspection_templates",
    surface: "/assets/templates",
    row: (d) => ({
      org_id: d.orgId,
      family_id: crypto.randomUUID(),
      name: `${TOKEN} Weekly plant check`,
    }),
  },
  {
    name: "jobs",
    table: "jobs",
    surface: "/jobs, /jobs/calendar, /dashboard, /api/schedule",
    row: (d) => ({ org_id: d.orgId, customer_id: d.customerId, notes: `${TOKEN} job` }),
  },
  {
    name: "customers",
    table: "customers",
    surface: "/customers + every customer picker",
    row: (d) => ({ org_id: d.orgId, name: `${TOKEN} Acme Developments` }),
  },
  {
    name: "invoices",
    table: "invoices",
    surface: "/invoices, /tax, /reports, /api/invoices/export",
    // `invoices.total` is GENERATED (amount + vat_total) — set the inputs.
    row: (d) => ({ org_id: d.orgId, number: `${TOKEN}-INV-1`, amount: 1000, vat_total: 200 }),
  },
  {
    name: "quotes",
    table: "quotes",
    surface: "/quotes, /invoices/new",
    row: (d) => ({
      org_id: d.orgId,
      customer_id: d.customerId,
      number: `${TOKEN}-QUO-1`,
      total: 900,
    }),
  },
  {
    name: "leads",
    table: "leads",
    surface: "/leads, /dashboard, the quote builder",
    row: (d) => ({ org_id: d.orgId, source: "web", service: `${TOKEN} groundworks` }),
  },
  {
    name: "finances (expenses)",
    table: "finances",
    surface: "/finances, /tax, /api/finances/export",
    row: (d) => ({ org_id: d.orgId, amount: 250, category: "materials" }),
  },
  {
    name: "purchase orders",
    table: "purchase_orders",
    surface: "/purchase-orders",
    row: (d) => ({ org_id: d.orgId, number: `${TOKEN}-PO-1` }),
  },
  {
    name: "expense drafts",
    table: "expense_drafts",
    surface: "/expenses",
    row: (d) => ({ org_id: d.orgId, status: "extracted", supplier_name: `${TOKEN} Travis` }),
  },
  {
    name: "bank statements",
    table: "bank_statements",
    surface: "/payments",
    row: (d) => ({ org_id: d.orgId, filename: `${TOKEN}-statement.csv` }),
  },
  {
    name: "payroll runs",
    table: "payroll_runs",
    surface: "/payroll",
    row: (d) => ({
      org_id: d.orgId,
      cycle: "monthly",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
    }),
  },
  {
    name: "review requests",
    table: "review_requests",
    surface: "/reviews",
    row: (d) => ({
      org_id: d.orgId,
      customer_id: d.customerId,
      platform: "google",
      send_at: "2026-08-01T09:00:00Z",
    }),
  },
  {
    name: "snags",
    table: "snags",
    surface: "/snags + the blueprint pin panel",
    row: (d) => ({ org_id: d.orgId, job_id: d.jobId, title: `${TOKEN} cracked render` }),
  },
  {
    name: "toolbox talks",
    table: "toolbox_talks",
    surface: "/toolbox",
    row: (d) => ({ org_id: d.orgId, topic: `${TOKEN} working at height`, status: "draft" }),
  },
  {
    name: "site reports",
    table: "site_reports",
    surface: "/site-reports",
    row: (d) => ({
      org_id: d.orgId,
      title: `${TOKEN} week 30 progress`,
      period_start: "2026-07-20",
      period_end: "2026-07-26",
    }),
  },
  {
    name: "site diary",
    table: "site_diary_entries",
    surface: "/diary",
    row: (d) => ({ org_id: d.orgId, job_id: d.jobId, work_summary: `${TOKEN} slab poured` }),
  },
  {
    name: "compliance documents",
    table: "compliance_documents",
    surface: "/compliance",
    row: (d) => ({
      org_id: d.orgId,
      kind: "insurance",
      title: `${TOKEN} public liability`,
      storage_path: `${d.orgId}/${TOKEN}.pdf`,
      expires_at: "2027-01-01",
    }),
  },
  {
    name: "RAMS (risk assessments)",
    table: "risk_assessments",
    surface: "/health-safety + the permit and toolbox pickers",
    row: (d) => ({
      org_id: d.orgId,
      title: `${TOKEN} deep excavation`,
      activity: `${TOKEN} excavation`,
      status: "draft",
    }),
  },
  {
    name: "permits to work",
    table: "permits_to_work",
    surface: "/health-safety/permits",
    row: (d) => ({
      org_id: d.orgId,
      permit_type: "hot_works",
      title: `${TOKEN} roof torch-on`,
      scope: `${TOKEN} scope`,
      status: "draft",
    }),
  },
  {
    name: "inbound enquiries",
    table: "inbound_enquiries",
    surface: "/inbox",
    row: (d) => ({ org_id: d.orgId, channel: "phone", raw_text: `${TOKEN} enquiry` }),
  },
  {
    name: "activity log",
    table: "activity_log",
    surface: "/activity + /api/activity + the dashboard feed",
    row: (d) => ({
      org_id: d.orgId,
      action: "job.created",
      target_table: "jobs",
      target_id: d.jobId,
      actor_name: `${TOKEN} actor`,
    }),
  },
  {
    name: "imports",
    table: "imports",
    surface: "/imports",
    row: (d) => ({ org_id: d.orgId, name: `${TOKEN} customers.csv` }),
  },
  {
    name: "time entries",
    table: "time_entries",
    surface: "/me and /staff/[id]/timesheet",
    row: (d) => ({
      org_id: d.orgId,
      user_id: d.userId,
      started_at: "2026-07-27T08:00:00Z",
      ended_at: "2026-07-27T16:00:00Z",
    }),
  },
  {
    name: "rota entries",
    table: "rota_entries",
    surface: "/me (today's shift)",
    row: (d) => ({
      org_id: d.orgId,
      user_id: d.userId,
      starts_at: "2026-07-28T08:00:00Z",
      ends_at: "2026-07-28T16:00:00Z",
    }),
  },
  {
    name: "leave requests",
    table: "leave_requests",
    surface: "/me (upcoming leave)",
    row: (d) => ({
      org_id: d.orgId,
      user_id: d.userId,
      type: "holiday",
      starts_at: "2026-08-10",
      ends_at: "2026-08-14",
      status: "approved",
    }),
  },
  {
    name: "notifications",
    table: "notifications",
    surface: "the shell bell + /notifications",
    row: (d) => ({
      org_id: d.orgId,
      user_id: d.userId,
      audience: "customer",
      type: "invoice_overdue",
      title: `${TOKEN} invoice overdue`,
    }),
  },
  {
    name: "support tickets",
    table: "support_tickets",
    surface: "/support",
    row: (d) => ({ org_id: d.orgId, subject: `${TOKEN} cannot send invoice` }),
  },
  {
    name: "properties",
    table: "properties",
    surface: "the quote builder site picker",
    row: (d) => ({
      org_id: d.orgId,
      customer_id: d.customerId,
      address: { line1: `${TOKEN} 1 High Street`, postcode: "M1 1AA" },
    }),
  },
  {
    name: "blueprints",
    table: "blueprints",
    surface: "the job drawing register",
    row: (d) => ({
      org_id: d.orgId,
      job_id: d.jobId,
      drawing_number: `${TOKEN}-A-101`,
      title: `${TOKEN} GA plan`,
    }),
  },
  {
    name: "blueprint pins",
    table: "blueprint_pins",
    surface: "the drawing pin overlay",
    row: (d) => ({
      org_id: d.orgId,
      job_id: d.jobId,
      blueprint_version_id: d.blueprintVersionId,
      page_number: 1,
      u: 0.5,
      v: 0.5,
      kind: "note",
      note: `${TOKEN} check level here`,
    }),
  },
  {
    name: "memberships (staff pickers)",
    table: "memberships",
    surface: "/staff, the assignee pickers, the dashboard team tile",
    // The dual user's own membership row exists in BOTH orgs already — that IS
    // the fixture. `seedId` is resolved specially in beforeAll.
    row: (d) => ({ org_id: d.orgId, user_id: d.userId }),
  },
];

/** Domains whose fixture row is created by setup rather than by `row()`. */
const PRE_SEEDED = new Set(["memberships (staff pickers)"]);

describeIntegration("active-org scoping · LIST surfaces (multi-org user)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Owner of BOTH orgs — the blend probe. Works "in" org A. */
  let dual = { id: "", token: "" };
  /** Member of org B ONLY — the RLS outer-boundary control. */
  let outsider = { id: "", token: "" };

  let depsA: Deps;
  let depsB: Deps;

  /** domain name → { a: id in org A, b: id in org B } */
  const fixtures = new Map<string, { a: string; b: string }>();

  async function insId(table: string, row: Row): Promise<string> {
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
    await svc.from("users").insert({ id, email, full_name: email });
    for (const orgId of orgIds) {
      const m = await svc.from("memberships").insert({ org_id: orgId, user_id: id, role: "owner" });
      expect(m.error, m.error?.message).toBeNull();
    }
    const token =
      (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ??
      "";
    if (!id || !token) throw new Error(`failed to make user ${suffix}`);
    return { id, token };
  }

  /** Build the per-org dependency graph the dependent domains need. */
  async function seedDeps(orgId: string, userId: string): Promise<Deps> {
    const customerId = await insId("customers", {
      org_id: orgId,
      name: `${TOKEN} dep customer`,
    });
    const jobId = await insId("jobs", { org_id: orgId, customer_id: customerId });
    const invoiceId = await insId("invoices", {
      org_id: orgId,
      number: `${TOKEN}-DEP-INV`,
      amount: 100,
    });
    const assetId = await insId("assets", { org_id: orgId, name: `${TOKEN} dep asset` });
    const templateId = await insId("asset_inspection_templates", {
      org_id: orgId,
      family_id: crypto.randomUUID(),
      name: `${TOKEN} dep template`,
    });
    const bankStatementId = await insId("bank_statements", {
      org_id: orgId,
      filename: `${TOKEN}-dep.csv`,
    });
    const payrollRunId = await insId("payroll_runs", {
      org_id: orgId,
      cycle: "monthly",
      period_start: "2026-06-01",
      period_end: "2026-06-30",
    });
    const blueprintId = await insId("blueprints", {
      org_id: orgId,
      job_id: jobId,
      drawing_number: `${TOKEN}-DEP-A-001`,
      title: `${TOKEN} dep drawing`,
    });
    const blueprintVersionId = await insId("blueprint_versions", {
      blueprint_id: blueprintId,
      org_id: orgId,
      version: 1,
      revision: "P1",
      storage_path: `${orgId}/${jobId}/${blueprintId}/${TOKEN}.pdf`,
      file_name: `${TOKEN}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 1024,
    });
    return {
      orgId,
      userId,
      customerId,
      jobId,
      invoiceId,
      assetId,
      templateId,
      bankStatementId,
      payrollRunId,
      blueprintId,
      blueprintVersionId,
    };
  }

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "List Scoping A", slug: `${TOKEN}-a` });
    orgB = await insId("organizations", { name: "List Scoping B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    depsA = await seedDeps(orgA, dual.id);
    depsB = await seedDeps(orgB, dual.id);

    for (const domain of DOMAINS) {
      if (PRE_SEEDED.has(domain.name)) continue;
      const a = await insId(domain.table, domain.row(depsA));
      const b = await insId(domain.table, domain.row(depsB));
      fixtures.set(domain.name, { a, b });
    }

    // memberships: the dual user's OWN rows, one per org, created by mkUser.
    const mine = await svc
      .from("memberships")
      .select("id, org_id")
      .eq("user_id", dual.id);
    const rows = (mine.data ?? []) as Array<{ id: string; org_id: string }>;
    const mA = rows.find((r) => r.org_id === orgA)?.id ?? "";
    const mB = rows.find((r) => r.org_id === orgB)?.id ?? "";
    expect(mA && mB, "the dual user must hold a membership in BOTH orgs").toBeTruthy();
    fixtures.set("memberships (staff pickers)", { a: mA, b: mB });
  }, 120_000);

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    }
    for (const u of [dual, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  }, 120_000);

  /** Ids this run created in `table`, as seen by `client` under `where`. */
  async function idsSeen(
    client: unknown,
    table: string,
    where: { orgId?: string },
    onlyIds: string[],
  ): Promise<string[]> {
    let q = db(client).from(table).select("id").in("id", onlyIds);
    if (where.orgId) q = q.eq("org_id", where.orgId);
    const { data, error } = await q;
    expect(error, `${table}: ${error?.message}`).toBeNull();
    return ((data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
  }

  for (const domain of DOMAINS) {
    const both = () => {
      const f = fixtures.get(domain.name);
      if (!f) throw new Error(`no fixture for ${domain.name}`);
      return [f.a, f.b];
    };

    // ------------------------------------------------------------- premise
    it(`${domain.name}: the UNPINNED list read really does return BOTH orgs' rows`, async () => {
      const f = fixtures.get(domain.name)!;
      const seen = await idsSeen(userClient(dual.token), domain.table, {}, both());
      expect(
        seen,
        `RLS is deliberately permissive across memberships — if ${domain.table} no ` +
          `longer blends here, current_org_ids() changed and ${domain.surface} should be revisited`,
      ).toEqual(expect.arrayContaining([f.a, f.b]));
    });

    // ------------------------------------------------------------- scoping
    it(`${domain.name}: pinned to the ACTIVE org, the list returns ONLY org A's row (${domain.surface})`, async () => {
      const f = fixtures.get(domain.name)!;
      const seen = await idsSeen(userClient(dual.token), domain.table, { orgId: orgA }, both());
      expect(seen).toContain(f.a);
      expect(seen, `org B's row appeared on ${domain.surface} inside org A`).not.toContain(f.b);
    });

    // ------------------------------------------------------ no over-scoping
    it(`${domain.name}: switching the active org to B flips the list (the org switcher still works)`, async () => {
      const f = fixtures.get(domain.name)!;
      // Same client, same JWT, different active org.
      const seen = await idsSeen(userClient(dual.token), domain.table, { orgId: orgB }, both());
      expect(seen, "org B's own row must be reachable when B is active").toContain(f.b);
      expect(seen).not.toContain(f.a);
    });

    // ------------------------------------------------------ outer boundary
    it(`${domain.name}: RLS is untouched — a non-member of A never sees A's row, anon sees nothing`, async () => {
      // The outsider belongs to org B only. Even asking for org A explicitly,
      // RLS returns nothing — the app predicate is not the security boundary.
      const asksForA = await idsSeen(
        userClient(outsider.token),
        domain.table,
        { orgId: orgA },
        both(),
      );
      expect(asksForA, "RLS must refuse a non-member regardless of the app predicate").toEqual([]);

      const anon = await idsSeen(anonClient(), domain.table, {}, both());
      expect(anon, "an anonymous caller must see nothing").toEqual([]);
    });
  }

  // -------------------------------------------------------------------------
  // Cross-cutting: the two aggregate surfaces where the blend was arithmetic
  // (a wrong NUMBER, not just an extra row) rather than a listing defect.
  // -------------------------------------------------------------------------

  it("money aggregates: the unpinned invoice total SUMS both companies; the pinned one does not", async () => {
    const inv = fixtures.get("invoices")!;
    const ids = [inv.a, inv.b];

    const blended = await db(userClient(dual.token))
      .from("invoices")
      .select("total")
      .in("id", ids);
    const blendedSum = ((blended.data ?? []) as Array<{ total: number | string }>).reduce(
      (s, r) => s + Number(r.total ?? 0),
      0,
    );
    // 1200 (A) + 1200 (B) — the figure /dashboard, /tax and /reports rendered.
    expect(blendedSum, "the premise: the unpinned read really does double the money").toBe(2400);

    const pinned = await db(userClient(dual.token))
      .from("invoices")
      .select("total")
      .eq("org_id", orgA)
      .in("id", ids);
    const pinnedSum = ((pinned.data ?? []) as Array<{ total: number | string }>).reduce(
      (s, r) => s + Number(r.total ?? 0),
      0,
    );
    expect(pinnedSum, "one company's revenue, not two").toBe(1200);
  });

  it("exact counts: the count that drives pagination is the ACTIVE org's, not the blend", async () => {
    // /jobs, /customers, /invoices, /quotes, /finances and /activity all render
    // an EXACT count and paginate over it, so an unpinned count did not merely
    // add rows — it produced page links to another company's data.
    const job = fixtures.get("jobs")!;
    const ids = [job.a, job.b];
    const client = userClient(dual.token) as unknown as {
      from: (t: string) => {
        select: (
          c: string,
          o: { count: "exact"; head: true },
        ) => {
          in: (k: string, v: unknown[]) => PromiseLike<{ count: number | null }>;
          eq: (k: string, v: unknown) => {
            in: (k: string, v: unknown[]) => PromiseLike<{ count: number | null }>;
          };
        };
      };
    };

    const blended = await client.from("jobs").select("id", { count: "exact", head: true }).in("id", ids);
    expect(blended.count, "the premise: the unpinned count spans both orgs").toBe(2);

    const pinned = await client
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgA)
      .in("id", ids);
    expect(pinned.count, "the headline count must be one company's").toBe(1);
  });

  it("ordering and limits are preserved by the pin (behaviour is unchanged apart from tenancy)", async () => {
    // The slice's contract: same ordering, same limits — only the org predicate
    // is added. Two org-A assets ordered `created_at desc` must come back in
    // that order with the pin applied, and org B's must not be interleaved.
    const extraA = await insId("assets", { org_id: orgA, name: `${TOKEN} second A asset` });
    const asset = fixtures.get("assets")!;
    const ids = [asset.a, asset.b, extraA];

    const { data, error } = await db(userClient(dual.token))
      .from("assets")
      .select("id")
      .eq("org_id", orgA)
      .in("id", ids)
      .order("created_at", { ascending: false });
    expect(error, error?.message).toBeNull();
    const seen = ((data ?? []) as Array<{ id: string }>).map((r) => String(r.id));
    expect(seen, "newest-first, org A only").toEqual([extraA, asset.a]);
  });
});
