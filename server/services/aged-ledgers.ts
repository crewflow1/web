import "server-only";
import { createClient } from "@/lib/supabase/server";
import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import { UNATTRIBUTED_CUSTOMER_LABEL } from "@/lib/commercial/aged-debtors";
import { UNATTRIBUTED_SUPPLIER_LABEL } from "@/lib/commercial/aged-creditors";
import { buildAgeingLedger, type AgeingItem, type AgeingLedger } from "@/lib/commercial/ageing";

/**
 * AGED DEBTORS + AGED CREDITORS — the read layer. READ-ONLY by construction.
 *
 * Both listings are now sourced from two org-guarded SECURITY DEFINER RPCs
 * (migration 20261238000000, Workstream R7):
 *
 *     public.report_aged_receivables(org_id, as_at)  — one row per UNSETTLED,
 *         collectable sales invoice, outstanding balance + age bucket already
 *         computed in SQL.
 *     public.report_aged_payables(org_id, as_at)     — one row per UNSETTLED
 *         supplier bill, outstanding + age bucket computed in SQL. ADMIN-ONLY.
 *
 * ── WHY RPCs REPLACED THE WHOLE-LEDGER FETCH ─────────────────────────────────
 * This module used to read EVERY invoice (draft / paid / void included) and the
 * ENTIRE invoice_payments table, fold payments per invoice, net, and then
 * discard the settled majority in TypeScript — and the same on the payables
 * side. The RPCs push the invoice⋈payments (and bill⋈allocations) join, the
 * per-document netting and the settled-exclusion into SQL, so only the unsettled
 * tail crosses the wire. Row volume no longer grows with the tenant's whole
 * trading history.
 *
 * ── THE SINGLE BUCKETER STILL OWNS GROUPING + TOTALS ─────────────────────────
 * `buildAgeingLedger` (lib/commercial/ageing) remains the ONE authority for
 * party grouping, the deterministic sort, and the bucket/pastDue/undated totals.
 * It is designed to receive an ALREADY-SETTLED `amount` and an `ageDays` from
 * the caller and bucket them — so handing it the RPC's pre-computed `remaining`
 * and `age_days` introduces no second copy of the grouping or totalling rule.
 * The per-document derivations the RPCs now perform in SQL (collectable filter,
 * `invoiceRemaining`, `invoiceDaysOverdue`; and billGross − live allocations,
 * `billDueDate`, `daysBetween` for payables) MIRROR the pure TypeScript
 * authorities exactly, and that equality — plus the /cash reconciliation
 * identities below — is pinned to real Postgres by
 * __tests__/integration/reports/aged-ledgers-rpc.test.ts (snapshot-equality
 * against the legacy whole-fetch path over status × settlement × age band).
 *
 * ── THE RECONCILIATION IDENTITIES (unchanged) ────────────────────────────────
 * For the same invoices, payments and as-at day:
 *
 *     debtors.totals.total   === computeOrgCashSummary(...).owedNow
 *     debtors.totals.pastDue === computeOrgCashSummary(...).overdue
 *
 * They still hold because the RPC's `remaining` IS `invoiceRemaining` and its
 * `age_days` IS `invoiceDaysOverdue`, over the same collectable population, and
 * `buildAgeingLedger` sums exactly those amounts. The payables mirror
 * (creditors.totals.total === the cash-out `unpaidBills`) holds for the same
 * reason. The as-at day is `invoiceBusinessToday` — the SAME day /cash and the
 * invoice list evaluate against — passed to the RPC so SQL and /cash agree about
 * which invoices are late.
 *
 * ── ACTIVE-ORG PINNING ───────────────────────────────────────────────────────
 * `current_org_ids()` admits every org the viewer belongs to, so an unpinned
 * read would merge a dual-trading party's two companies' debts into one wrong
 * row. The RPCs take the ACTIVE org id as an argument and filter strictly by it
 * (and FIRST raise 42501 for a non-member), so only the active org's data is
 * ever returned. There is no page-boundary (F-1) exposure: the RPC returns the
 * unsettled set in one result, not a client-paged scan.
 *
 * ── LOUD READS ───────────────────────────────────────────────────────────────
 * An RPC error (or a thrown client) sets `loadError` and yields an EMPTY ledger,
 * never a reassuring "nothing outstanding". The page shows an explicit banner.
 *
 * ── THE ADMIN GATE ON PAYABLES ───────────────────────────────────────────────
 * The money-out ledger is owner/admin-only. `report_aged_payables` is SECURITY
 * DEFINER (it bypasses RLS), so it enforces `is_org_admin` itself and refuses a
 * non-admin with 42501. This module ALSO refuses to call it for a non-admin role
 * (`canReadPayables`), returning `creditorsVisible: false` and an empty ledger —
 * the gate is kept in both places: the TS gate drives the UX, the RPC gate is
 * the real boundary for any direct caller.
 *
 * No `insert`/`update`/`delete`/`upsert` appears here and none may be added;
 * the only RPCs called are the two read-only ageing functions above. Pinned by
 * __tests__/security/aged-ledgers-org-scope.test.ts.
 */

