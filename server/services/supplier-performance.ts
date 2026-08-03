import "server-only";

import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  computeSupplierPerformance,
  type PerfBillRow,
  type PerfGrnLineRow,
  type PerfGrnRow,
  type PerfPoLineRow,
  type PerfPoRow,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";

/**
 * Supplier performance — the READ layer.
 *
 * READ-ONLY BY CONSTRUCTION. This module exports no write, calls no `.insert`,
 * `.update`, `.upsert`, `.delete` or `.rpc`, and touches `finances` only with a
 * `select`. Performance is an observation OF the record; it must never be able
 * to change the record it observes, and in particular it must never post to
 * `finances` — a metric surface that could move money would be a second,
 * unaudited path into the ledger. `__tests__/security/
 * supplier-performance-readonly.test.ts` pins this by grepping the source.
 *
 * ACTIVE-ORG PINNED. Every query carries `.eq("org_id", orgId)` on top of RLS,
 * for the reason server/services/suppliers.ts sets out at length:
 * `current_org_ids()` admits EVERY org the viewer belongs to, so RLS alone
 * BLENDS a dual-org member's two companies. That is unusually damaging here.
 * Merchants are shared — the same JP Corry account serves both of an owner's
 * companies — so an unpinned read would compute one "supplier record" out of
 * two companies' trading history, and the operator would be making a buying
 * decision for company A on deliveries that were made to company B. Proven
 * against real Postgres in
 * `__tests__/integration/rls/supplier-performance-active-org.test.ts`.
 *
 * LOUD READS. Every query's error is thrown through `readFailure`, never
 * swallowed to `?? []`. An empty performance record and a failed query look
 * identical once the rows are gone, and of the two the silent one is worse: a
 * supplier with a poor delivery record would render as a clean sheet, which is
 * the exact inverse of the truth. There is no `reportReadFailure` panel path
 * here on purpose — a partially-read performance record is a WRONG performance
 * record (a dropped GRN page changes a rate), so these surfaces fail whole.
 *
 * THE CLIENT IS AN ARGUMENT, never created inside. This mirrors
 * server/services/suppliers.ts and server/services/rota.ts, and it is what makes
 * the org pins provable rather than merely reviewed: the integration suite drives
 * these EXACT functions with a real dual-org user's JWT against real Postgres, so
 * deleting an `.eq("org_id", orgId)` goes red in
 * `__tests__/integration/rls/supplier-performance-active-org.test.ts` instead of
 * having to be spotted by eye. A service that reached for `createClient()`
 * internally could only ever be source-pinned.
 *
 * None of these tables are in the generated Supabase types, so `.from` is
 * reached through the loose structural shim below — the same seam
 * server/services/supplier-payments.ts and server/services/cis.ts use.
 */

// ---------------------------------------------------------------------------
// Loose client shim (see the header note on generated types)
// ---------------------------------------------------------------------------

type Res<T> = { data: T | null; error: SupabaseReadError | null };

type Filter<T> = PromiseLike<Res<T[]>> & {
  eq: (k: string, v: unknown) => Filter<T>;
  in: (k: string, v: readonly unknown[]) => Filter<T>;
  order: (k: string, o?: { ascending?: boolean }) => Filter<T>;
  limit: (n: number) => Filter<T>;
  range: (from: number, to: number) => Filter<T>;
};

/** The read surface this service needs. Satisfied by a Supabase client. */
export type PerformanceClient = {
  from: (t: string) => { select: <T>(cols: string) => Filter<T> };
};

/**
 * Read caps. Performance is a whole-history measure, so these are deliberately
 * generous — and they are the reason `n` is displayed on every ratio: a
 * denominator the operator can see is a denominator they can sanity-check
 * against the underlying lists.
 */
const PO_LIMIT = 1000;
const GRN_LIMIT = 2000;
const LINE_LIMIT = 5000;
const BILL_LIMIT = 1000;
const PAYMENT_LIMIT = 1000;

