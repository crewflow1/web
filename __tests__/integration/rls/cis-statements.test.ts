import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * H2-CIS M4 — statements and the monthly return dataset, against REAL Postgres
 * (20261055000000).
 *
 * HMRC rules verified 28 July 2026 — docs/cis-domain.md §11.
 *
 * The properties under test are the ones that make a tax DOCUMENT trustworthy
 * rather than merely produced:
 *
 *   1. RECONCILIATION — a statement's totals ARE the ledger it derives from,
 *                       enforced at COMMIT for every role including service_role.
 *   2. IMMUTABILITY   — an issued statement never moves. Correction is a
 *                       REPLACEMENT that supersedes, never an edit.
 *   3. VOID HANDLING  — a voided payment makes a statement detectably stale via
 *                       the ledger fingerprint; it does not silently rewrite it.
 *   4. TENANCY        — admin-only, and a member of TWO orgs cannot blend them.
 *   5. HONESTY        — no verification number is invented; no state claims a
 *                       return was filed; a nil month is a real row.
 *
 * Fixtures are tagged with a per-run TOKEN so the suite is residue-independent.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  is(c: string, v: unknown): Sel;
  order(c: string, o?: { ascending?: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row): Ins;
  update(v: Row): Upd;
  delete(): Del;
  upsert(r: Row, o?: { onConflict?: string }): PromiseLike<Res<null>>;
}
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res<unknown>>;
const db = (c: unknown) => c as unknown as { from(t: string): Table; rpc: Rpc };

