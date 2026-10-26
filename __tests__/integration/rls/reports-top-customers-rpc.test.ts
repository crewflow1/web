import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { userClient } from "../_harness";

/**
 * Reports R2 — reports_top_customers_by_revenue (real Postgres).
 *
 * The TypeScript topCustomersByRevenue() used to fetch EVERY paid invoice + EVERY
 * customer for the org and group/sum/sort in TS; R2 moves that into the SECURITY
 * DEFINER RPC reports_top_customers_by_revenue (migration 20261237000000). This
 * suite proves the RPC reproduces the OLD contract EXACTLY against a real schema
 * — the only tier that can, because the behaviour is now SQL:
 *
 *   SNAPSHOT EQUALITY — a representative fixture (two multi-invoice customers, a
 *     VAT-bearing invoice, a quote-fallback customer, a tie pair straddling the
 *     top-N boundary, a zero-revenue customer, an Unattributed invoice, and an
 *     UNPAID invoice that must not count) yields an EXACT ranking + per-bucket
 *     revenue/count, deterministically ordered.
 *
 *   RECONCILIATION — Σ(revenue over ALL buckets, incl. Unattributed) equals the
 *     sum of every paid invoice's ex-VAT `amount`. No paid revenue is dropped by
 *     attribution, so the ranking reconciles with revenuePerMonth (same `amount`,
 *     same status='paid' filter). This is the identity the perf map stressed.
 *
 *   SECURITY — the canonical secdef-org guard: a NON-member is refused 42501; a
 *     member gets exactly the service-role ground truth. (The whole secdef-org
 *     class is also covered generically by secdef-org-rpc-guard.test.ts, which
 *     this function auto-passes because it uses current_org_ids() + 42501.)
 *
 *   ISOLATION — a second org's paid invoice never appears in the first org's
 *     ranking, and a cross-org quote_id cannot contribute a foreign customer.
 *
 * Revenue is EX-VAT (`amount`): a VAT-bearing invoice contributes its net amount,
 * never the gross generated `total`.
 */

type Row = Record<string, unknown>;
interface Res<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<Row[]>>;
  };
const db = (client: unknown) =>
  client as unknown as {
    from(t: string): {
      insert(rows: Row | Row[]): PromiseLike<{ error: { message: string } | null }> & {
        select(c: string): { single(): PromiseLike<{ data: Row | null; error: { message: string } | null }> };
      };
      delete(): { eq(k: string, v: unknown): PromiseLike<{ error: { message: string } | null }> };
    };
  };