/**
 * Every paged/limited read below is ordered on a UNIQUE TOTAL ORDER — the
 * domain column first, then `id` as the tiebreak. Without the tiebreak Postgres
 * may return rows in any order among ties, so a capped read can silently drop a
 * different row on each request and a rate would flicker between page loads.
 */
const PO_COLUMNS = "id, number, status, expected_date, total";
const GRN_COLUMNS = "id, purchase_order_id, status, number, delivery_date";
const PO_LINE_COLUMNS = "id, purchase_order_id, description, qty, unit";
const GRN_LINE_COLUMNS = "goods_received_note_id, purchase_order_line_item_id, qty_received";
const BILL_COLUMNS =
  "id, amount, vat_total, reference, bill_date, category, job_id, purchase_order_id, created_at";
const PAYMENT_COLUMNS =
  "id, paid_at, method, reference, gross_amount, cis_withheld, net_paid, voided_at, void_reason";

// ---------------------------------------------------------------------------
// One supplier's record
// ---------------------------------------------------------------------------

/** The raw rows a performance record is computed from, all active-org scoped. */
export type SupplierPerformanceSources = {
  purchaseOrders: PerfPoRow[];
  grns: PerfGrnRow[];
  poLines: PerfPoLineRow[];
  grnLines: PerfGrnLineRow[];
  bills: PerfBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
};

/**
 * Load everything one supplier's performance record needs.
 *
 * Ordering of the reads is forced by the data, not by preference: GRNs can only
 * be found through the supplier's PURCHASE ORDERS (a GRN has no supplier_id of
 * its own — it reaches the supplier through `purchase_orders.supplier_id`), and
 * the received LINES can only be found through those GRNs. Each step therefore
 * filters by ids returned from the previous one, which also means a row can
 * never enter the result set without an active-org-scoped ancestor.
 */
