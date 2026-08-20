"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { computeTotals } from "@/lib/quotes/totals";
import {
  canTransitionPo,
  poStatusLabel,
  purchaseOrderFormSchema,
  PO_STATUSES,
  type PurchaseOrderFormInput,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/schema";
import { purchaseOrderHasReceipts } from "./_receiving-data";
import { submitPurchaseOrderToMerchantForOrg } from "@/server/services/merchant-writers";
import { isMerchantProvider } from "@/lib/integrations/merchants/connect";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";
import { z } from "zod";

/**
 * Purchase-order server actions (Programme C).
 *
 * RLS: members select/insert/update within their org; admins delete. A PO is
 * committed spend — it never posts to `finances` (that happens when a supplier
 * bill is recorded, a later slice), so there is no double-counting.
 *
 * purchase_orders / purchase_order_line_items are not yet in the generated
 * Supabase types — the writers are cast (`as never`), the established idiom.
 */

const idSchema = z.string().uuid();

function parsePoForm(formData: FormData) {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get("line_items") ?? "[]"));
  } catch {
    lines = [];
  }
  return purchaseOrderFormSchema.safeParse({
    supplier_id: formData.get("supplier_id") ?? "",
    job_id: formData.get("job_id") ?? "",
    supplier_reference: formData.get("supplier_reference") ?? "",
    expected_date: formData.get("expected_date") ?? "",
    notes: formData.get("notes") ?? "",
    line_items: lines,
  });
}

type PoLineInsert = {
  org_id: string;
  purchase_order_id: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number;
  vat_rate: number;
  line_total: number;
  sort_order: number;
};

