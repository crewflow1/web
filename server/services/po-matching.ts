import "server-only";

import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { round2, sumMoney } from "@/lib/money";
import {
  compareMatchSeverity,
  matchThreeWay,
  type MatchBill,
  type MatchGrn,
  type MatchOrderedLine,
  type ThreeWayMatch,
} from "@/lib/purchase-orders/matching";

/**
 * THREE-WAY MATCH — the read layer behind /purchase-orders/matching.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  READ-ONLY, WITHOUT EXCEPTION. This file contains no insert, no update,  ║
 * ║  no upsert, no delete and no rpc. Detecting that a supplier has          ║
 * ║  over-billed must never post a correction: the actual cost lands exactly ║
 * ║  once, when recordSupplierBill posts the supplier's invoice, and a       ║
 * ║  "helpful" adjustment here would double-count the same spend against the ║
 * ║  same job — the invariant the whole receiving milestone was built around.║
 * ║  Held by __tests__/security/three-way-bill-matching.test.ts.             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * TWO INVARIANTS, the same two the stock service holds:
 *
 * 1. ORG-PINNED, not merely RLS-scoped. Every policy involved here
 *    (purchase_orders, purchase_order_line_items, goods_received_notes,
 *    goods_received_lines, finances) is `org_id in (select current_org_ids())`,
 *    which passes for EVERY org the viewer belongs to. Without the pin a
 *    dual-org member would get one queue containing both companies' orders,
 *    deliveries and supplier bills — and worse, one company's GRN could be
 *    matched against another company's bill, manufacturing a variance that does
 *    not exist and hiding one that does. Every query below therefore carries
 *    `.eq("org_id", orgId)`, and the security test counts the pins against the
 *    `.select(` calls. Proven load-bearing against real Postgres in
 *    __tests__/integration/rls/po-matching-isolation.test.ts.
 *
 * 2. LOUD READS (the #480 doctrine). Every read binds `error` and throws
 *    `readFailure(...)`. For THIS surface that is the whole point: an empty
 *    discrepancy queue means "your supplier billing is clean", which is the
 *    single most dangerous sentence this product could say off the back of a
 *    rejected query. "No discrepancies" and "we could not look" must never be
 *    the same picture.
 *
 * VOLUME. Each entity is read with `fetchAllRows` under a UNIQUE TOTAL ORDER
 * (`id` ascending — the primary key), so no page edge can drop or repeat a row
 * and no org is silently truncated at the PostgREST 1000-row cap. SEVEN reads
 * serve the whole queue — orders, then five in one batch, then the unlinked
 * bills — and there is no per-order query anywhere, so a company with 400
 * purchase orders costs the same round trips as one with four. The unlinked-bill
 * read is deliberately left OUT of the batch so that when two reads fail the
 * error the user gets names the right one, rather than whichever lost the race.
 *
 * The client is passed in (mirrors server/services/stock.ts and sites.ts) so the
 * integration suite can drive the EXACT same queries with a real dual-org user's
 * JWT. purchase_orders / goods_received_notes and friends are newer than the
 * generated Supabase types, so the client is reached through the loose shape
 * below — the established cast style on this surface.
 */

type Row = Record<string, unknown>;
type Err = { message?: string | null; code?: string | null } | null;

export type PoMatchingClient = { from: (t: string) => PoMatchingBuilder };

