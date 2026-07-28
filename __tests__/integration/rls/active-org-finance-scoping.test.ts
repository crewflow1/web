import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * ACTIVE-ORG SCOPING — FINANCE / COMMERCIAL SLICE.
 *
 * Proven against real Postgres with a genuine MULTI-ORG user, in the same
 * shape as the jobs-domain proof (__tests__/integration/rls/active-org-scoping)
 * that shipped with #456. Read that file's header for the full statement of
 * the defect; in brief:
 *
 *   `current_org_ids()` deliberately returns EVERY org the viewer belongs to.
 *   That is correct for RLS, whose job is the OUTER boundary ("you cannot see
 *   an org you are not a member of"). It is NOT active-org scoping. So any
 *   query that identifies a row by primary key alone reaches every org the
 *   viewer belongs to — and a write issued with the active org's assumptions
 *   lands on another org's row.
 *
 * This is NOT a cross-tenant vulnerability: the viewer is a legitimate member
 * of both orgs. It is an org-context and data-integrity defect — and in this
 * slice it sits on the money: quotes, invoices, customers, leads, expenses,
 * compliance documents and notifications.
 *
 * Four properties are pinned for every table below:
 *   1. PREMISE        — the un-scoped shape really does reach org B's row for
 *                       this user. If this ever stops being true,
 *                       `current_org_ids()` changed and the whole fix should be
 *                       revisited rather than quietly kept.
 *   2. SCOPING        — the scoped write affects ZERO rows and org B's data is
 *                       byte-for-byte untouched afterwards.
 *   3. NO OVER-SCOPING— the ordinary single-org path still READS and WRITES.
 *   4. RLS UNTOUCHED  — a non-member and anon still see nothing, so the new
 *                       application-layer predicate is not load-bearing for the
 *                       outer security boundary.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  is(column: string, value: unknown): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]> & { count: number | null }> {
  eq(column: string, value: unknown): Upd;
  is(column: string, value: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row, opts?: Record<string, unknown>): Upd;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-aofs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("active-org scoping · multi-org user (finance/commercial)", () => {
  let orgA = "";
  let orgB = "";

  // One fixture row per table, in each org.
  const A: Record<string, string> = {};
  const B: Record<string, string> = {};

  // The multi-org user: OWNER of both org A and org B, "working in" org A.
  let dualUserId = "";
  let dualToken = "";

  // A user who belongs to NEITHER org — the RLS control.
  let outsiderUserId = "";
  let outsiderToken = "";

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
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
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `Active-org finance ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  /** Insert one row per fixture table into `org`, returning their ids. */
  async function seedOrg(org: string, tag: string, into: Record<string, string>) {
    const svc = db(serviceClient());

    const customer = await svc
      .from("customers")
      .insert({ org_id: org, name: `Customer ${tag}`, email: `c-${tag}@example.test` })
      .select("id")
      .single();
    expect(customer.error, customer.error?.message).toBeNull();
    into.customer = String(customer.data?.id ?? "");

    const quote = await svc
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: into.customer,
        number: `Q-${TOKEN}-${tag}`,
        status: "draft",
        subtotal: 1000,
        vat_total: 200,
        notes: `quote in org ${tag}`,
      })
      .select("id")
      .single();
    expect(quote.error, quote.error?.message).toBeNull();
    into.quote = String(quote.data?.id ?? "");

    const line = await svc
      .from("quote_line_items")
      .insert({
        quote_id: into.quote,
        org_id: org,
        description: `line in org ${tag}`,
        qty: 1,
        unit_price: 1000,
        line_total: 1000,
        sort_order: 0,
      })
      .select("id")
      .single();
    expect(line.error, line.error?.message).toBeNull();
    into.line = String(line.data?.id ?? "");

    const invoice = await svc
      .from("invoices")
      .insert({
        org_id: org,
        quote_id: into.quote,
        customer_id: into.customer,
        number: `INV-${TOKEN}-${tag}`,
        status: "draft",
        amount: 1000,
        vat_total: 200,
        notes: `invoice in org ${tag}`,
      })
      .select("id")
      .single();
    expect(invoice.error, invoice.error?.message).toBeNull();
    into.invoice = String(invoice.data?.id ?? "");

    const lead = await svc
      .from("leads")
      .insert({
        org_id: org,
        source: "web",
        status: "new",
        notes: `lead in org ${tag}`,
      })
      .select("id")
      .single();
    expect(lead.error, lead.error?.message).toBeNull();
    into.lead = String(lead.data?.id ?? "");

    const finance = await svc
      .from("finances")
      .insert({
        org_id: org,
        amount: 500,
        vat_rate: 20,
        notes: `expense in org ${tag}`,
      })
      .select("id")
      .single();
    expect(finance.error, finance.error?.message).toBeNull();
    into.finance = String(finance.data?.id ?? "");

    const doc = await svc
      .from("compliance_documents")
      .insert({
        org_id: org,
        kind: "insurance",
        title: `doc in org ${tag}`,
        storage_path: `${org}/${TOKEN}-${tag}.pdf`,
      })
      .select("id")
      .single();
    expect(doc.error, doc.error?.message).toBeNull();
    into.doc = String(doc.data?.id ?? "");

    const note = await svc
      .from("notifications")
      .insert({
        org_id: org,
        audience: "customer",
        type: "test.active_org",
        title: `notification in org ${tag}`,
        read_at: null,
      })
      .select("id")
      .single();
    expect(note.error, note.error?.message).toBeNull();
    into.note = String(note.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc
      .from("organizations")
      .insert({ name: "Active-Org Finance A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "Active-Org Finance B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    await seedOrg(orgA, "A", A);
    await seedOrg(orgB, "B", B);

    const dual = await mintUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    // OWNER in BOTH orgs — this is what makes the blend possible, and what
    // makes RLS (correctly) permit the row.
    for (const org of [orgA, orgB]) {
      const m = await svc
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "owner" });
      expect(m.error, m.error?.message).toBeNull();
    }

    const outsider = await mintUser("outsider");
    outsiderUserId = outsider.id;
    outsiderToken = outsider.token;

    if (!dualToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (dualUserId) await serviceClient().auth.admin.deleteUser(dualUserId);
    if (outsiderUserId) await serviceClient().auth.admin.deleteUser(outsiderUserId);
  });

  // ------------------------------------------------------------------ helpers

  /** Ground truth, read past RLS. */
  async function truth(table: string, id: string, column: string) {
    const r = await db(serviceClient())
      .from(table)
      .select(column)
      .eq("id", id)
      .maybeSingle();
    return r.data?.[column];
  }

  /**
   * The whole proof for one table, in one place.
   *
   * Runs all four properties (premise / scoping / no-over-scoping / RLS) so a
   * new domain cannot be added with only the convenient half of them.
   */
  function proveTable(
    label: string,
    table: string,
    column: string,
    idA: () => string,
    idB: () => string,
    originalB: string,
  ) {
    it(`${label}: PREMISE — the UNSCOPED read really does return org B's row`, async () => {
      const r = await db(userClient(dualToken))
        .from(table)
        .select(`id, ${column}`)
        .eq("id", idB())
        .maybeSingle();
      expect(r.error, r.error?.message).toBeNull();
      expect(
        r.data?.id,
        "RLS is deliberately permissive across memberships — if this returns " +
          "null, current_org_ids() changed and this fix should be revisited",
      ).toBe(idB());
    });

    it(`${label}: a write SCOPED to the active org cannot touch org B's row`, async () => {
      const r = await db(userClient(dualToken))
        .from(table)
        .update({ [column]: "written from org A" }, { count: "exact" })
        .eq("id", idB())
        .eq("org_id", orgA);
      expect(r.error, r.error?.message).toBeNull();
      expect(r.count, "zero rows must be affected").toBe(0);
      expect(await truth(table, idB(), column), "org B's row must be untouched").toBe(
        originalB,
      );
    });

    it(`${label}: WITHOUT the predicate that same write DOES hit org B (the defect)`, async () => {
      const r = await db(userClient(dualToken))
        .from(table)
        .update({ [column]: "cross-org write" }, { count: "exact" })
        .eq("id", idB());
      expect(r.error, r.error?.message).toBeNull();
      expect(r.count, "this is precisely what the fix prevents").toBe(1);
      // Restore so later assertions are not confused by it.
      await db(serviceClient())
        .from(table)
        .update({ [column]: originalB })
        .eq("id", idB());
    });

    it(`${label}: the scoped write STILL WORKS on org A's own row (no over-scoping)`, async () => {
      const r = await db(userClient(dualToken))
        .from(table)
        .update({ [column]: "legitimate org A write" }, { count: "exact" })
        .eq("id", idA())
        .eq("org_id", orgA);
      expect(r.error, r.error?.message).toBeNull();
      expect(r.count, "the normal single-org write path must keep working").toBe(1);
    });

    it(`${label}: switching the active org to B makes B writable and A not (org switcher still works)`, async () => {
      const bWhileActiveB = await db(userClient(dualToken))
        .from(table)
        .update({ [column]: originalB }, { count: "exact" })
        .eq("id", idB())
        .eq("org_id", orgB);
      const aWhileActiveB = await db(userClient(dualToken))
        .from(table)
        .update({ [column]: "should not land" }, { count: "exact" })
        .eq("id", idA())
        .eq("org_id", orgB);
      expect(bWhileActiveB.count).toBe(1);
      expect(
        aWhileActiveB.count,
        "the predicate must track the ACTIVE org, not hide org B for ever",
      ).toBe(0);
    });

    it(`${label}: RLS untouched — a non-member's scoped read finds nothing`, async () => {
      const r = await db(userClient(outsiderToken))
        .from(table)
        .select("id")
        .eq("id", idA())
        .eq("org_id", orgA)
        .maybeSingle();
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data).toBeNull();
    });

    it(`${label}: RLS untouched — a non-member is denied even by the UNSCOPED read`, async () => {
      // The outer security boundary must NOT depend on the application-layer
      // predicate this change introduces.
      const r = await db(userClient(outsiderToken))
        .from(table)
        .select("id")
        .eq("id", idA())
        .maybeSingle();
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data, "RLS alone must still deny a genuine outsider").toBeNull();
    });

    it(`${label}: RLS untouched — anon sees nothing`, async () => {
      const r = await db(anonClient()).from(table).select("id").eq("id", idA());
      expect(r.error, r.error?.message).toBeNull();
      expect(r.data ?? []).toHaveLength(0);
    });
  }

  // ----------------------------------------------------------------- domains

  proveTable("quotes", "quotes", "notes", () => A.quote!, () => B.quote!, "quote in org B");
  proveTable("invoices", "invoices", "notes", () => A.invoice!, () => B.invoice!, "invoice in org B");
  proveTable("customers", "customers", "name", () => A.customer!, () => B.customer!, "Customer B");
  proveTable("leads", "leads", "notes", () => A.lead!, () => B.lead!, "lead in org B");
  proveTable("finances", "finances", "notes", () => A.finance!, () => B.finance!, "expense in org B");
  proveTable(
    "compliance_documents",
    "compliance_documents",
    "title",
    () => A.doc!,
    () => B.doc!,
    "doc in org B",
  );
  proveTable(
    "notifications",
    "notifications",
    "title",
    () => A.note!,
    () => B.note!,
    "notification in org B",
  );

  // ------------------------------------------- destructive paths (DELETE)

  it("DELETE scoped to the active org cannot delete org B's quote", async () => {
    const r = await db(userClient(dualToken))
      .from("quotes")
      .delete({ count: "exact" })
      .eq("id", B.quote!)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count).toBe(0);
    expect(await truth("quotes", B.quote!, "id")).toBe(B.quote);
  });

  it("DELETE scoped to the active org cannot delete org B's lead", async () => {
    const r = await db(userClient(dualToken))
      .from("leads")
      .delete({ count: "exact" })
      .eq("id", B.lead!)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count).toBe(0);
    expect(await truth("leads", B.lead!, "id")).toBe(B.lead);
  });

  it("DELETE without the predicate DOES remove org B's lead (the defect)", async () => {
    const r = await db(userClient(dualToken))
      .from("leads")
      .delete({ count: "exact" })
      .eq("id", B.lead!);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "an irreversible cross-org delete — this is why it matters").toBe(1);
    // Re-seed so the remaining assertions have a lead in org B.
    const re = await db(serviceClient())
      .from("leads")
      .insert({ org_id: orgB, source: "web", status: "new", notes: "lead in org B" })
      .select("id")
      .single();
    B.lead = String(re.data?.id ?? "");
  });

  // ------------------------------------------ quote_line_items (child rows)

  it("the line-item replacement in updateQuote cannot wipe org B's priced lines", async () => {
    // updateQuote deletes line items by quote_id before re-inserting. Keyed on
    // quote_id alone that reached another org's children even when the parent
    // update no-opped, leaving their quote a shell with a total and no lines.
    const r = await db(userClient(dualToken))
      .from("quote_line_items")
      .delete({ count: "exact" })
      .eq("quote_id", B.quote!)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count).toBe(0);
    expect(await truth("quote_line_items", B.line!, "description")).toBe("line in org B");
  });

  it("without the predicate that same line-item delete DOES wipe org B's lines", async () => {
    const r = await db(userClient(dualToken))
      .from("quote_line_items")
      .delete({ count: "exact" })
      .eq("quote_id", B.quote!);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count).toBe(1);
    const re = await db(serviceClient())
      .from("quote_line_items")
      .insert({
        quote_id: B.quote!,
        org_id: orgB,
        description: "line in org B",
        qty: 1,
        unit_price: 1000,
        line_total: 1000,
        sort_order: 0,
      })
      .select("id")
      .single();
    B.line = String(re.data?.id ?? "");
  });

  it("the scoped line-item delete still clears org A's own lines (no over-scoping)", async () => {
    const r = await db(userClient(dualToken))
      .from("quote_line_items")
      .delete({ count: "exact" })
      .eq("quote_id", A.quote!)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count, "the ordinary edit path must still replace line items").toBe(1);
  });

  // --------------------------------------- markAllNotificationsRead (bulk)

  it("the unscoped 'mark all read' bulk write reaches BOTH orgs (the defect)", async () => {
    // No id and no org filter — the widest write in the slice. One click in
    // org A cleared org B's unread queue too.
    const r = await db(userClient(dualToken))
      .from("notifications")
      .update({ read_at: new Date().toISOString() }, { count: "exact" })
      .is("read_at", null);
    expect(r.error, r.error?.message).toBeNull();
    expect(r.count ?? 0, "it swept up more than the active org's rows").toBeGreaterThan(1);
    // Reset both fixtures to unread for the scoped assertion below.
    for (const id of [A.note!, B.note!]) {
      await db(serviceClient()).from("notifications").update({ read_at: null }).eq("id", id);
    }
  });

  it("scoped to the active org, 'mark all read' leaves org B unread", async () => {
    const r = await db(userClient(dualToken))
      .from("notifications")
      .update({ read_at: new Date().toISOString() }, { count: "exact" })
      .is("read_at", null)
      .eq("org_id", orgA);
    expect(r.error, r.error?.message).toBeNull();
    expect(await truth("notifications", A.note!, "read_at")).not.toBeNull();
    expect(
      await truth("notifications", B.note!, "read_at"),
      "org B's unread queue must be left alone",
    ).toBeNull();
  });
});