async function insertLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  poId: string,
  data: PurchaseOrderFormInput,
): Promise<{ error: { message: string } | null }> {
  const totals = computeTotals(data.line_items);
  const rows: PoLineInsert[] = data.line_items.map((li, idx) => ({
    org_id: orgId,
    purchase_order_id: poId,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  return (
    supabase.from("purchase_order_line_items" as never) as unknown as {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert(rows);
}

export async function createPurchaseOrder(
  _prev: FormState<PurchaseOrderFormInput>,
  formData: FormData,
): Promise<FormState<PurchaseOrderFormInput>> {
  const { ctx, user } = await requireOrgContext();
  const parsed = parsePoForm(formData);
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the purchase order and try again.");
  }

  const supabase = await createClient();
  const totals = computeTotals(parsed.data.line_items);

  const { data: number } = await supabase.rpc("next_po_number" as never, {
    target_org: ctx.org.id,
  } as never);
  if (!number) return formError("Couldn't allocate a PO number. Try again.");

  const { data: po, error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      insert: (v: unknown) => {
        select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> };
      };
    }
  )
    .insert({
      org_id: ctx.org.id,
      supplier_id: parsed.data.supplier_id ?? null,
      job_id: parsed.data.job_id ?? null,
      number: number as unknown as string,
      status: "draft",
      supplier_reference: parsed.data.supplier_reference ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      notes: parsed.data.notes ?? null,
      expected_date: parsed.data.expected_date ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !po) {
    console.error("[purchase-orders] create failed", error);
    return formError("Couldn't save the purchase order. Try again.");
  }

  const { error: liErr } = await insertLines(supabase, ctx.org.id, po.id, parsed.data);
  if (liErr) {
    console.error("[purchase-orders] line items insert failed", liErr);
    return formError("Couldn't save the line items. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.created",
    targetTable: "purchase_orders",
    targetId: po.id,
    metadata: { number, total: totals.total, job_id: parsed.data.job_id ?? null },
  });

  revalidatePath("/purchase-orders");
  return formSuccess({ redirectTo: `/purchase-orders/${po.id}?saved=1` });
}

export async function updatePurchaseOrder(
  id: string,
  _prev: FormState<PurchaseOrderFormInput>,
  formData: FormData,
): Promise<FormState<PurchaseOrderFormInput>> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid purchase order id.");

  const parsed = parsePoForm(formData);
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the purchase order and try again.");
  }

  const supabase = await createClient();

  // Only draft/sent POs are editable — a received/cancelled PO is settled.
  type EditQuery = {
    eq: (k: string, v: unknown) => EditQuery;
    maybeSingle: () => Promise<{ data: { status: string } | null; error: SupabaseReadError | null }>;
  };
  const { data: existing } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => EditQuery;
    }
  )
    .select("status")
    .eq("id", id)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .maybeSingle();
  if (!existing) return formError("Couldn't load the purchase order.");
  if (existing.status === "received" || existing.status === "cancelled") {
    return formError(`A ${poStatusLabel(existing.status).toLowerCase()} purchase order can't be edited.`);
  }

  // Warehouse M1: the edit path DELETES and re-inserts the line items, and
  // goods_received_lines reference them (composite FK, deferred NO ACTION). The
  // database refuses that once any delivery exists, so refuse it here with an
  // explanation instead of letting the user hit a raw constraint error after
  // filling in the whole builder.
  if (await purchaseOrderHasReceipts(supabase, ctx.org.id, id)) {
    return formError(
      "This order has deliveries recorded against it — its lines are locked. Void the deliveries first, or cancel it and raise a new order.",
    );
  }

  type MutateQuery<T> = {
    eq: (k: string, v: unknown) => MutateQuery<T> & PromiseLike<{ error: T }>;
  };
  const totals = computeTotals(parsed.data.line_items);
  const { error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      update: (v: unknown) => MutateQuery<{ message: string } | null>;
    }
  )
    .update({
      supplier_id: parsed.data.supplier_id ?? null,
      job_id: parsed.data.job_id ?? null,
      supplier_reference: parsed.data.supplier_reference ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      notes: parsed.data.notes ?? null,
      expected_date: parsed.data.expected_date ?? null,
    })
    .eq("id", id)
    .eq("org_id", ctx.org.id); // ACTIVE-ORG PIN
  if (error) {
    console.error("[purchase-orders] update failed", error);
    return formError("Couldn't save changes. Try again.");
  }

  // Replace line items (delete + insert, as quotes do).
  await (
    supabase.from("purchase_order_line_items" as never) as unknown as {
      delete: () => MutateQuery<unknown>;
    }
  )
    .delete()
    .eq("purchase_order_id", id)
    .eq("org_id", ctx.org.id); // ACTIVE-ORG PIN
  const { error: liErr } = await insertLines(supabase, ctx.org.id, id, parsed.data);
  if (liErr) return formError("Couldn't save the line items. Try again.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.updated",
    targetTable: "purchase_orders",
    targetId: id,
    metadata: { total: totals.total },
  });

  revalidatePath(`/purchase-orders/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

export async function setPurchaseOrderStatus(id: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/purchase-orders");

  const to = String(formData.get("status") ?? "") as PurchaseOrderStatus;
  if (!(PO_STATUSES as readonly string[]).includes(to)) {
    redirect(`/purchase-orders/${id}?error=bad_status`);
  }

  const supabase = await createClient();
  type StatusQuery = {
    eq: (k: string, v: unknown) => StatusQuery;
    maybeSingle: () => Promise<{ data: { status: string } | null; error: SupabaseReadError | null }>;
  };
  const { data: existing, error: existingError } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => StatusQuery;    }
  )
    .select("status")
    .eq("id", id)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .maybeSingle();
  if (existingError) throw readFailure("purchase order status: purchase order", existingError);
  if (!existing) redirect("/purchase-orders?error=not_found");

  if (!canTransitionPo(existing.status as PurchaseOrderStatus, to)) {
    redirect(`/purchase-orders/${id}?error=bad_transition`);
  }

  // Warehouse M1: once a delivery has been posted, the receipt status belongs
  // to the receiving engine and the database refuses a hand-set 'received' that
  // contradicts it (tg_purchase_order_transition). Only 'cancelled' is still a
  // manual move — check it here so the user gets a sentence, not a 500.
  if (to !== "cancelled" && (await purchaseOrderHasReceipts(supabase, ctx.org.id, id))) {
    redirect(`/purchase-orders/${id}?error=derived_status`);
  }

  type UpdateQuery = {
    eq: (k: string, v: unknown) => UpdateQuery & PromiseLike<{ error: { message: string } | null }>;
  };
  const { error } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      update: (v: unknown) => UpdateQuery;
    }
  )
    .update({ status: to })
    .eq("id", id)
    .eq("org_id", ctx.org.id); // ACTIVE-ORG PIN
  if (error) {
    console.error("[purchase-orders] status change failed", error);
    redirect(`/purchase-orders/${id}?error=status_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `purchase_order.${to}`,
    targetTable: "purchase_orders",
    targetId: id,
    metadata: { from: existing.status, to },
  });

  revalidatePath(`/purchase-orders/${id}`);
  redirect(`/purchase-orders/${id}?saved=status`);
}