type PoMatchingBuilder = PromiseLike<{ data: Row[] | null; error: Err }> & {
  select: (c: string) => PoMatchingBuilder;
  eq: (k: string, v: unknown) => PoMatchingBuilder;
  in: (k: string, v: readonly unknown[]) => PoMatchingBuilder;
  is: (k: string, v: null) => PoMatchingBuilder;
  not: (k: string, op: string, v: null) => PoMatchingBuilder;
  order: (k: string, o: { ascending: boolean }) => PoMatchingBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

/**
 * How many unlinked supplier bills the footer reports. A bill with no order is
 * a cost that cannot be three-way matched at all; the queue names the number
 * and the total rather than listing hundreds of them.
 */
export const UNLINKED_BILL_SAMPLE = 25;

export type MatchedOrder = {
  id: string;
  number: string;
  status: string;
  supplierName: string | null;
  jobId: string | null;
  expectedDate: string | null;
  /** Every note on the order (draft/posted/void) — the lib decides what counts. */
  grns: Array<{ id: string; number: string; status: string; deliveryDate: string | null }>;
  bills: Array<{ id: string; reference: string | null; billDate: string | null; gross: number }>;
  match: ThreeWayMatch;
};

/** A supplier bill that references no purchase order — unmatchable by construction. */
export type UnlinkedBill = {
  id: string;
  reference: string | null;
  billDate: string | null;
  supplierId: string | null;
  jobId: string | null;
  gross: number;
};

export type PoMatchingQueue = {
  /** Orders with at least one variance, worst first. */
  discrepancies: MatchedOrder[];
  /** Every order examined, flagged or not — the denominator for "n of m". */
  examined: number;
  /**
   * Totals across the flagged orders, gross £.
   *
   * The three per-kind figures are for DISPLAY, each under its own label — they
   * must NOT be added together, because `overBilled` and `billedNotReceived` are
   * frequently the same pounds counted twice (an order invoiced £120 over and
   * fully delivered reads £120 under both). `moneyOutAtRisk` is the one figure
   * that is safe to sum and is what the Daily Briefing headline uses.
   */
  totals: {
    overBilled: number;
    billedNotReceived: number;
    receivedNotBilled: number;
    /** Σ per-order (billed − min(committed, received)) — no double count. */
    moneyOutAtRisk: number;
  };
  /** Supplier bills carrying no purchase_order_id (a sample, plus the true count). */
  unlinkedBills: UnlinkedBill[];
  unlinkedBillCount: number;
  unlinkedBillTotal: number;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
/** A `numeric` column as PostgREST hands it over: number, string, or absent. */
function money(v: unknown): number | string | null {
  return typeof v === "number" || typeof v === "string" ? v : null;
}
/** Narrow an unknown PostgREST error to the shape readFailure reads. */
function asReadError(e: unknown): SupabaseReadError {
  return (e ?? { message: "unknown error" }) as SupabaseReadError;
}

/**
 * Page an org-pinned read to completion under a unique total order.
 *
 * `id` is the primary key on every table read here, so the ordering is total by
 * construction — the contract `fetchAllRows` documents. The error is returned,
 * never swallowed: each caller throws `readFailure` with its own context.
 */
async function pagedRows(
  db: PoMatchingClient,
  table: string,
  columns: string,
  orgId: string,
  narrow?: (q: PoMatchingBuilder) => PoMatchingBuilder,
): Promise<{ rows: Row[]; error: unknown }> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    const base = db
      .from(table)
      .select(columns)
      .eq("org_id", orgId); // ACTIVE-ORG PIN
    return (narrow ? narrow(base) : base).order("id", { ascending: true }).range(from, to);
  });
  return { rows: data, error };
}

/**
 * Build the whole discrepancy queue for one org.
 *
 * CANCELLED orders are read too, deliberately: a bill sitting against an order
 * the company cancelled is one of the sharpest variances there is, and the
 * matching lib treats a cancelled order as committing nothing (the definition
 * `computeCommittedCosts` already uses) so it surfaces as over-billed by its
 * whole value instead of quietly reading as a perfect match.
 */