const T = `it-cism4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const num = (v: unknown): number => Number(v ?? 0);
const p2 = (n: number): number => Math.round(n * 100) / 100;

/** The 6 Jul – 5 Aug 2026 CIS tax month. */
const MONTH_END = "2026-08-05";
const MONTH_START = "2026-07-06";
/** The PREVIOUS tax month, 6 Jun – 5 Jul 2026. */
const PREV_MONTH_END = "2026-07-05";

describeIntegration("H2-CIS M4 statements + monthly return (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let sub20 = "";
  let sub30 = "";
  let subGross = "";
  let subB = "";
  let admin = { id: "", token: "" };
  let member = { id: "", token: "" };
  let adminB = { id: "", token: "" };
  let dual = { id: "", token: "" };

  const svc = () => db(serviceClient());
  const asAdmin = () => db(userClient(admin.token));
  const asMember = () => db(userClient(member.token));
  const asAdminB = () => db(userClient(adminB.token));
  const asDual = () => db(userClient(dual.token));

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

  async function mkSupplier(org: string, name: string) {
    const r = await svc().from("suppliers").insert({ org_id: org, name: `${T} ${name}` }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function mkCis(org: string, supplier: string, status: string, name: string, ref: string | null) {
    const outcome = ["gross", "standard_20", "higher_30", "failed"].includes(status);
    const r = await svc().from("cis_subcontractors").insert({
      org_id: org,
      supplier_id: supplier,
      legal_name: `${name} Ltd`,
      utr: "1234567890",
      cis_status: status,
      verified_at: outcome ? "2026-06-01" : null,
      verification_reference: outcome ? ref : null,
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  async function mkBill(org: string, supplier: string, amount: number, vatRate = 0) {
    const r = await svc()
      .from("finances")
      .insert({
        org_id: org,
        supplier_id: supplier,
        amount,
        vat_rate: vatRate,
        category: "subcontractor",
        reference: `${T}-bill`,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function setDetails(org: string, supplier: string, finance: string, materials: number) {
    const r = await svc()
      .from("cis_bill_details")
      .upsert(
        { org_id: org, finance_id: finance, supplier_id: supplier, materials_amount: materials },
        { onConflict: "org_id,finance_id" },
      );
    expect(r.error, r.error?.message).toBeNull();
  }

  /** Post a CIS payment through M3's RPC. Returns the payment id. */
  async function pay(
    org: string,
    supplier: string,
    lines: Array<{ finance_id: string; amount: number }>,
    paidAt: string,
  ) {
    const r = await asAdmin().rpc("record_cis_supplier_payment", {
      p_org_id: org,
      p_supplier_id: supplier,
      p_paid_at: paidAt,
      p_method: "bank_transfer",
      p_reference: null,
      p_notes: null,
      p_allocations: lines,
      p_expected_rate: null,
    });
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data);
  }

  async function issue(client: ReturnType<typeof db>, org: string, supplier: string, monthEnd: string) {
    return client.rpc("issue_cis_statement", {
      p_org_id: org,
      p_supplier_id: supplier,
      p_tax_month_end: monthEnd,
    });
  }

  async function prepare(client: ReturnType<typeof db>, org: string, monthEnd: string) {
    return client.rpc("prepare_cis_monthly_return", {
      p_org_id: org,
      p_tax_month_end: monthEnd,
    });
  }

  async function statementRow(id: string) {
    const r = await svc().from("cis_statements").select("*").eq("id", id).maybeSingle();
    return r.data ?? {};
  }

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "M4 A", slug: `${T}-a` }).select("id").single()).data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "M4 B", slug: `${T}-b` }).select("id").single()).data?.id,
    );

    sub20 = await mkSupplier(orgA, "Groundworks");
    sub30 = await mkSupplier(orgA, "Roofing");
    subGross = await mkSupplier(orgA, "Steelwork");
    subB = await mkSupplier(orgB, "OtherOrg");

    await mkCis(orgA, sub20, "standard_20", "Groundworks", "V1111111111");
    // Deliberately NO verification reference: the higher-rate case where HMRC
    // requires a number on the statement and we do not hold one.
    await mkCis(orgA, sub30, "higher_30", "Roofing", null);
    await mkCis(orgA, subGross, "gross", "Steelwork", "V3333333333");
    await mkCis(orgB, subB, "standard_20", "OtherOrg", "V4444444444");

    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");

    // A user who is an ADMIN OF BOTH orgs — the blend test.
    dual = await mkMember(orgA, "admin", "dual");
    await svc().from("memberships").insert({ org_id: orgB, user_id: dual.id, role: "admin" });

    // Contractor identity for org A only; org B is left without one on purpose.
    const c = await svc().from("cis_contractor_profiles").insert({
      org_id: orgA,
      legal_name: "Acme Construction Ltd",
      employer_paye_reference: "123/AB45678",
      accounts_office_reference: "123PX00123456",
    });
    expect(c.error, c.error?.message).toBeNull();
  });

  afterAll(async () => {
    // `delete from organizations` fails for an org holding a `finances` row — a
    // pre-existing defect documented in M2's suite. Fixtures are TOKEN-tagged
    // precisely so leftover rows cannot affect a later run.
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB, dual]) {
      if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 1. THE CONTRACTOR'S OWN IDENTITY IS REQUIRED, NOT INVENTED
  // ═════════════════════════════════════════════════════════════════════════

  it("refuses to issue a statement for an org with no employer PAYE reference", async () => {
    // CIS340 3.15 requires the contractor's name and employer tax reference. Org
    // B has no profile, so a statement would be legally incomplete. Refusing is
    // the only honest outcome — there is nothing to derive it from.
    const bill = await mkBill(orgB, subB, 1000);
    const r = await asAdminB().rpc("record_cis_supplier_payment", {
      p_org_id: orgB,
      p_supplier_id: subB,
      p_paid_at: "2026-07-10",
      p_method: "bank_transfer",
      p_reference: null,
      p_notes: null,
      p_allocations: [{ finance_id: bill, amount: 1000 }],
      p_expected_rate: null,
    });
    expect(r.error, r.error?.message).toBeNull();

    const s = await issue(asAdminB(), orgB, subB, MONTH_END);
    expect(s.error?.message ?? "").toMatch(/contractor details are not set up/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. RECONCILIATION — the statement IS the ledger
  // ═════════════════════════════════════════════════════════════════════════

  it("issues a statement whose totals equal the frozen ledger, to the penny", async () => {
    // £1,000 net bill, £200 materials ⇒ basis £800 at 20% ⇒ £160 deducted.
    const bill = await mkBill(orgA, sub20, 1000);
    await setDetails(orgA, sub20, bill, 200);
    const payment = await pay(orgA, sub20, [{ finance_id: bill, amount: 1000 }], "2026-07-10");

    const r = await issue(asAdmin(), orgA, sub20, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const st = await statementRow(String(r.data));

    expect(num(st.gross_amount)).toBe(1000);
    expect(num(st.materials_amount)).toBe(200);
    expect(num(st.deduction_amount)).toBe(160);
    expect(st.payment_count).toBe(1);
    expect(st.is_statutory).toBe(true);
    expect(st.tax_month_start).toBe(MONTH_START);
    expect(st.tax_month_end).toBe(MONTH_END);
    // CISR12160: within 14 days of the tax month end. GENERATED, not supplied.
    expect(st.statement_due_on).toBe("2026-08-19");
    expect(String(st.content_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(st.statement_number)).toMatch(/^CIS-2026-08-\d{4}$/);

    // The provenance rows must sum to exactly the header. This is the
    // reconciliation the deferred constraint trigger enforces at COMMIT.
    const prov = await svc()
      .from("cis_statement_payments")
      .select("payment_id, cis_gross_payment, materials_total, cis_deduction")
      .eq("statement_id", String(st.id));
    const rows = prov.data ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payment_id).toBe(payment);
    expect(p2(rows.reduce((n, x) => n + num(x.cis_gross_payment), 0))).toBe(num(st.gross_amount));
    expect(p2(rows.reduce((n, x) => n + num(x.cis_deduction), 0))).toBe(num(st.deduction_amount));

    // …and against the source of truth, M3's snapshots.
    const snaps = await svc()
      .from("cis_payment_snapshots")
      .select("cis_gross_payment, materials_total, cis_deduction")
      .eq("org_id", orgA)
      .eq("supplier_id", sub20)
      .eq("tax_month_end", MONTH_END);
    expect(p2((snaps.data ?? []).reduce((n, x) => n + num(x.cis_deduction), 0))).toBe(
      num(st.deduction_amount),
    );
  });

  it("refuses a forged statement header even on the service_role path", async () => {
    // RLS decides WHO may write; the reconciliation trigger decides WHAT a write
    // may say. A statement with no provenance rows is a claim with no evidence.
    //
    // Deliberately aimed at a tax month with NO current statement, so the
    // partial unique index cannot refuse it first — this test must prove the
    // RECONCILIATION trigger fires, not that a duplicate was caught.
    const r = await svc().from("cis_statements").insert({
      org_id: orgA,
      supplier_id: sub20,
      statement_number: `${T}-forged`,
      sequence_no: 9999,
      tax_month_start: "2026-05-06",
      tax_month_end: "2026-06-05",
      contractor_name: "Acme Construction Ltd",
      contractor_paye_reference: "123/AB45678",
      subcontractor_name: "Groundworks Ltd",
      verification_number_required: false,
      gross_amount: 999999,
      materials_amount: 0,
      deduction_amount: 100,
      payment_count: 1,
      rate_is_uniform: true,
      deduction_rate: 20,
      cis_status: "standard_20",
      is_statutory: true,
      content_hash: "a".repeat(64),
      ledger_fingerprint: "b".repeat(64),
    });
    expect(r.error?.message ?? "").toMatch(/covers no payments|does not reconcile/i);
  });

  it("sums a subcontractor paid TWICE in one tax month into ONE statement", async () => {
    const b1 = await mkBill(orgA, sub20, 500);
    const b2 = await mkBill(orgA, sub20, 300);
    await setDetails(orgA, sub20, b1, 0);
    await setDetails(orgA, sub20, b2, 0);
    await pay(orgA, sub20, [{ finance_id: b1, amount: 500 }], "2026-07-15");
    await pay(orgA, sub20, [{ finance_id: b2, amount: 300 }], "2026-07-28");

    const r = await issue(asAdmin(), orgA, sub20, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const st = await statementRow(String(r.data));

    // The earlier £1,000 payment from the previous test is in the same month.
    expect(st.payment_count).toBe(3);
    expect(num(st.gross_amount)).toBe(1800);
    expect(num(st.deduction_amount)).toBe(p2(160 + 100 + 60));
  });

  it("keeps payments on the 5th and the 6th in ADJACENT statements", async () => {
    // The boundary that files a payment in the wrong return if it is wrong.
    const b1 = await mkBill(orgA, subGross, 400);
    const b2 = await mkBill(orgA, subGross, 700);
    await pay(orgA, subGross, [{ finance_id: b1, amount: 400 }], "2026-07-05"); // prev month
    await pay(orgA, subGross, [{ finance_id: b2, amount: 700 }], "2026-07-06"); // this month

    const prev = await issue(asAdmin(), orgA, subGross, PREV_MONTH_END);
    expect(prev.error, prev.error?.message).toBeNull();
    const cur = await issue(asAdmin(), orgA, subGross, MONTH_END);
    expect(cur.error, cur.error?.message).toBeNull();

    const p = await statementRow(String(prev.data));
    const c = await statementRow(String(cur.data));
    expect(num(p.gross_amount)).toBe(400);
    expect(num(c.gross_amount)).toBe(700);
    expect(p.tax_month_end).toBe(PREV_MONTH_END);
    expect(c.tax_month_end).toBe(MONTH_END);
  });

  it("marks a GROSS-status statement non-statutory and deducts nothing", async () => {
    // CIS340 3.15: for a gross payment a statement is "good practice ... but
    // there is no obligation".
    const st = await svc()
      .from("cis_statements")
      .select("is_statutory, deduction_amount, verification_number_required")
      .eq("org_id", orgA)
      .eq("supplier_id", subGross)
      .eq("tax_month_end", MONTH_END)
      .maybeSingle();
    expect(num(st.data?.deduction_amount)).toBe(0);
    expect(st.data?.is_statutory).toBe(false);
    expect(st.data?.verification_number_required).toBe(false);
  });

  it("records a 30% unmatched subcontractor as NEEDING a verification number, and admits it has none", async () => {
    // The honesty case. CISR12160 requires the number here. M1 holds none, so
    // the statement stores NULL — never a placeholder — and the document says so.
    const bill = await mkBill(orgA, sub30, 1000);
    await pay(orgA, sub30, [{ finance_id: bill, amount: 1000 }], "2026-07-12");

    const r = await issue(asAdmin(), orgA, sub30, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const st = await statementRow(String(r.data));

    expect(num(st.deduction_amount)).toBe(300);
    expect(st.verification_number_required).toBe(true);
    expect(st.verification_number).toBeNull();
    expect(st.cis_status).toBe("higher_30");
  });

  it("refuses a statement for a month with no payments", async () => {
    const r = await issue(asAdmin(), orgA, sub20, "2026-05-05");
    expect(r.error?.message ?? "").toMatch(/no live CIS payments/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. IMMUTABILITY + THE REISSUE PATH
  // ═════════════════════════════════════════════════════════════════════════

  it("refuses to edit an issued statement, for every role", async () => {
    const st = await svc()
      .from("cis_statements")
      .select("id")
      .eq("org_id", orgA)
      .eq("supplier_id", sub30)
      .eq("tax_month_end", MONTH_END)
      .maybeSingle();
    const id = String(st.data?.id);

    for (const client of [asAdmin(), svc()]) {
      const r = await client.from("cis_statements").update({ deduction_amount: 1 }).eq("id", id);
      expect(r.error?.message ?? "").toMatch(/immutable once issued/i);
    }
    // Even the verification number cannot be back-filled by editing — that is
    // precisely the fact a replacement exists to correct.
    const v = await svc()
      .from("cis_statements")
      .update({ verification_number: "V9999999999" })
      .eq("id", id);
    expect(v.error?.message ?? "").toMatch(/immutable once issued/i);
  });

  it("refuses to delete an issued statement, and freezes its provenance rows", async () => {
    const st = await svc()
      .from("cis_statements")
      .select("id")
      .eq("org_id", orgA)
      .eq("supplier_id", sub30)
      .eq("tax_month_end", MONTH_END)
      .maybeSingle();
    const id = String(st.data?.id);

    const d = await svc().from("cis_statements").delete().eq("id", id);
    expect(d.error?.message ?? "").toMatch(/cannot be deleted/i);

    const u = await svc()
      .from("cis_statement_payments")
      .update({ cis_deduction: 0 })
      .eq("statement_id", id);
    expect(u.error?.message ?? "").toMatch(/immutable/i);

    const dp = await svc().from("cis_statement_payments").delete().eq("statement_id", id);
    expect(dp.error?.message ?? "").toMatch(/cannot be deleted/i);
  });

  it("REISSUING supersedes the old statement instead of editing it", async () => {
    const before = await svc()
      .from("cis_statements")
      .select("id, content_hash, gross_amount")
      .eq("org_id", orgA)
      .eq("supplier_id", sub20)
      .eq("tax_month_end", MONTH_END)
      .eq("status", "issued")
      .maybeSingle();
    const oldId = String(before.data?.id);
    const oldHash = String(before.data?.content_hash);
    const oldGross = num(before.data?.gross_amount);

    const r = await issue(asAdmin(), orgA, sub20, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const newId = String(r.data);
    expect(newId).not.toBe(oldId);

    const old = await statementRow(oldId);
    const fresh = await statementRow(newId);

    // The old row's STATUS moved; its CONTENT did not.
    expect(old.status).toBe("superseded");
    expect(old.superseded_at).not.toBeNull();
    expect(String(old.content_hash)).toBe(oldHash);
    expect(num(old.gross_amount)).toBe(oldGross);

    // The replacement points back at what it replaced.
    expect(fresh.status).toBe("issued");
    expect(fresh.supersedes_id).toBe(oldId);
  });

  it("allows only one CURRENT statement per subcontractor per tax month", async () => {
    const rows = await svc()
      .from("cis_statements")
      .select("id")
      .eq("org_id", orgA)
      .eq("supplier_id", sub20)
      .eq("tax_month_end", MONTH_END)
      .eq("status", "issued");
    expect(rows.data ?? []).toHaveLength(1);
  });

  it("refuses an invalid status transition and treats a closed statement as final", async () => {
    // sub20 has been reissued more than once by now, so there are SEVERAL
    // superseded rows — take the first rather than assuming a single one.
    const sup = await svc()
      .from("cis_statements")
      .select("id")
      .eq("org_id", orgA)
      .eq("supplier_id", sub20)
      .eq("status", "superseded");
    const id = String((sup.data ?? [])[0]?.id);
    expect(id, "expected at least one superseded statement").not.toBe("undefined");

    const back = await svc()
      .from("cis_statements")
      .update({ status: "issued", superseded_at: null })
      .eq("id", id);
    expect(back.error?.message ?? "").toMatch(/is superseded|final/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. VOIDS — detectable staleness, never silent mutation
  // ═════════════════════════════════════════════════════════════════════════

  it("makes a statement STALE when a covered payment is voided, without altering it", async () => {
    const bill = await mkBill(orgA, sub30, 200);
    const payment = await pay(orgA, sub30, [{ finance_id: bill, amount: 200 }], "2026-07-20");

    const r = await issue(asAdmin(), orgA, sub30, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data);
    const before = await statementRow(id);
    const fingerprintAtIssue = String(before.ledger_fingerprint);

    const live = await asAdmin().rpc("cis_statement_ledger_fingerprint", {
      p_org_id: orgA,
      p_supplier_id: sub30,
      p_tax_month_end: MONTH_END,
    });
    expect(String(live.data)).toBe(fingerprintAtIssue);

    // Void one of the payments the statement covers.
    const v = await asAdmin()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "posted in error" })
      .eq("id", payment);
    expect(v.error, v.error?.message).toBeNull();

    // The statement itself has NOT changed — it is a document already handed over.
    const after = await statementRow(id);
    expect(after.ledger_fingerprint).toBe(fingerprintAtIssue);
    expect(num(after.deduction_amount)).toBe(num(before.deduction_amount));
    expect(after.status).toBe("issued");

    // But the divergence is PROVABLE, which is what makes reissue a decision
    // rather than a guess.
    const now = await asAdmin().rpc("cis_statement_ledger_fingerprint", {
      p_org_id: orgA,
      p_supplier_id: sub30,
      p_tax_month_end: MONTH_END,
    });
    expect(String(now.data)).not.toBe(fingerprintAtIssue);
  });

  it("reissues after a void with the corrected figures, superseding the stale one", async () => {
    const stale = await svc()
      .from("cis_statements")
      .select("id, deduction_amount")
      .eq("org_id", orgA)
      .eq("supplier_id", sub30)
      .eq("tax_month_end", MONTH_END)
      .eq("status", "issued")
      .maybeSingle();
    const staleId = String(stale.data?.id);
    const staleDeduction = num(stale.data?.deduction_amount);

    const r = await issue(asAdmin(), orgA, sub30, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const fresh = await statementRow(String(r.data));

    // The voided £200 payment (£60 at 30%) has dropped out.
    expect(num(fresh.deduction_amount)).toBe(p2(staleDeduction - 60));
    expect(fresh.supersedes_id).toBe(staleId);
    expect((await statementRow(staleId)).status).toBe("superseded");

    const now = await asAdmin().rpc("cis_statement_ledger_fingerprint", {
      p_org_id: orgA,
      p_supplier_id: sub30,
      p_tax_month_end: MONTH_END,
    });
    expect(fresh.ledger_fingerprint).toBe(String(now.data));
  });

  it("WITHDRAWS a statement when every payment it covered has been voided", async () => {
    // Reissue is impossible — there is nothing left to state — so the honest
    // close-out preserves the document and records that it no longer applies.
    const sup = await mkSupplier(orgA, "Scaffolding");
    await mkCis(orgA, sup, "standard_20", "Scaffolding", "V5555555555");
    const bill = await mkBill(orgA, sup, 600);
    const payment = await pay(orgA, sup, [{ finance_id: bill, amount: 600 }], "2026-07-18");

    const r = await issue(asAdmin(), orgA, sup, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data);

    await asAdmin()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "duplicate" })
      .eq("id", payment);

    // Nothing left to reissue.
    const retry = await issue(asAdmin(), orgA, sup, MONTH_END);
    expect(retry.error?.message ?? "").toMatch(/no live CIS payments/i);

    // A reasonless withdrawal is refused; a reasoned one is recorded.
    const bad = await asAdmin().rpc("withdraw_cis_statement", {
      p_org_id: orgA,
      p_statement_id: id,
      p_reason: "   ",
    });
    expect(bad.error?.message ?? "").toMatch(/must say why/i);

    const ok = await asAdmin().rpc("withdraw_cis_statement", {
      p_org_id: orgA,
      p_statement_id: id,
      p_reason: "Payment voided as a duplicate.",
    });
    expect(ok.error, ok.error?.message).toBeNull();

    const st = await statementRow(id);
    expect(st.status).toBe("withdrawn");
    expect(st.withdraw_reason).toMatch(/duplicate/i);
    // The content is untouched — it is still the document the subcontractor holds.
    expect(num(st.gross_amount)).toBe(600);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 5. THE MONTHLY RETURN DATASET
  // ═════════════════════════════════════════════════════════════════════════

  it("prepares a return whose totals equal its lines and the ledger", async () => {
    const r = await prepare(asAdmin(), orgA, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const ret = (await svc().from("cis_monthly_returns").select("*").eq("id", String(r.data)).maybeSingle()).data!;

    const lines =
      (await svc()
        .from("cis_monthly_return_lines")
        .select("supplier_id, gross_amount, materials_amount, deduction_amount, payment_count")
        .eq("return_id", String(ret.id))).data ?? [];

    expect(lines.length).toBe(ret.subcontractor_count);
    expect(p2(lines.reduce((n, l) => n + num(l.gross_amount), 0))).toBe(num(ret.total_gross));
    expect(p2(lines.reduce((n, l) => n + num(l.deduction_amount), 0))).toBe(num(ret.total_deduction));
    expect(lines.reduce((n, l) => n + Number(l.payment_count), 0)).toBe(ret.payment_count);

    // Against the ledger itself.
    const snaps =
      (await svc()
        .from("cis_payment_snapshots")
        .select("payment_id, cis_deduction")
        .eq("org_id", orgA)
        .eq("tax_month_end", MONTH_END)).data ?? [];
    const paymentRows =
      (await svc().from("supplier_payments").select("id, voided_at").eq("org_id", orgA)).data ?? [];
    const voided = new Set(paymentRows.filter((p) => p.voided_at != null).map((p) => p.id));
    const ledgerDeduction = p2(
      snaps.filter((s) => !voided.has(s.payment_id)).reduce((n, s) => n + num(s.cis_deduction), 0),
    );
    expect(num(ret.total_deduction)).toBe(ledgerDeduction);

    // GOV.UK: the 19th of the month following the tax month. GENERATED.
    expect(ret.return_due_on).toBe("2026-08-19");
    expect(ret.status).toBe("prepared");
    expect(ret.is_nil).toBe(false);
    // One entry per subcontractor, even where several payments were made.
    expect(new Set(lines.map((l) => l.supplier_id)).size).toBe(lines.length);
  });

  it("includes GROSS-status subcontractors on the return", async () => {
    // The return reports payments to all subcontractors, gross or under
    // deduction — a wider population than the set owed a statement.
    const ret = (await svc()
      .from("cis_monthly_returns")
      .select("id")
      .eq("org_id", orgA)
      .eq("tax_month_end", MONTH_END)
      .is("superseded_at", null)
      .maybeSingle()).data!;
    const line = (await svc()
      .from("cis_monthly_return_lines")
      .select("deduction_amount, gross_amount, cis_status")
      .eq("return_id", String(ret.id))
      .eq("supplier_id", subGross)
      .maybeSingle()).data;
    expect(line, "a gross-status subcontractor must appear on the return").toBeTruthy();
    expect(num(line?.deduction_amount)).toBe(0);
    expect(num(line?.gross_amount)).toBe(700);
  });

  it("prepares a NIL RETURN as a real row for a month with no payments", async () => {
    // GOV.UK requires "a return showing your payments were 0". An absent row
    // would make an obligation look like nothing to do.
    const r = await prepare(asAdmin(), orgA, "2026-05-05");
    expect(r.error, r.error?.message).toBeNull();
    const ret = (await svc().from("cis_monthly_returns").select("*").eq("id", String(r.data)).maybeSingle()).data!;

    expect(ret.is_nil).toBe(true);
    expect(ret.subcontractor_count).toBe(0);
    expect(ret.payment_count).toBe(0);
    expect(num(ret.total_gross)).toBe(0);
    expect(num(ret.total_deduction)).toBe(0);
    expect(ret.return_due_on).toBe("2026-05-19");

    const lines = (await svc().from("cis_monthly_return_lines").select("supplier_id").eq("return_id", String(ret.id))).data ?? [];
    expect(lines).toHaveLength(0);
  });

  it("has NO state that claims the return was filed with HMRC", async () => {
    const ret = (await svc()
      .from("cis_monthly_returns")
      .select("id, status")
      .eq("org_id", orgA)
      .eq("tax_month_end", MONTH_END)
      .is("superseded_at", null)
      .maybeSingle()).data!;

    for (const forged of ["submitted", "filed", "accepted", "sent"]) {
      const r = await svc().from("cis_monthly_returns").update({ status: forged }).eq("id", String(ret.id));
      expect(r.error, `status '${forged}' must be unrepresentable`).not.toBeNull();
    }

    // The one legitimate transition records OUR act, not HMRC's.
    const e = await asAdmin().rpc("mark_cis_monthly_return_exported", {
      p_org_id: orgA,
      p_return_id: String(ret.id),
    });
    expect(e.error, e.error?.message).toBeNull();
    const after = (await svc().from("cis_monthly_returns").select("status, exported_at").eq("id", String(ret.id)).maybeSingle()).data!;
    expect(after.status).toBe("exported");
    expect(after.exported_at).not.toBeNull();
  });

  it("supersedes a prepared return when it is re-prepared", async () => {
    const before = (await svc()
      .from("cis_monthly_returns")
      .select("id, total_deduction")
      .eq("org_id", orgA)
      .eq("tax_month_end", MONTH_END)
      .is("superseded_at", null)
      .maybeSingle()).data!;

    const r = await prepare(asAdmin(), orgA, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();

    const old = (await svc().from("cis_monthly_returns").select("superseded_at, total_deduction").eq("id", String(before.id)).maybeSingle()).data!;
    expect(old.superseded_at).not.toBeNull();
    // Superseding did not rewrite what was prepared before.
    expect(num(old.total_deduction)).toBe(num(before.total_deduction));

    const current = (await svc()
      .from("cis_monthly_returns")
      .select("id, supersedes_id")
      .eq("org_id", orgA)
      .eq("tax_month_end", MONTH_END)
      .is("superseded_at", null)
      .maybeSingle()).data!;
    expect(current.supersedes_id).toBe(String(before.id));
  });

  it("refuses to edit or delete a prepared return, and freezes its lines", async () => {
    const ret = (await svc()
      .from("cis_monthly_returns")
      .select("id")
      .eq("org_id", orgA)
      .eq("tax_month_end", MONTH_END)
      .is("superseded_at", null)
      .maybeSingle()).data!;

    const u = await svc().from("cis_monthly_returns").update({ total_deduction: 1 }).eq("id", String(ret.id));
    expect(u.error?.message ?? "").toMatch(/immutable/i);

    const d = await svc().from("cis_monthly_returns").delete().eq("id", String(ret.id));
    expect(d.error?.message ?? "").toMatch(/cannot be deleted/i);

    const l = await svc().from("cis_monthly_return_lines").update({ gross_amount: 0 }).eq("return_id", String(ret.id));
    expect(l.error?.message ?? "").toMatch(/immutable/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 6. TENANCY — admin-only, and no blending across orgs
  // ═════════════════════════════════════════════════════════════════════════

  it("gives a same-org MEMBER zero rows and refuses their writes", async () => {
    for (const t of [
      "cis_contractor_profiles",
      "cis_statements",
      "cis_statement_payments",
      "cis_monthly_returns",
      "cis_monthly_return_lines",
    ]) {
      const r = await asMember().from(t).select("*");
      expect(r.data ?? [], `${t} must be invisible to a non-admin member`).toHaveLength(0);
    }

    const issueAttempt = await issue(asMember(), orgA, sub20, MONTH_END);
    expect(issueAttempt.error?.message ?? "").toMatch(/only an owner or admin/i);

    const prepareAttempt = await prepare(asMember(), orgA, MONTH_END);
    expect(prepareAttempt.error?.message ?? "").toMatch(/only an owner or admin/i);
  });

  it("gives an ANONYMOUS caller nothing", async () => {
    for (const t of ["cis_statements", "cis_monthly_returns", "cis_contractor_profiles"]) {
      const r = await db(anonClient()).from(t).select("*");
      expect(r.data ?? []).toHaveLength(0);
    }
  });

  it("stops one org reading another's statements — the cross-tenant proof", async () => {
    const seen = await asAdminB().from("cis_statements").select("id, org_id");
    expect(seen.data ?? [], "org B must not see org A's statements").toHaveLength(0);

    const returns = await asAdminB().from("cis_monthly_returns").select("id");
    expect(returns.data ?? []).toHaveLength(0);

    const profile = await asAdminB().from("cis_contractor_profiles").select("employer_paye_reference");
    expect(profile.data ?? [], "org B must not see org A's PAYE reference").toHaveLength(0);

    // …and cannot act on org A either, even naming its ids explicitly.
    const forged = await issue(asAdminB(), orgA, sub20, MONTH_END);
    expect(forged.error?.message ?? "").toMatch(/only an owner or admin/i);
  });

  it("does not BLEND orgs for a user who is an admin of both", async () => {
    // The failure mode this catches: a query scoped by membership rather than by
    // the active org would return BOTH tenants' rows to this user, and a return
    // total would silently include another business's deductions.
    const all = await asDual().from("cis_statements").select("id, org_id");
    const orgs = new Set((all.data ?? []).map((r) => String(r.org_id)));
    // They legitimately see org A's rows (they are an admin there) and org B has
    // none, so the meaningful assertion is that every row is correctly attributed
    // and org-scoped filtering returns exactly the right subset.
    expect(orgs.has(orgB)).toBe(false);

    const scopedA = await asDual().from("cis_statements").select("id").eq("org_id", orgA);
    const scopedB = await asDual().from("cis_statements").select("id").eq("org_id", orgB);
    expect((scopedA.data ?? []).length).toBeGreaterThan(0);
    expect(scopedB.data ?? []).toHaveLength(0);
    expect((scopedA.data ?? []).length).toBe((all.data ?? []).length);

    // A return prepared for org B must contain only org B's (nonexistent) data,
    // never org A's — the blend a shared-membership bug would produce.
    const b = await svc().from("cis_contractor_profiles").insert({
      org_id: orgB,
      legal_name: "Beta Builders Ltd",
      employer_paye_reference: "456/CD11111",
    });
    expect(b.error, b.error?.message).toBeNull();

    const r = await prepare(asDual(), orgB, MONTH_END);
    expect(r.error, r.error?.message).toBeNull();
    const ret = (await svc().from("cis_monthly_returns").select("*").eq("id", String(r.data)).maybeSingle()).data!;
    expect(ret.contractor_paye_reference).toBe("456/CD11111");

    const lines =
      (await svc().from("cis_monthly_return_lines").select("supplier_id").eq("return_id", String(ret.id))).data ?? [];
    const supplierIds = new Set(lines.map((l) => String(l.supplier_id)));
    expect(supplierIds.has(sub20), "org A's subcontractor must never appear on org B's return").toBe(false);
    expect(supplierIds.has(sub30)).toBe(false);
    expect(supplierIds.has(subGross)).toBe(false);
  });

  it("refuses a statement for a subcontractor belonging to another org", async () => {
    // The composite FK binds (supplier_id, org_id); a forged pairing has no row.
    const r = await issue(asAdmin(), orgA, subB, MONTH_END);
    expect(r.error, "org A must not be able to state for org B's subcontractor").not.toBeNull();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 7. TAX-MONTH INTEGRITY
  // ═════════════════════════════════════════════════════════════════════════

  it("refuses a period that is not a real CIS tax month", async () => {
    for (const bad of ["2026-07-31", "2026-08-01", "2026-08-06"]) {
      const r = await issue(asAdmin(), orgA, sub20, bad);
      expect(r.error?.message ?? "", `${bad} is not a tax month end`).toMatch(/always ends on the 5th/i);
      const p = await prepare(asAdmin(), orgA, bad);
      expect(p.error?.message ?? "").toMatch(/always ends on the 5th/i);
    }
  });

  it("refuses a statement row whose two tax-month dates disagree", async () => {
    const r = await svc().from("cis_statements").insert({
      org_id: orgA,
      supplier_id: sub20,
      statement_number: `${T}-badmonth`,
      sequence_no: 9998,
      tax_month_start: "2026-07-01", // not a tax month start
      tax_month_end: MONTH_END,
      contractor_name: "Acme Construction Ltd",
      contractor_paye_reference: "123/AB45678",
      subcontractor_name: "Groundworks Ltd",
      verification_number_required: false,
      gross_amount: 100,
      materials_amount: 0,
      deduction_amount: 20,
      payment_count: 1,
      rate_is_uniform: true,
      deduction_rate: 20,
      cis_status: "standard_20",
      is_statutory: true,
      content_hash: "a".repeat(64),
      ledger_fingerprint: "b".repeat(64),
    });
    expect(r.error?.message ?? "").toMatch(/tax_month_real|violates check/i);
  });
});