/**
 * Submit a purchase order to a builders' merchant electronically — the PO-core
 * caller of the merchant submit seam. Maps this order onto the provider-agnostic
 * payload (via the service-role writer), sends it through the built cXML adapter,
 * and records the outcome in merchant_po_submissions.
 *
 * DARK-SAFE. The writer refuses BEFORE any client construction / network call when
 * the merchant is not connectable (`skipped_dark`) or the org has no `connected`
 * row (`not_connected`) — nothing is submitted and no ledger row is written while
 * the integration is not activated. Org-pinned via ctx.org.id (a foreign PO is
 * not-found); the merchant provider comes from the form and is validated. The PO
 * core is untouched — this never mutates a purchase_orders row.
 */
export async function submitPurchaseOrderToMerchantAction(id: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/purchase-orders");

  const providerRaw = String(formData.get("provider") ?? "");
  if (!isMerchantProvider(providerRaw)) {
    redirect(`/purchase-orders/${id}?error=merchant_unknown`);
  }

  const outcome = await submitPurchaseOrderToMerchantForOrg({
    orgId: ctx.org.id,
    provider: providerRaw,
    purchaseOrderId: id,
    submittedBy: user.id,
  });

  if (outcome.status === "acknowledged" || outcome.status === "already_submitted") {
    await recordAdminActivity({
      actorId: user.id,
      actorEmail: user.email ?? null,
      action: "purchase_order.merchant_submitted",
      targetTable: "purchase_orders",
      targetId: id,
      metadata: { provider: providerRaw, external_order_ref: outcome.externalOrderRef },
    });
    redirect(`/purchase-orders/${id}?saved=merchant`);
  }

  // Dark / not-connected / rejected / error — surface a coarse, non-secret code.
  redirect(`/purchase-orders/${id}?error=merchant_${outcome.status}`);
}

export async function deletePurchaseOrder(id: string) {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/purchase-orders");

  const supabase = await createClient();

  // A delivery is evidence that this order existed and that goods arrived
  // against it — deleting the order would orphan it. The database refuses
  // (deferred NO ACTION on goods_received_notes.purchase_order_id, which
  // surfaces at commit); catch it first so the user gets a sentence instead of
  // a constraint name.
  if (await purchaseOrderHasReceipts(supabase, ctx.org.id, id)) {
    redirect(`/purchase-orders/${id}?error=delete_has_receipts`);
  }

  type DeleteQuery = {
    eq: (
      k: string,
      v: unknown,
    ) => DeleteQuery & PromiseLike<{ error: { message: string } | null; count: number | null }>;
  };
  const { error, count } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      delete: (opts?: { count: "exact" }) => DeleteQuery;
    }
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id); // ACTIVE-ORG PIN — count so a foreign PO is a not-found
  if (error) {
    console.error("[purchase-orders] delete failed", error);
    redirect(`/purchase-orders/${id}?error=delete_denied`);
  }
  // Foreign-org or already-gone PO deletes 0 rows with no error — a not-found,
  // never a silent success. (RLS filtering non-admins lands here too.)
  if (!count) redirect(`/purchase-orders/${id}?error=delete_denied`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.deleted",
    targetTable: "purchase_orders",
    targetId: id,
    metadata: {},
  });

  revalidatePath("/purchase-orders");
  redirect("/purchase-orders?saved=deleted");
}