export async function loadPoMatchingQueue(
  db: PoMatchingClient,
  orgId: string,
): Promise<PoMatchingQueue> {
  const orders = await pagedRows(
    db,
    "purchase_orders",
    "id, number, status, supplier_id, job_id, expected_date",
    orgId,
  );
  if (orders.error) throw readFailure("po matching: purchase orders", asReadError(orders.error));

  if (orders.rows.length === 0) {
    const empty = await loadUnlinkedBills(db, orgId);
    return {
      discrepancies: [],
      examined: 0,
      totals: { overBilled: 0, billedNotReceived: 0, receivedNotBilled: 0, moneyOutAtRisk: 0 },
      ...empty,
    };
  }

  // NO `.in("purchase_order_id", <every order id>)` NARROWING, on purpose. The
  // read above takes EVERY order in the org, so the org pin alone already
  // selects exactly the right lines, notes and receipts — a redundant `in`
  // filter would add nothing but a URL carrying hundreds of UUIDs, which is its
  // own failure mode. Cross-org contamination is impossible: goods_received_*
  // are bound to their order by COMPOSITE FK (20261059) and a `finances` row's
  // purchase_order_id is held same-org by tg_finances_bill_org_integrity
  // (20261009), so every org_id-matching child belongs to an order read here.
  const [lines, notes, noteLines, bills, suppliers] = await Promise.all([
    pagedRows(
      db,
      "purchase_order_line_items",
      "id, purchase_order_id, description, unit, qty, unit_price, vat_rate, sort_order",
      orgId,
    ),
    pagedRows(db, "goods_received_notes", "id, purchase_order_id, number, status, delivery_date", orgId),
    pagedRows(
      db,
      "goods_received_lines",
      "id, goods_received_note_id, purchase_order_line_item_id, qty_received",
      orgId,
    ),
    pagedRows(
      db,
      "finances",
      "id, purchase_order_id, amount, vat_total, reference, bill_date",
      orgId,
      (q) => q.not("purchase_order_id", "is", null),
    ),
    pagedRows(db, "suppliers", "id, name", orgId),
  ]);
  if (lines.error) throw readFailure("po matching: order lines", asReadError(lines.error));
  if (notes.error) throw readFailure("po matching: goods received notes", asReadError(notes.error));
  if (noteLines.error) throw readFailure("po matching: goods received lines", asReadError(noteLines.error));
  if (bills.error) throw readFailure("po matching: supplier bills", asReadError(bills.error));
  if (suppliers.error) throw readFailure("po matching: suppliers", asReadError(suppliers.error));

  const supplierName = new Map(suppliers.rows.map((s) => [str(s.id), str(s.name)]));

  const linesByOrder = new Map<string, MatchOrderedLine[]>();
  for (const l of lines.rows) {
    const key = str(l.purchase_order_id);
    const list = linesByOrder.get(key) ?? [];
    list.push({
      id: str(l.id),
      description: str(l.description),
      unit: strOrNull(l.unit),
      qty: l.qty as number | string | null,
      unit_price: l.unit_price as number | string | null,
      vat_rate: l.vat_rate as number | string | null,
      sort_order: typeof l.sort_order === "number" ? l.sort_order : null,
    });
    linesByOrder.set(key, list);
  }
  for (const list of linesByOrder.values()) {
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  }

  const grnLinesByNote = new Map<string, Array<{ purchase_order_line_item_id: string; qty_received: number | string | null }>>();
  for (const gl of noteLines.rows) {
    const key = str(gl.goods_received_note_id);
    const list = grnLinesByNote.get(key) ?? [];
    list.push({
      purchase_order_line_item_id: str(gl.purchase_order_line_item_id),
      qty_received: gl.qty_received as number | string | null,
    });
    grnLinesByNote.set(key, list);
  }

  const grnsByOrder = new Map<string, MatchGrn[]>();
  for (const n of notes.rows) {
    const key = str(n.purchase_order_id);
    const list = grnsByOrder.get(key) ?? [];
    list.push({
      id: str(n.id),
      number: str(n.number),
      status: str(n.status),
      delivery_date: strOrNull(n.delivery_date),
      lines: grnLinesByNote.get(str(n.id)) ?? [],
    });
    grnsByOrder.set(key, list);
  }

  const billsByOrder = new Map<string, MatchBill[]>();
  for (const b of bills.rows) {
    const key = str(b.purchase_order_id);
    if (!key) continue;
    const list = billsByOrder.get(key) ?? [];
    list.push({
      id: str(b.id),
      purchase_order_id: key,
      amount: b.amount as number | string | null,
      vat_total: b.vat_total as number | string | null,
      reference: strOrNull(b.reference),
      bill_date: strOrNull(b.bill_date),
    });
    billsByOrder.set(key, list);
  }

  const examinedRows: MatchedOrder[] = orders.rows.map((po) => {
    const id = str(po.id);
    const grns = grnsByOrder.get(id) ?? [];
    const poBills = billsByOrder.get(id) ?? [];
    const match = matchThreeWay({
      poId: id,
      lines: linesByOrder.get(id) ?? [],
      grns,
      bills: poBills,
      cancelled: str(po.status) === "cancelled",
    });
    return {
      id,
      number: str(po.number),
      status: str(po.status),
      supplierName: supplierName.get(str(po.supplier_id)) ?? null,
      jobId: strOrNull(po.job_id),
      expectedDate: strOrNull(po.expected_date),
      grns: grns.map((g) => ({
        id: g.id,
        number: g.number,
        status: g.status,
        deliveryDate: g.delivery_date ?? null,
      })),
      bills: poBills.map((b) => ({
        id: b.id,
        reference: b.reference ?? null,
        billDate: b.bill_date ?? null,
        gross: round2(sumMoney([money(b.amount), money(b.vat_total)])),
      })),
      match,
    };
  });

  const discrepancies = examinedRows
    .filter((r) => r.match.isDiscrepancy)
    .sort(compareMatchSeverity);

  const totalFor = (kind: "over_billed" | "billed_not_received" | "received_not_billed"): number =>
    sumMoney(
      discrepancies.map((r) => r.match.findings.find((f) => f.kind === kind)?.gross ?? 0),
    );

  const unlinked = await loadUnlinkedBills(db, orgId);

  return {
    discrepancies,
    examined: examinedRows.length,
    totals: {
      overBilled: totalFor("over_billed"),
      billedNotReceived: totalFor("billed_not_received"),
      receivedNotBilled: totalFor("received_not_billed"),
      moneyOutAtRisk: sumMoney(discrepancies.map((r) => r.match.moneyOutAtRisk)),
    },
    ...unlinked,
  };
}

