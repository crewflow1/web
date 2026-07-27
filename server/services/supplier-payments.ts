import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  computeBillSettlements,
  computeSupplierPosition,
  type BillSettlement,
  type SupplierAllocationRow,
  type SupplierBillRow,
  type SupplierPaymentRow,
  type SupplierPosition,
} from "@/lib/suppliers/payments";
import type { SupplierPaymentInput } from "@/lib/suppliers/schema";

/**
 * H2-CIS M2 — supplier payment (money-OUT) service.
 *
 * Every call runs on the TENANT (user-JWT) client, so the admin-only RLS on
 * `supplier_payments` / `supplier_payment_allocations` is the real boundary: a
 * non-admin member reads nothing and writes nothing even reaching this module
 * directly. The service-role client is deliberately never used here — this is
 * cash and tax authority and there is no legitimate reason to bypass RLS for it
 * (the same posture `server/services/cis.ts` takes for UTRs).
 *
 * The actions layer ALSO checks the role, purely so a non-admin gets a sensible
 * message instead of a silent empty result. That check is a courtesy; RLS plus
 * the `record_supplier_payment` RPC's own `is_org_admin` gate are the controls.
 *
 * These tables post-date the generated types in lib/supabase/types.ts, so
 * `.from` / `.rpc` are reached through precise structural casts — the same seam
 * `server/services/cis.ts` and `app/(app)/payments/allocate-actions.ts` use.
 */

export type SupplierPaymentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const PAYMENT_COLUMNS =
  "id, paid_at, method, reference, gross_amount, cis_withheld, net_paid, " +
  "notes, voided_at, void_reason, created_at";

const BILL_COLUMNS =
  "id, amount, vat_total, reference, bill_date, category, job_id, created_at";

// ---------------------------------------------------------------------------
// Loose client shims (see the header note on generated types)
// ---------------------------------------------------------------------------

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

type Filter<T> = PromiseLike<Res<T[]>> & {
  eq: (k: string, v: unknown) => Filter<T>;
  in: (k: string, v: readonly unknown[]) => Filter<T>;
  order: (k: string, o?: { ascending?: boolean }) => Filter<T>;
  limit: (n: number) => Filter<T>;
};
type LooseTable = {
  select: <T>(cols: string) => Filter<T>;
  update: (row: Record<string, unknown>) => {
    eq: (k: string, v: unknown) => { eq: (k: string, v: unknown) => PromiseLike<Res<null>> };
  };
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
  if (dbMessage) console.error("[supplier-payments]", dbMessage);
  return fallback;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SupplierLedger = {
  bills: SupplierBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
  settlements: BillSettlement[];
  position: SupplierPosition;
};

/**
 * Everything the supplier money-out surface needs, in three queries.
 *
 * Bills come from `finances` (member-readable); payments and allocations from
 * the admin-only ledger. A non-admin therefore gets bills but an EMPTY payment
 * ledger rather than an error — callers that must distinguish "no payments" from
 * "not allowed" have to check the role themselves, exactly as `getCisProfile`
 * documents.
 *
 * Allocations are fetched by payment id rather than by supplier so the result
 * can never include a row belonging to a payment we did not read.
 */
export async function getSupplierLedger(
  orgId: string,
  supplierId: string,
): Promise<SupplierLedger> {
  const c = await client();

  const [billsRes, paymentsRes] = await Promise.all([
    table(c, "finances")
      .select<SupplierBillRow>(BILL_COLUMNS)
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false })
      .limit(200),
    table(c, "supplier_payments")
      .select<SupplierPaymentRow>(PAYMENT_COLUMNS)
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .order("paid_at", { ascending: false })
      .limit(200),
  ]);

  const bills = billsRes.data ?? [];
  const payments = paymentsRes.data ?? [];

  let allocations: SupplierAllocationRow[] = [];
  if (payments.length > 0) {
    const allocRes = await table(c, "supplier_payment_allocations")
      .select<SupplierAllocationRow>("payment_id, finance_id, amount")
      .eq("org_id", orgId)
      .in(
        "payment_id",
        payments.map((p) => p.id),
      );
    allocations = allocRes.data ?? [];
  }

  return {
    bills,
    payments,
    allocations,
    settlements: computeBillSettlements({ bills, payments, allocations }),
    position: computeSupplierPosition({ bills, payments, allocations }),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a payment and its allocations ATOMICALLY via `record_supplier_payment`.
 *
 * One transaction: if any allocation trips an over-allocation cap or a binding
 * FK, the payment rolls back with it. A half-recorded payment would be worse
 * than none — it would show cash out with nothing settled.
 *
 * The RPC is SECURITY INVOKER, so RLS, both composite FKs and the FOR
 * UPDATE-locked guard apply to the caller. `net_paid` is computed inside the
 * RPC from the gross and the withholding, so the client cannot key a triple
 * that doesn't add up.
 */
export async function recordSupplierPayment(
  orgId: string,
  supplierId: string,
  input: SupplierPaymentInput,
): Promise<SupplierPaymentResult<string>> {
  const c = await client();
  const { data, error } = await c.rpc("record_supplier_payment", {
    p_org_id: orgId,
    p_supplier_id: supplierId,
    p_paid_at: input.paid_at,
    p_method: input.method,
    p_reference: input.reference ?? null,
    p_gross_amount: input.gross_amount,
    p_cis_withheld: input.cis_withheld,
    p_notes: input.notes ?? null,
    p_allocations: input.allocations.map((a) => ({
      finance_id: a.finance_id,
      amount: a.amount,
    })),
  });

  if (error || !data) {
    // Translate the DB's real accounting errors into actionable sentences.
    // Anything unrecognised stays generic — a raw Postgres message can echo row
    // contents and is useless to an operator either way.
    const message = error?.message ?? "";
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
    if (/CIS cannot be withheld/i.test(message)) {
      return {
        ok: false,
        error:
          "You can only withhold CIS from a registered subcontractor. Set up their CIS " +
          "details first, or record the payment with 0 withheld.",
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

/**
 * Void a payment — the ONLY correction mechanism. Nothing is deleted and no
 * historical figure is rewritten: the row stays with who voided it, when and
 * why, and stops counting towards cash, withholding and bill settlement so the
 * corrected payment has room to be recorded.
 *
 * `voided_by` is filled by the DB trigger from auth.uid() when the caller omits
 * it, so a void is attributed even on a direct PostgREST path.
 */
export async function voidSupplierPayment(
  orgId: string,
  paymentId: string,
  reason: string,
  actorId: string,
): Promise<SupplierPaymentResult<true>> {
  const c = await client();
  const { error } = await table(c, "supplier_payments")
    .update({
      voided_at: new Date().toISOString(),
      voided_by: actorId,
      void_reason: reason,
    })
    .eq("org_id", orgId)
    .eq("id", paymentId);

  if (error) {
    if (/is voided/i.test(error.message)) {
      return { ok: false, error: "That payment has already been voided." };
    }
    return { ok: false, error: friendly(error.message, "Couldn't void the payment.") };
  }
  return { ok: true, data: true };
}
