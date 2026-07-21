"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { recordPaymentSchema } from "@/lib/payments/schema";
import { computePaymentAllocation } from "@/lib/payments/allocation";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";

/**
 * Record one real-world payment and allocate it across one or more invoices.
 *
 * A single `payments` row (the receipt) plus an `invoice_payments` row per
 * invoice (each an allocation). The write goes through the `allocate_payment`
 * RPC so the payment + all its allocations land in ONE transaction — if any
 * allocation trips the DB over-allocation guard, the whole thing rolls back.
 *
 * The DB is the authority (FOR UPDATE-locked guard trigger + composite org FKs
 * + RLS). The zod parse and the sum check below are only a friendlier first
 * line of defence; they never replace the database invariant.
 *
 * `payments` / the new `invoice_payments.payment_id` are not yet in the
 * generated Supabase types, so the RPC call is cast — the established idiom.
 */
export async function recordAllocatedPayment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();

  let allocations: unknown = [];
  try {
    allocations = JSON.parse(String(formData.get("allocations") ?? "[]"));
  } catch {
    allocations = [];
  }

  const parsed = recordPaymentSchema.safeParse({
    amount: formData.get("amount") ?? "",
    paid_at: formData.get("paid_at") ?? "",
    method: formData.get("method") ?? "bank_transfer",
    reference: formData.get("reference") ?? "",
    notes: formData.get("notes") ?? "",
    allocations,
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the payment and try again.");
  }
  const input = parsed.data;

  // Friendly pre-check — the DB guard is authoritative, but catching an
  // over-allocation here gives a precise message instead of a raw SQL error.
  const position = computePaymentAllocation({
    paymentAmount: input.amount,
    allocations: input.allocations,
  });
  if (position.status === "over_allocated") {
    return formError(
      `Allocations total ${position.allocated.toFixed(2)}, more than the ` +
        `payment of ${position.paymentAmount.toFixed(2)}. Reduce an allocation.`,
    );
  }

  const supabase = await createClient();
  const { data: paymentId, error } = await (
    supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: string | null; error: { message: string; code?: string; details?: string; hint?: string } | null }>
  )("allocate_payment", {
    p_org_id: ctx.org.id,
    p_amount: input.amount,
    p_paid_at: input.paid_at,
    p_method: input.method,
    p_reference: input.reference ?? null,
    p_source: "manual",
    p_notes: input.notes ?? null,
    p_allocations: input.allocations.map((a) => ({
      invoice_id: a.invoice_id,
      amount: a.amount,
    })),
  });

  if (error || !paymentId) {
    // Full Postgres error shape to logs; safe generic message to the user, and
    // never a false success on a failed write.
    console.error("[payment-allocation] allocate_payment failed", {
      orgId: ctx.org.id,
      userId: user.id,
      amount: input.amount,
      allocations: input.allocations.length,
      code: error?.code,
      message: error?.message,
      details: error?.details,
      hint: error?.hint,
    });
    // Surface the guard's over-allocation message specifically — it's a real,
    // actionable accounting error, not a generic failure.
    if (error?.message?.includes("over-allocated")) {
      return formError("That payment is already fully allocated. Refresh and try again.");
    }
    return formError("Couldn't record the payment. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "payment.recorded",
    targetTable: "payments",
    targetId: paymentId,
    metadata: {
      amount: input.amount,
      method: input.method,
      allocations: input.allocations.length,
      allocated: position.allocated,
    },
  });

  revalidatePath("/payments");
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  for (const a of input.allocations) revalidatePath(`/invoices/${a.invoice_id}`);

  return formSuccess({ redirectTo: "/payments?saved=payment" });
}
