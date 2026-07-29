import "server-only";

import {
  computeBillBasis,
  type BillBasis,
  type BillCisDetails,
  type PriorSettlement,
  type VatTreatment,
} from "@/lib/cis/deduction";
import type { CisBillDetailsInput, CisPaymentInput } from "@/lib/cis/schema";
import { round2, toPounds } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

import type { CisAllocationRow } from "./supplier-payments";

/**
 * H2-CIS M3 — the CIS deduction service.
 *
 * Every call runs on the TENANT (user-JWT) client, so the admin-only RLS on
 * `cis_bill_details`, `cis_payment_snapshots` and the M2 ledger is the real
 * boundary. The service-role client is deliberately never used: this is tax
 * authority and there is no legitimate reason to bypass RLS for it — the posture
 * `server/services/cis.ts` and `server/services/supplier-payments.ts` both take.
 *
 * NOTHING HERE WRITES `finances`. Job cost and margin cannot move because a CIS
 * deduction was recorded. That is structural, not careful: the deduction basis
 * lives in its own table.
 *
 * These tables post-date the generated types in lib/supabase/types.ts, so `.from`
 * / `.rpc` are reached through precise structural casts — the same seam
 * `server/services/cis.ts` and `server/services/supplier-payments.ts` use.
 *
 * READS THROW ON FAILURE. These maps are consumed together by
 * /suppliers/[id]/payments, where an empty-on-error result is not a blank
 * screen but a WRONG one: an empty details map renders materials = 0 and
 * CITB = 0 into the bill-details form, and a re-save then CLOBBERS the real
 * figures with those zeroes — changing the CIS basis actually filed. Tax
 * authority must fail closed.
 */

export type CisDeductionResult<T> = { ok: true; data: T } | { ok: false; error: string };

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

type Filter<T> = PromiseLike<Res<T[]>> & {
  eq: (k: string, v: unknown) => Filter<T>;
  in: (k: string, v: readonly unknown[]) => Filter<T>;
  order: (k: string, o?: { ascending?: boolean }) => Filter<T>;
  limit: (n: number) => Filter<T>;
};
type LooseTable = {
  select: <T>(cols: string) => Filter<T>;
  upsert: (
    row: Record<string, unknown>,
    opts?: { onConflict?: string },
  ) => PromiseLike<Res<null>>;
};
type LooseClient = {
  from: (t: string) => unknown;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<Res<string>>;
};

async function client(): Promise<LooseClient> {
  return (await createClient()) as unknown as LooseClient;
}

function table(c: LooseClient, name: string): LooseTable {
  return c.from(name) as LooseTable;
}