const T = `it-topcust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Normalise an RPC ranking row to compare numbers regardless of JSON typing. */
type Bucket = { id: string | null; name: string; revenue: number; count: number };
const norm = (rows: Row[] | null): Bucket[] =>
  (rows ?? []).map((r) => ({
    id: (r.customer_id as string | null) ?? null,
    name: String(r.name),
    revenue: Number(r.revenue),
    count: Number(r.invoice_count),
  }));

describeIntegration("reports · reports_top_customers_by_revenue (R2)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let adminA = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  // Customer ids (org A).
  let c1 = ""; // two paid invoices → 150 / 2
  let c2 = ""; // one VAT-bearing paid invoice → 200 / 1 (ex-VAT, total would be 240)
  let c3 = ""; // ZERO paid invoices → must be absent from the ranking
  let cq = ""; // resolved only via the quote fallback → 75 / 1
  let t1 = ""; // tie pair, 90 each, straddles the top-N boundary
  let t2 = "";

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${suffix}@example.test`;
    const password = `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id, email, full_name: `TopCust ${suffix}` }).select("id").single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(label: string): Promise<string> {
    const r = await svc().from("organizations").insert({ name: `TopCust ${label}`, slug: `${T}-${label}` }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeCustomer(org: string, name: string): Promise<string> {
    const r = await svc().from("customers").insert({ org_id: org, name }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  let n = 0;
  async function makeInvoice(org: string, fields: Row): Promise<void> {
    n += 1;
    const r = await svc()
      .from("invoices")
      .insert({
        org_id: org,
        number: `${T}-INV-${n}`,
        amount: 0,
        vat_total: 0,
        status: "paid",
        paid_at: new Date().toISOString(),
        ...fields,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
  }

  async function makeQuote(org: string, customerId: string): Promise<string> {
    n += 1;
    const r = await svc()
      .from("quotes")
      .insert({ org_id: org, customer_id: customerId, number: `${T}-Q-${n}`, subtotal: 100, vat_total: 0 })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");
    adminA = await makeUser("admin-a");
    adminB = await makeUser("admin-b");
    for (const [org, user] of [
      [orgA, adminA.id],
      [orgB, adminB.id],
    ] as const) {
      const m = await svc().from("memberships").insert({ org_id: org, user_id: user, role: "admin" }).select("user_id").single();
      expect(m.error, m.error?.message).toBeNull();
    }

    c1 = await makeCustomer(orgA, "C1 Builders");
    c2 = await makeCustomer(orgA, "C2 Roofing");
    c3 = await makeCustomer(orgA, "C3 Dormant"); // zero-revenue
    cq = await makeCustomer(orgA, "CQ Glazing");
    t1 = await makeCustomer(orgA, "Tie-Alpha");
    t2 = await makeCustomer(orgA, "Tie-Beta");

    // C1 — two paid invoices: 100 + 50 = 150.
    await makeInvoice(orgA, { customer_id: c1, amount: 100 });
    await makeInvoice(orgA, { customer_id: c1, amount: 50 });
    // C1 — an UNPAID invoice that must NOT count toward the ranking.
    await makeInvoice(orgA, { customer_id: c1, amount: 9999, status: "sent", paid_at: null });

    // C2 — VAT-bearing: ex-VAT amount 200 counts (gross total would be 240).
    await makeInvoice(orgA, { customer_id: c2, amount: 200, vat_total: 40 });

    // C3 — no paid invoice at all (seeded customer only): must be absent.

    // CQ — quote-fallback: invoice has NO customer_id but a quote whose
    // customer_id is CQ. coalesce(customer_id, quote.customer_id) → CQ.
    const qCq = await makeQuote(orgA, cq);
    await makeInvoice(orgA, { customer_id: null, quote_id: qCq, amount: 75 });

    // Tie pair — equal revenue 90, both single-invoice. The deterministic
    // tiebreak (name asc) must rank Tie-Alpha before Tie-Beta.
    await makeInvoice(orgA, { customer_id: t1, amount: 90 });
    await makeInvoice(orgA, { customer_id: t2, amount: 90 });

    // Unattributed — two paid invoices resolving to NEITHER a customer_id nor a
    // quote.customer: 40 + 10 = 50, grouped as one bucket, never dropped.
    await makeInvoice(orgA, { customer_id: null, quote_id: null, amount: 40 });
    await makeInvoice(orgA, { customer_id: null, quote_id: null, amount: 10 });

    // Org B — a differently-sized paid invoice that must NEVER reach org A.
    const cB = await makeCustomer(orgB, "Foreign Co");
    await makeInvoice(orgB, { customer_id: cB, amount: 7777 });
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    for (const u of [adminA.id, adminB.id]) if (u) await serviceClient().auth.admin.deleteUser(u).catch(() => undefined);
  });

  // ── Snapshot equality (service-role ground truth) ─────────────────────────

  it("returns the EXACT full ranking, deterministically ordered, ex-VAT", async () => {
    const { data, error } = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", {
      p_org_id: orgA,
      p_limit: 50,
    });
    expect(error, error?.message).toBeNull();
    const got = norm(data);

    // revenue desc; tie (90/90) broken by invoice_count desc then name asc, so
    // Tie-Alpha precedes Tie-Beta; the Unattributed bucket (null id) is last.
    const expected: Bucket[] = [
      { id: c2, name: "C2 Roofing", revenue: 200, count: 1 }, // ex-VAT, not 240
      { id: c1, name: "C1 Builders", revenue: 150, count: 2 },
      { id: t1, name: "Tie-Alpha", revenue: 90, count: 1 },
      { id: t2, name: "Tie-Beta", revenue: 90, count: 1 },
      { id: cq, name: "CQ Glazing", revenue: 75, count: 1 }, // quote fallback
      { id: null, name: "—", revenue: 50, count: 2 }, // Unattributed (SQL name; TS maps the label)
    ];
    expect(got).toEqual(expected);

    // The zero-revenue customer is absent, and the unpaid invoice did not count.
    expect(got.some((b) => b.id === c3)).toBe(false);
    expect(got.find((b) => b.id === c1)?.revenue).toBe(150);
  });

  it("RECONCILES: Σ(revenue over all buckets) == Σ(paid-invoice amount) for the org", async () => {
    const { data } = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", {
      p_org_id: orgA,
      p_limit: 50,
    });
    const rankedTotal = norm(data).reduce((s, b) => s + b.revenue, 0);

    // Ground truth straight off the ledger (service-role, ex-VAT amount).
    const paid = (await (serviceClient() as unknown as {
      from(t: string): {
        select(c: string): {
          eq(k: string, v: unknown): {
            eq(k: string, v: unknown): PromiseLike<{ data: Array<{ amount: number | null }> | null; error: { message: string } | null }>;
          };
        };
      };
    })
      .from("invoices")
      .select("amount")
      .eq("org_id", orgA)
      .eq("status", "paid"));
    expect(paid.error, paid.error?.message).toBeNull();
    const ledgerTotal = (paid.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);

    expect(rankedTotal).toBe(ledgerTotal);
    expect(rankedTotal).toBe(200 + 150 + 90 + 90 + 75 + 50);
  });

  it("applies the top-N limit after the deterministic sort", async () => {
    const { data, error } = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", {
      p_org_id: orgA,
      p_limit: 2,
    });
    expect(error, error?.message).toBeNull();
    expect(norm(data)).toEqual([
      { id: c2, name: "C2 Roofing", revenue: 200, count: 1 },
      { id: c1, name: "C1 Builders", revenue: 150, count: 2 },
    ]);

    // N=3 straddles the tie: the tiebreak must include Tie-Alpha, not Tie-Beta.
    const three = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", { p_org_id: orgA, p_limit: 3 });
    expect(norm(three.data).map((b) => b.id)).toEqual([c2, c1, t1]);
  });

  // ── Security + isolation ──────────────────────────────────────────────────

  it("refuses a NON-member with 42501 (canonical secdef-org guard)", async () => {
    const { error } = await rpc(userClient(adminB.token)).rpc("reports_top_customers_by_revenue", {
      p_org_id: orgA,
      p_limit: 10,
    });
    expect(error?.code, `org B admin must be denied org A's ranking: ${error?.message}`).toBe("42501");
  });

  it("a MEMBER gets exactly the service-role ground truth", async () => {
    const asMember = await rpc(userClient(adminA.token)).rpc("reports_top_customers_by_revenue", { p_org_id: orgA, p_limit: 50 });
    expect(asMember.error, asMember.error?.message).toBeNull();
    const asService = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", { p_org_id: orgA, p_limit: 50 });
    expect(norm(asMember.data)).toEqual(norm(asService.data));
  });

  it("never leaks another org's revenue into the ranking", async () => {
    const { data } = await rpc(serviceClient()).rpc("reports_top_customers_by_revenue", { p_org_id: orgA, p_limit: 50 });
    const got = norm(data);
    expect(got.some((b) => b.revenue === 7777)).toBe(false);
    expect(got.some((b) => b.name === "Foreign Co")).toBe(false);
  });
});