export async function loadSupplierPerformanceSources(
  db: PerformanceClient,
  orgId: string,
  supplierId: string,
): Promise<SupplierPerformanceSources> {
  const c = db;

  // 1. This supplier's purchase orders, in THIS org.
  const poRes = await c
    .from("purchase_orders")
    .select<PerfPoRow>(PO_COLUMNS)
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(PO_LIMIT);
  if (poRes.error) throw readFailure("supplier performance: purchase orders", poRes.error);
  const purchaseOrders = poRes.data ?? [];
  const poIds = purchaseOrders.map((p) => p.id);

  // 2. Bills + payments do not depend on the orders, so they go in parallel.
  const [billsRes, paymentsRes] = await Promise.all([
    c
      .from("finances")
      .select<PerfBillRow>(BILL_COLUMNS)
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(BILL_LIMIT),
    c
      .from("supplier_payments")
      .select<SupplierPaymentRow>(PAYMENT_COLUMNS)
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .order("paid_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PAYMENT_LIMIT),
  ]);
  if (billsRes.error) throw readFailure("supplier performance: bills", billsRes.error);
  // supplier_payments is admin-only at the RLS layer, so a non-admin reads an
  // EMPTY set without an error — the same asymmetry getSupplierLedger
  // documents. That is why the settlement-speed block is role-gated on the
  // page rather than gated on whether any payment came back.
  if (paymentsRes.error) throw readFailure("supplier performance: payments", paymentsRes.error);
  const bills = billsRes.data ?? [];
  const payments = paymentsRes.data ?? [];

  // 3. GRNs + ordered lines, reached through the orders from step 1.
  let grns: PerfGrnRow[] = [];
  let poLines: PerfPoLineRow[] = [];
  if (poIds.length > 0) {
    const [grnRes, lineRes] = await Promise.all([
      c
        .from("goods_received_notes")
        .select<PerfGrnRow>(GRN_COLUMNS)
        .eq("org_id", orgId)
        .in("purchase_order_id", poIds)
        .order("delivery_date", { ascending: false })
        .order("id", { ascending: true })
        .limit(GRN_LIMIT),
      c
        .from("purchase_order_line_items")
        .select<PerfPoLineRow>(PO_LINE_COLUMNS)
        .eq("org_id", orgId)
        .in("purchase_order_id", poIds)
        .order("purchase_order_id", { ascending: true })
        .order("id", { ascending: true })
        .limit(LINE_LIMIT),
    ]);
    if (grnRes.error) throw readFailure("supplier performance: goods received notes", grnRes.error);
    if (lineRes.error) throw readFailure("supplier performance: ordered lines", lineRes.error);
    grns = grnRes.data ?? [];
    poLines = lineRes.data ?? [];
  }

  // 4. Received quantities, reached through the GRNs from step 3.
  let grnLines: PerfGrnLineRow[] = [];
  const grnIds = grns.map((g) => g.id);
  if (grnIds.length > 0) {
    const res = await c
      .from("goods_received_lines")
      .select<PerfGrnLineRow>(GRN_LINE_COLUMNS)
      .eq("org_id", orgId)
      .in("goods_received_note_id", grnIds)
      .order("goods_received_note_id", { ascending: true })
      .order("purchase_order_line_item_id", { ascending: true })
      .limit(LINE_LIMIT);
    if (res.error) throw readFailure("supplier performance: received lines", res.error);
    grnLines = res.data ?? [];
  }

  // 5. Allocations, fetched BY PAYMENT ID so the result can never include a row
  //    belonging to a payment we did not read (getSupplierLedger's rule).
  let allocations: SupplierAllocationRow[] = [];
  if (payments.length > 0) {
    const res = await c
      .from("supplier_payment_allocations")
      .select<SupplierAllocationRow>("payment_id, finance_id, amount")
      .eq("org_id", orgId)
      .in(
        "payment_id",
        payments.map((p) => p.id),
      );
    if (res.error) throw readFailure("supplier performance: allocations", res.error);
    allocations = res.data ?? [];
  }

  return { purchaseOrders, grns, poLines, grnLines, bills, payments, allocations };
}

/** One supplier's measured record, computed from active-org-scoped rows. */
export async function getSupplierPerformance(
  db: PerformanceClient,
  orgId: string,
  supplierId: string,
  supplierName: string,
): Promise<{ performance: SupplierPerformance; sources: SupplierPerformanceSources }> {
  const sources = await loadSupplierPerformanceSources(db, orgId, supplierId);
  return {
    performance: computeSupplierPerformance({ supplierId, supplierName, ...sources }),
    sources,
  };
}

// ---------------------------------------------------------------------------
// The comparison across suppliers
// ---------------------------------------------------------------------------

/**
 * How many suppliers the comparison view measures at once. A ceiling rather
 * than a page, because the comparison is only useful when every candidate is on
 * screen together; the surface states the cap when it is hit rather than
 * silently truncating a shortlist.
 */
export const COMPARISON_SUPPLIER_LIMIT = 60;

/**
 * Every supplier's record, for the buying decision.
 *
 * Reads the whole org's orders/GRNs/bills ONCE and partitions in memory rather
 * than running the per-supplier loader N times: 60 suppliers through
 * `loadSupplierPerformanceSources` would be 300+ round trips, and each would
 * re-read the same `purchase_order_line_items`. Same queries, same org pin,
 * same loud-read discipline — just grouped by supplier_id afterwards.
 *
 * PAGED (F-1). The single-supplier loader's `.limit(PO_LIMIT/GRN_LIMIT/…)` caps
 * are PER-SUPPLIER ceilings; reused here across the WHOLE shortlist they became
 * ORG-WIDE caps, so an org with more than (say) 1000 purchase orders across its
 * suppliers had the tail silently dropped and every downstream rate computed
 * from a truncated denominator. Each org-wide read below therefore pages through
 * `fetchAllRows` on its existing unique (domain col + `id`) total order instead
 * of taking a single capped page.
 *
 * Suppliers with NOTHING measurable are returned too (with `empty: true`), so
 * the surface can distinguish "we have never bought from them" from "they have
 * a clean record" — collapsing those two is how an untried supplier comes to
 * look like a proven one.
 */
export async function listSupplierPerformance(
  db: PerformanceClient,
  orgId: string,
  suppliers: Array<{ id: string; name: string }>,
): Promise<SupplierPerformance[]> {
  if (suppliers.length === 0) return [];
  const c = db;
  const supplierIds = suppliers.map((s) => s.id);

  const poRes = await fetchAllRows<PerfPoRow & { supplier_id: string | null }>((from, to) =>
    c
      .from("purchase_orders")
      .select<PerfPoRow & { supplier_id: string | null }>(`${PO_COLUMNS}, supplier_id`)
      .eq("org_id", orgId)
      .in("supplier_id", supplierIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (poRes.error) throw readFailure("supplier comparison: purchase orders", poRes.error);
  const allPos = poRes.data ?? [];
  const poIds = allPos.map((p) => p.id);

  const [billsRes, paymentsRes] = await Promise.all([
    fetchAllRows<PerfBillRow & { supplier_id: string | null }>((from, to) =>
      c
        .from("finances")
        .select<PerfBillRow & { supplier_id: string | null }>(`${BILL_COLUMNS}, supplier_id`)
        .eq("org_id", orgId)
        .in("supplier_id", supplierIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<SupplierPaymentRow & { supplier_id: string | null }>((from, to) =>
      c
        .from("supplier_payments")
        .select<SupplierPaymentRow & { supplier_id: string | null }>(
          `${PAYMENT_COLUMNS}, supplier_id`,
        )
        .eq("org_id", orgId)
        .in("supplier_id", supplierIds)
        .order("paid_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);
  if (billsRes.error) throw readFailure("supplier comparison: bills", billsRes.error);
  if (paymentsRes.error) throw readFailure("supplier comparison: payments", paymentsRes.error);
  const allBills = billsRes.data ?? [];
  const allPayments = paymentsRes.data ?? [];

  let allGrns: PerfGrnRow[] = [];
  let allPoLines: PerfPoLineRow[] = [];
  if (poIds.length > 0) {
    const [grnRes, lineRes] = await Promise.all([
      fetchAllRows<PerfGrnRow>((from, to) =>
        c
          .from("goods_received_notes")
          .select<PerfGrnRow>(GRN_COLUMNS)
          .eq("org_id", orgId)
          .in("purchase_order_id", poIds)
          .order("delivery_date", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<PerfPoLineRow>((from, to) =>
        c
          .from("purchase_order_line_items")
          .select<PerfPoLineRow>(PO_LINE_COLUMNS)
          .eq("org_id", orgId)
          .in("purchase_order_id", poIds)
          .order("purchase_order_id", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ]);
    if (grnRes.error) throw readFailure("supplier comparison: goods received notes", grnRes.error);
    if (lineRes.error) throw readFailure("supplier comparison: ordered lines", lineRes.error);
    allGrns = grnRes.data ?? [];
    allPoLines = lineRes.data ?? [];
  }

  let allGrnLines: PerfGrnLineRow[] = [];
  const grnIds = allGrns.map((g) => g.id);
  if (grnIds.length > 0) {
    const res = await fetchAllRows<PerfGrnLineRow>((from, to) =>
      c
        .from("goods_received_lines")
        .select<PerfGrnLineRow>(GRN_LINE_COLUMNS)
        .eq("org_id", orgId)
        .in("goods_received_note_id", grnIds)
        .order("goods_received_note_id", { ascending: true })
        .order("purchase_order_line_item_id", { ascending: true })
        .range(from, to),
    );
    if (res.error) throw readFailure("supplier comparison: received lines", res.error);
    allGrnLines = res.data ?? [];
  }

  let allAllocations: SupplierAllocationRow[] = [];
  if (allPayments.length > 0) {
    // Paged too: an org's allocations grow with every payment settled, so this
    // `.in(payment_id, …)` read is org-wide-unbounded just like the others.
    // supplier_payment_allocations has a unique `id` PK — order on it for a
    // stable page boundary even though the grouping below is by supplier.
    const res = await fetchAllRows<SupplierAllocationRow>((from, to) =>
      c
        .from("supplier_payment_allocations")
        .select<SupplierAllocationRow>("payment_id, finance_id, amount")
        .eq("org_id", orgId)
        .in(
          "payment_id",
          allPayments.map((p) => p.id),
        )
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (res.error) throw readFailure("supplier comparison: allocations", res.error);
    allAllocations = res.data ?? [];
  }

  // ── Partition by supplier ────────────────────────────────────────────────
  const posBySupplier = new Map<string, PerfPoRow[]>();
  const poToSupplier = new Map<string, string>();
  for (const po of allPos) {
    if (!po.supplier_id) continue;
    poToSupplier.set(po.id, po.supplier_id);
    const list = posBySupplier.get(po.supplier_id);
    if (list) list.push(po);
    else posBySupplier.set(po.supplier_id, [po]);
  }

  const grnsBySupplier = new Map<string, PerfGrnRow[]>();
  const grnToSupplier = new Map<string, string>();
  for (const grn of allGrns) {
    const sid = poToSupplier.get(grn.purchase_order_id);
    if (!sid) continue;
    grnToSupplier.set(grn.id, sid);
    const list = grnsBySupplier.get(sid);
    if (list) list.push(grn);
    else grnsBySupplier.set(sid, [grn]);
  }

  const poLinesBySupplier = new Map<string, PerfPoLineRow[]>();
  for (const line of allPoLines) {
    const sid = poToSupplier.get(line.purchase_order_id);
    if (!sid) continue;
    const list = poLinesBySupplier.get(sid);
    if (list) list.push(line);
    else poLinesBySupplier.set(sid, [line]);
  }

  const grnLinesBySupplier = new Map<string, PerfGrnLineRow[]>();
  for (const line of allGrnLines) {
    const sid = grnToSupplier.get(line.goods_received_note_id);
    if (!sid) continue;
    const list = grnLinesBySupplier.get(sid);
    if (list) list.push(line);
    else grnLinesBySupplier.set(sid, [line]);
  }

  const billsBySupplier = new Map<string, PerfBillRow[]>();
  for (const bill of allBills) {
    const sid = bill.supplier_id;
    if (!sid) continue;
    const list = billsBySupplier.get(sid);
    if (list) list.push(bill);
    else billsBySupplier.set(sid, [bill]);
  }

  const paymentsBySupplier = new Map<string, SupplierPaymentRow[]>();
  const paymentToSupplier = new Map<string, string>();
  for (const p of allPayments) {
    const sid = p.supplier_id;
    if (!sid) continue;
    paymentToSupplier.set(p.id, sid);
    const list = paymentsBySupplier.get(sid);
    if (list) list.push(p);
    else paymentsBySupplier.set(sid, [p]);
  }

  const allocationsBySupplier = new Map<string, SupplierAllocationRow[]>();
  for (const a of allAllocations) {
    const sid = paymentToSupplier.get(a.payment_id);
    if (!sid) continue;
    const list = allocationsBySupplier.get(sid);
    if (list) list.push(a);
    else allocationsBySupplier.set(sid, [a]);
  }

  return suppliers.map((s) =>
    computeSupplierPerformance({
      supplierId: s.id,
      supplierName: s.name,
      purchaseOrders: posBySupplier.get(s.id) ?? [],
      grns: grnsBySupplier.get(s.id) ?? [],
      poLines: poLinesBySupplier.get(s.id) ?? [],
      grnLines: grnLinesBySupplier.get(s.id) ?? [],
      bills: billsBySupplier.get(s.id) ?? [],
      payments: paymentsBySupplier.get(s.id) ?? [],
      allocations: allocationsBySupplier.get(s.id) ?? [],
    }),
  );
}