/** Never surface a raw Postgres message — it can echo row contents. */
function friendly(dbMessage: string | undefined, fallback: string): string {
  if (dbMessage) console.error("[cis-deduction]", dbMessage);
  return fallback;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type CisBillDetailsRow = {
  finance_id: string;
  materials_amount: number | string | null;
  citb_levy_amount: number | string | null;
  vat_treatment: VatTreatment;
  reverse_charge_vat_rate: number | string | null;
  notes: string | null;
};

const DETAILS_COLUMNS =
  "finance_id, materials_amount, citb_levy_amount, vat_treatment, " +
  "reverse_charge_vat_rate, notes";

/** CIS details for a supplier's bills, keyed by finance_id. */
export async function getBillCisDetails(
  orgId: string,
  supplierId: string,
): Promise<Map<string, CisBillDetailsRow>> {
  const c = await client();
  const res = await table(c, "cis_bill_details")
    .select<CisBillDetailsRow>(DETAILS_COLUMNS)
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .limit(500);
  // Empty-on-error here writes zeroed materials/CITB back over real figures the
  // next time the bill-details form is saved. Fail closed.
  if (res.error) throw readFailure("cis: bill details", res.error);
  return new Map((res.data ?? []).map((r) => [r.finance_id, r]));
}

/**
 * The CIS figures frozen on an allocation.
 *
 * `supplier_payment_allocations` is M2's table, and M2's own security pin
 * (__tests__/security/supplier-payments.test.ts) requires that ONLY
 * `server/services/supplier-payments.ts` and its actions name it — so that every
 * access goes through one tenant-client discipline and one error translator. The
 * READ therefore lives there (`getCisAllocations`) and is re-exported here for
 * callers that think in CIS terms. This module never names that table.
 */
export { getCisAllocations } from "./supplier-payments";
export type { CisAllocationRow } from "./supplier-payments";

export type CisPaymentSnapshotRow = {
  payment_id: string;
  cis_status: string;
  deduction_rate: number | string | null;
  verification_reference: string | null;
  verified_at: string | null;
  legal_name: string;
  utr_masked: string | null;
  cis_gross_payment: number | string | null;
  materials_total: number | string | null;
  citb_total: number | string | null;
  cis_basis: number | string | null;
  cis_deduction: number | string | null;
  tax_month_start: string;
  tax_month_end: string;
};

const SNAPSHOT_COLUMNS =
  "payment_id, cis_status, deduction_rate, verification_reference, verified_at, " +
  "legal_name, utr_masked, cis_gross_payment, materials_total, citb_total, " +
  "cis_basis, cis_deduction, tax_month_start, tax_month_end";

/** The frozen tax facts of a supplier's CIS payments, keyed by payment_id. */
export async function getCisPaymentSnapshots(
  orgId: string,
  supplierId: string,
): Promise<Map<string, CisPaymentSnapshotRow>> {
  const c = await client();
  const res = await table(c, "cis_payment_snapshots")
    .select<CisPaymentSnapshotRow>(SNAPSHOT_COLUMNS)
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .limit(500);
  // These are the FROZEN tax facts of payments already made. An empty map on
  // error would present recorded CIS payments as having no deduction history.
  if (res.error) throw readFailure("cis: payment snapshots", res.error);
  return new Map((res.data ?? []).map((r) => [r.payment_id, r]));
}

/**
 * Prior LIVE settlement per bill — the input the cumulative partial-payment
 * method needs (docs/cis-domain.md §9).
 *
 * `allocations` must already be filtered to non-voided payments. Legacy M2
 * allocations with no CIS figures contribute their AMOUNT (they really did settle
 * that much of the bill) but zero basis and zero deduction, which is the honest
 * reading: nothing was deducted for them, so the next CIS payment picks up the
 * whole remaining deduction rather than double-counting one that never happened.
 */
export function priorSettlementByBill(
  allocations: CisAllocationRow[],
): Map<string, PriorSettlement> {
  const out = new Map<string, PriorSettlement>();
  for (const a of allocations) {
    const prev = out.get(a.finance_id) ?? {
      allocated: 0, basis: 0, deduction: 0, reverseChargeVat: 0,
    };
    out.set(a.finance_id, {
      allocated: round2(prev.allocated + toPounds(a.amount)),
      basis: round2(prev.basis + toPounds(a.cis_basis)),
      deduction: round2(prev.deduction + toPounds(a.cis_deduction)),
      reverseChargeVat: round2(prev.reverseChargeVat + toPounds(a.cis_reverse_charge_vat)),
    });
  }
  return out;
}

/** Whole-bill basis for each bill, using its CIS details when it has any. */
export function billBasisMap(
  bills: Array<{ id: string; amount: number | string | null; vat_total: number | string | null }>,
  details: Map<string, CisBillDetailsRow>,
): Map<string, BillBasis> {
  const out = new Map<string, BillBasis>();
  for (const bill of bills) {
    const d = details.get(bill.id);
    const asDetails: BillCisDetails | null = d
      ? {
          materials_amount: d.materials_amount,
          citb_levy_amount: d.citb_levy_amount,
          vat_treatment: d.vat_treatment,
          reverse_charge_vat_rate: d.reverse_charge_vat_rate,
        }
      : null;
    out.set(bill.id, computeBillBasis(bill, asDetails));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Save the deduction basis and VAT treatment of one bill.
 *
 * Upsert rather than insert-or-update: the split is edited repeatedly while the
 * bill is unpaid. The database FREEZES it the moment a live CIS payment lands
 * against the bill — changing the materials figure halfway through a part payment
 * would make the second payment's share inconsistent with the first, and the
 * total would stop being the whole-bill deduction. Correct one by voiding.
 */
export async function saveBillCisDetails(
  orgId: string,
  supplierId: string,
  financeId: string,
  input: CisBillDetailsInput,
  actorId: string,
): Promise<CisDeductionResult<true>> {
  const c = await client();
  const { error } = await table(c, "cis_bill_details").upsert(
    {
      org_id: orgId,
      finance_id: financeId,
      supplier_id: supplierId,
      materials_amount: input.materials_amount,
      citb_levy_amount: input.citb_levy_amount,
      vat_treatment: input.vat_treatment,
      reverse_charge_vat_rate:
        input.vat_treatment === "reverse_charge" ? (input.reverse_charge_vat_rate ?? null) : null,
      notes: input.notes ?? null,
      updated_by: actorId,
    },
    { onConflict: "org_id,finance_id" },
  );

  if (error) {
    const message = error.message ?? "";
    if (/already been part-paid/i.test(message)) {
      return {
        ok: false,
        error:
          "This bill has already been part-paid under CIS, so its labour/materials split is locked. " +
          "Void the payment to change it.",
      };
    }
    if (/exceed the bill/i.test(message)) {
      return {
        ok: false,
        error: "Materials plus the CITB levy add up to more than the bill's net value.",
      };
    }
    if (/reverse charge the supplier charges no VAT/i.test(message)) {
      return {
        ok: false,
        error:
          "Under the reverse charge the subcontractor charges no VAT. Set this bill's VAT rate to 0, " +
          "then record the rate you account for here.",
      };
    }
    if (/only an owner or admin|insufficient_privilege|row-level security/i.test(message)) {
      return { ok: false, error: "Only an owner or admin can set a bill's CIS details." };
    }
    return { ok: false, error: friendly(message, "Couldn't save the CIS details. Try again.") };
  }
  return { ok: true, data: true };
}

/**
 * Record a CIS payment via `record_cis_supplier_payment`.
 *
 * ONE transaction: the payment, every allocation with its frozen tax snapshot,
 * and the payment-level verification snapshot. If any line trips a cap, a binding
 * or the deduction engine, the whole thing rolls back. A half-recorded CIS
 * payment would show cash out with a deduction nobody can explain.
 *
 * THE RATE IS NOT SENT. It is derived inside the RPC from the M1 verification
 * state and then INDEPENDENTLY re-derived and checked by a SECURITY DEFINER
 * trigger, so bypassing this function buys an attacker nothing. `expected_rate`
 * is an assertion the caller may make; a mismatch is refused rather than posted.
 */
export async function recordCisPayment(
  orgId: string,
  supplierId: string,
  input: CisPaymentInput,
): Promise<CisDeductionResult<string>> {
  const c = await client();
  const { data, error } = await c.rpc("record_cis_supplier_payment", {
    p_org_id: orgId,
    p_supplier_id: supplierId,
    p_paid_at: input.paid_at,
    p_method: input.method,
    p_reference: input.reference ?? null,
    p_notes: input.notes ?? null,
    p_allocations: input.allocations.map((a) => ({
      finance_id: a.finance_id,
      amount: a.amount,
    })),
    p_expected_rate: input.expected_rate ?? null,
  });

  if (error || !data) {
    const message = error?.message ?? "";
    if (/does not match this subcontractor's verified rate/i.test(message)) {
      return {
        ok: false,
        error:
          "This subcontractor's CIS rate has changed since you opened this page. " +
          "Refresh and check the new rate before recording the payment.",
      };
    }
    if (/not verified for CIS/i.test(message)) {
      return {
        ok: false,
        error:
          "There's no current HMRC verification for this subcontractor, so there's no authority to " +
          "deduct. Verify them first.",
      };
    }
    if (/is not set up as a CIS subcontractor/i.test(message)) {
      return {
        ok: false,
        error:
          "This supplier isn't a CIS subcontractor. Record an ordinary supplier payment instead.",
      };
    }
    if (/has changed since it was part-paid/i.test(message)) {
      return {
        ok: false,
        error:
          "One of these bills has been edited since it was part-paid under CIS. " +
          "Void the earlier payment before recording another against it.",
      };
    }
    if (/over-allocated/i.test(message)) {
      return {
        ok: false,
        error: "The bill lines add up to more than the payment. Reduce a line and try again.",
      };
    }
    if (/over-paid/i.test(message)) {
      return {
        ok: false,
        error:
          "One of those bills has already been settled — someone may have paid it first. " +
          "Refresh and try again.",
      };
    }
    if (/no positive value/i.test(message)) {
      return { ok: false, error: "That bill has nothing left to pay." };
    }
    if (/appears twice/i.test(message)) {
      return { ok: false, error: "The same bill is listed twice — combine it into one line." };
    }
    if (/must settle at least one bill/i.test(message)) {
      return {
        ok: false,
        error: "Choose at least one bill — a CIS deduction needs a bill to work from.",
      };
    }
    if (/only an owner or admin|insufficient_privilege|row-level security/i.test(message)) {
      return { ok: false, error: "Only an owner or admin can record a supplier payment." };
    }
    if (/foreign key|violates/i.test(message)) {
      return {
        ok: false,
        error: "One of those bills doesn't belong to this supplier. Refresh and try again.",
      };
    }
    return { ok: false, error: friendly(message, "Couldn't record the payment. Try again.") };
  }

  return { ok: true, data };
}