// ── Supplier bills (Financial Operations — closes committed → actual) ────────
// Recording a supplier's invoice against a PO posts the ACTUAL cost to
// `finances` (feeding job profitability) and closes the committed → actual loop.
// A bill IS a finances entry (no supplier_bills fork); the same-org guard trigger
// from 20261009 enforces tenancy at the database. It inherits the PO's job +
// supplier so the cost rolls up to the right job and against this PO.
const supplierBillSchema = z.object({
  amount: z.coerce.number().positive("Enter the bill amount").max(10_000_000),
  vat_rate: z.coerce
    .number()
    .refine((v) => [0, 5, 20].includes(v), "VAT must be 0, 5 or 20"),
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
  bill_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  category: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(60).optional(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
});

export async function recordSupplierBill(
  purchaseOrderId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(purchaseOrderId).success) {
    return formError("Invalid purchase order.");
  }

  const parsed = supplierBillSchema.safeParse({
    amount: formData.get("amount"),
    vat_rate: formData.get("vat_rate") ?? 20,
    reference: formData.get("reference") ?? "",
    bill_date: formData.get("bill_date") ?? "",
    category: formData.get("category") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the bill details.");
  }

  const supabase = await createClient();

  // Load the PO and inherit its job + supplier.
  //
  // ACTIVE-ORG PIN. RLS alone admits every org the caller belongs to, so for a
  // dual-org member this read would happily return the OTHER company's order —
  // and the bill below is then written with THIS org's org_id while inheriting
  // that order's job_id and supplier_id. The finances org-integrity trigger
  // (20261009) already refuses a foreign supplier_id, but the job_id path has
  // no such backstop: the result would be a cost stamped to company A carrying
  // company B's job, quietly corrupting one job's profitability with another
  // company's spend. A wrong-org order is simply not found.
  type BillPoQuery = {
    eq: (k: string, v: string) => BillPoQuery;
    maybeSingle: () => Promise<{
      data: { id: string; job_id: string | null; supplier_id: string | null } | null;
      error: SupabaseReadError | null;
    }>;
  };
  const { data: po, error: poError } = await (
    supabase.from("purchase_orders" as never) as unknown as {
      select: (c: string) => BillPoQuery;    }
  )
    .select("id, job_id, supplier_id")
    .eq("id", purchaseOrderId)
    .eq("org_id", ctx.org.id) // ACTIVE-ORG PIN
    .maybeSingle();

  // Throw BEFORE any write — a failed read must not report "not found" and
  // must never let a bill post without the PO's job/supplier inheritance.
  if (poError) throw readFailure("supplier bill: purchase order", poError);
  if (!po) return formError("Purchase order not found.");

  // Belt to the pin's braces: the job the cost will be attributed to must be in
  // the active org too. The pin above already guarantees it (a PO's job_id is
  // held same-org by tg_purchase_order_org_integrity, 20261011), so this is a
  // cheap independent re-check of the single field that has no database
  // backstop on the finances side.
  if (po.job_id) {
    type JobQuery = {
      eq: (k: string, v: string) => JobQuery;
      maybeSingle: () => Promise<{ data: { id: string } | null }>;
    };
    const { data: job } = await (
      supabase.from("jobs" as never) as unknown as { select: (c: string) => JobQuery }
    )
      .select("id")
      .eq("id", po.job_id)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (!job) return formError("Purchase order not found.");
  }

  // Idempotency / double-submit guard — a retried POST or a double-click racing the
  // client-side disable would otherwise insert the SAME supplier bill twice, doubling
  // the job's ACTUAL cost and understating profit (finances has no natural-key
  // uniqueness on bills). Match an identical bill on the same PO within a few seconds
  // and treat it as an idempotent no-op.
  type DupeQ = {
    select: (c: string) => DupeQ;
    eq: (k: string, v: unknown) => DupeQ;
    is: (k: string, v: unknown) => DupeQ;
    gte: (k: string, v: unknown) => DupeQ;
    limit: (n: number) => DupeQ;
    maybeSingle: () => Promise<{ data: { id: string } | null }>;
  };
  const DEDUPE_WINDOW_MS = 10_000;
  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  let dupQuery = (supabase.from("finances" as never) as unknown as DupeQ)
    .select("id")
    .eq("org_id", ctx.org.id)
    .eq("purchase_order_id", po.id)
    .eq("amount", parsed.data.amount)
    .gte("created_at", sinceIso)
    .limit(1);
  dupQuery = parsed.data.reference
    ? dupQuery.eq("reference", parsed.data.reference)
    : dupQuery.is("reference", null);
  const { data: existingBill } = await dupQuery.maybeSingle();
  if (existingBill) {
    console.warn("[purchase-orders] duplicate supplier bill suppressed", {
      orgId: ctx.org.id,
      poId: po.id,
      billId: existingBill.id,
    });
    revalidatePath(`/purchase-orders/${po.id}`);
    if (po.job_id) revalidatePath(`/jobs/${po.job_id}`);
    revalidatePath("/finances");
    return formSuccess({ successMessage: "Bill recorded." });
  }

  const { error } = await (
    supabase.from("finances" as never) as unknown as {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    org_id: ctx.org.id,
    purchase_order_id: po.id,
    supplier_id: po.supplier_id,
    job_id: po.job_id,
    amount: parsed.data.amount,
    vat_rate: parsed.data.vat_rate,
    category: parsed.data.category ?? "Materials",
    reference: parsed.data.reference ?? null,
    bill_date: parsed.data.bill_date ?? null,
    notes: parsed.data.notes ?? null,
  });
  if (error) {
    console.error("[purchase-orders] record bill failed", error);
    return formError("Couldn't record the bill. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "purchase_order.bill_recorded",
    targetTable: "purchase_orders",
    targetId: po.id,
    metadata: {
      amount: parsed.data.amount,
      reference: parsed.data.reference ?? null,
      job_id: po.job_id,
    },
  });

  revalidatePath(`/purchase-orders/${po.id}`);
  if (po.job_id) revalidatePath(`/jobs/${po.job_id}`);
  revalidatePath("/finances");
  return formSuccess({ successMessage: "Bill recorded." });
}