/**
 * Supplier bills that reference NO purchase order.
 *
 * Narrowed to rows that carry a supplier, which is what makes a `finances` row a
 * supplier BILL rather than a receipt or an untraceable cost — `finances` is the
 * shared cost table (20260515) and only the supplier_id/purchase_order_id
 * columns added by 20261009 make a row a bill. Without that narrowing this would
 * report every cash receipt in the company as an unmatched bill, which is noise,
 * not a finding.
 *
 * WHAT LANDS HERE, AND WHY IT IS NOT A LIST OF ERRORS. Two paths produce a
 * supplier cost with no order behind it, and both are legitimate: a bill entered
 * against a supplier directly, and an invoice captured through the expense
 * pipeline (server/services/expense-drafts.ts writes a `finances` row with
 * supplier_id and no purchase_order_id). Neither is wrong — an ad-hoc buy from
 * the merchant is normal — but neither can be three-way matched, because nobody
 * agreed a price up front. So this is reported as a COUNT and a TOTAL with the
 * largest few named, never as a queue of things to fix, and the page says so.
 */
async function loadUnlinkedBills(
  db: PoMatchingClient,
  orgId: string,
): Promise<{ unlinkedBills: UnlinkedBill[]; unlinkedBillCount: number; unlinkedBillTotal: number }> {
  const { rows, error } = await pagedRows(
    db,
    "finances",
    "id, reference, bill_date, supplier_id, job_id, amount, vat_total",
    orgId,
    (q) => q.is("purchase_order_id", null).not("supplier_id", "is", null),
  );
  if (error) throw readFailure("po matching: unlinked supplier bills", asReadError(error));

  const all: UnlinkedBill[] = rows.map((b) => ({
    id: str(b.id),
    reference: strOrNull(b.reference),
    billDate: strOrNull(b.bill_date),
    supplierId: strOrNull(b.supplier_id),
    jobId: strOrNull(b.job_id),
    gross: round2(sumMoney([money(b.amount), money(b.vat_total)])),
  }));
  // Biggest first, then by id — a unique total order, so the sample is stable.
  all.sort((a, b) => b.gross - a.gross || a.id.localeCompare(b.id));

  return {
    unlinkedBills: all.slice(0, UNLINKED_BILL_SAMPLE),
    unlinkedBillCount: all.length,
    unlinkedBillTotal: sumMoney(all.map((b) => b.gross)),
  };
}

/**
 * The supplier-bill variance rollup for the Daily Briefing.
 *
 * BEST-EFFORT BY CONTRACT, and the ONLY function here that is (the same
 * arrangement as `loadLowStockSignal`): the briefing is an additive dashboard
 * section that must never break the page it sits on. A failed read degrades to
 * "no variance signal", which is the same outcome as a company whose billing
 * genuinely matches — it can MISS a line, never invent one — and
 * /purchase-orders/matching itself stays loud, so the number is never quietly
 * wrong where a human went looking for it.
 */
export interface SupplierBillVarianceRollup {
  /** Orders carrying at least one variance. */
  count: number;
  /**
   * Money the suppliers are asking for that the orders do not justify, gross £ —
   * Σ per-order (billed − min(committed, received)). The DOUBLE-COUNT-FREE
   * figure: an order invoiced £120 above a fully delivered order is £120 of
   * exposure, not £240, even though it is flagged as both over-billed and
   * billed-not-received. This is what the briefing headline states.
   */
  moneyOutAtRisk: number;
  /** Invoiced above what the orders commit, gross £ (per-kind, for display). */
  overBilled: number;
  /** Invoiced for goods with no delivery recorded, gross £ (per-kind). */
  billedNotReceived: number;
  /** Delivered with no bill against it — the accrual, gross £. Never money out. */
  receivedNotBilled: number;
}

export const EMPTY_SUPPLIER_BILL_VARIANCE: SupplierBillVarianceRollup = {
  count: 0,
  moneyOutAtRisk: 0,
  overBilled: 0,
  billedNotReceived: 0,
  receivedNotBilled: 0,
};

export async function loadSupplierBillVarianceSignal(
  db: PoMatchingClient,
  orgId: string,
): Promise<SupplierBillVarianceRollup> {
  try {
    const q = await loadPoMatchingQueue(db, orgId);
    return {
      count: q.discrepancies.length,
      moneyOutAtRisk: q.totals.moneyOutAtRisk,
      overBilled: q.totals.overBilled,
      billedNotReceived: q.totals.billedNotReceived,
      receivedNotBilled: q.totals.receivedNotBilled,
    };
  } catch {
    return EMPTY_SUPPLIER_BILL_VARIANCE;
  }
}