type Row = Record<string, unknown>;

/**
 * The new ageing RPCs post-date the generated types in lib/supabase/types.ts, so
 * the client's `rpc` is reached through a precise structural shim — the same
 * seam other services use for post-types RPCs.
 */
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
};

const sv = (v: unknown) => (v == null ? null : String(v));
/** numeric (returned by supabase-js as a string to preserve precision) → pounds. */
const num = (v: unknown) => round2(toPounds(v as number | string | null));
/** integer / null day count. */
const ageOf = (v: unknown): number | null => (v == null ? null : Number(v));

export interface AgedLedgersView {
  debtors: AgeingLedger;
  creditors: AgeingLedger;
  /** False when the viewer may not read the money-out ledger — see the header. */
  creditorsVisible: boolean;
  /** The as-at business day every figure was computed against (YYYY-MM-DD). */
  asAtIso: string;
  loadError: boolean;
}

const EMPTY_LEDGER: AgeingLedger = {
  rows: [],
  totals: {
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 },
    total: 0,
    pastDue: 0,
    itemCount: 0,
    partyCount: 0,
    undated: 0,
  },
};

/** Owners and admins only — the money-out ledger's own RLS boundary. */
export function canReadPayables(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * An aged-receivables RPC row → an `AgeingItem`. Party naming mirrors
 * `composeDebtorItems` (lib/commercial/aged-debtors): a resolved customer with no
 * name reads "Unnamed customer"; a wholly-unresolved invoice is `UNATTRIBUTED`.
 */
function debtorItem(r: Row): AgeingItem {
  const partyId = sv(r.party_id);
  return {
    id: String(r.invoice_id),
    partyId: partyId ?? "",
    partyName: partyId
      ? (sv(r.party_name) || "Unnamed customer")
      : UNATTRIBUTED_CUSTOMER_LABEL,
    amount: num(r.remaining),
    ageDays: ageOf(r.age_days),
    reference: sv(r.reference),
    dateIso: sv(r.due_date),
    href: `/invoices/${String(r.invoice_id)}`,
  };
}

/**
 * An aged-payables RPC row → an `AgeingItem`. Party naming + href mirror
 * `composeCreditorItems` (lib/commercial/aged-creditors): a supplier with no name
 * reads "Unnamed supplier"; a supplier-less bill is `UNATTRIBUTED` and links to
 * /expenses rather than a supplier account.
 */
function creditorItem(r: Row): AgeingItem {
  const partyId = sv(r.party_id);
  return {
    id: String(r.bill_id),
    partyId: partyId ?? "",
    partyName: partyId
      ? (sv(r.party_name) || "Unnamed supplier")
      : UNATTRIBUTED_SUPPLIER_LABEL,
    amount: num(r.outstanding),
    ageDays: ageOf(r.age_days),
    reference: sv(r.reference),
    dateIso: sv(r.date_iso),
    href: partyId ? `/suppliers/${partyId}` : "/expenses",
  };
}

/**
 * Build both aged ledgers for the ACTIVE org.
 *
 * `role` gates payables (see the header). `now` is injectable so the page and the
 * tests pin one as-at instant.
 */
export async function buildAgedLedgers(
  orgId: string,
  role: string,
  now: Date = new Date(),
): Promise<AgedLedgersView> {
  const asAtIso = invoiceBusinessToday(now);
  const creditorsVisible = canReadPayables(role);

  try {
    const supabase = await createClient();
    const db = supabase as unknown as RpcClient;

    // ── receivables ──────────────────────────────────────────────────────────
    const ar = await db.rpc("report_aged_receivables", { p_org_id: orgId, p_as_at: asAtIso });
    let loadError = ar.error != null;
    const debtors = buildAgeingLedger((ar.data ?? []).map(debtorItem));

    // ── payables (admin-gated) ─────────────────────────────────────────────────
    let creditors = EMPTY_LEDGER;
    if (creditorsVisible) {
      const ap = await db.rpc("report_aged_payables", { p_org_id: orgId, p_as_at: asAtIso });
      if (ap.error != null) loadError = true;
      creditors = buildAgeingLedger((ap.data ?? []).map(creditorItem));
    }

    return { debtors, creditors, creditorsVisible, asAtIso, loadError };
  } catch (err) {
    console.warn("[aged-ledgers] buildAgedLedgers failed", err);
    return {
      debtors: EMPTY_LEDGER,
      creditors: EMPTY_LEDGER,
      creditorsVisible,
      asAtIso,
      loadError: true,
    };
  }
}
