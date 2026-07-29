"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { notifyOnSetupFeePaid } from "@/lib/notifications/events";
import {
  BILLING_INVOICE_KINDS,
  BILLING_INVOICE_STATUSES,
} from "@/lib/hq/billing";

/**
 * Billing OS — server actions (HQ-4).
 *
 * Every mutating action:
 *   1. Re-checks isSuperAdminEmail (defence in depth on top of the
 *      /admin/* layout gate).
 *   2. Writes to `public.billing_invoices` via service-role.
 *   3. Records one row to `public.admin_activity_log` so the
 *      Customer OS timeline (HQ-3) and any future alerts feed (HQ-5)
 *      can render the event.
 *
 * No Stripe wiring yet — operator-managed today; webhooks land into
 * `billing_events` in HQ-4-stripe and flip the relevant invoice
 * status via this same code path.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

// Same cast helper as hq-billing-snapshot until db:generate picks up
// the new tables.
type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  single: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
};
type AnyMutation = {
  eq: (k: string, v: unknown) => Promise<{
    error: { message: string } | null;
  }> & AnyMutation;
  select: (cols?: string) => AnyQuery;
};
function untypedAdminTable(name: string) {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as {
    insert: (payload: unknown) => Promise<{
      data: unknown | null;
      error: { message: string } | null;
    }> & { select: (cols?: string) => AnyQuery };
    select: (cols: string) => AnyQuery;
    update: (payload: unknown) => AnyMutation;
  };
}

// --------------------------------------------------------------------
// Create invoice — operator records "I sent customer a £500 invoice"
// (or marks a setup fee as sent).
// --------------------------------------------------------------------

const createInvoiceSchema = z.object({
  org_id: z.string().uuid(),
  kind: z.enum(BILLING_INVOICE_KINDS),
  amount_gbp: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? 0 : v),
    z.coerce.number().min(0).max(1_000_000),
  ),
  status: z.enum(BILLING_INVOICE_STATUSES).default("sent"),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => null)),
  period_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => null)),
  period_end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => null)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => null)),
});

export async function createBillingInvoice(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = createInvoiceSchema.safeParse({
    org_id: formData.get("org_id"),
    kind: formData.get("kind"),
    amount_gbp: formData.get("amount_gbp"),
    status: formData.get("status") ?? "sent",
    due_date: formData.get("due_date") ?? "",
    period_start: formData.get("period_start") ?? "",
    period_end: formData.get("period_end") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/admin/billing?error=${encodeURIComponent("Invalid invoice input")}`,
    );
  }

  const now = new Date().toISOString();
  type Insert = {
    org_id: string;
    kind: string;
    amount_gbp: number;
    status: string;
    due_date: string | null;
    period_start: string | null;
    period_end: string | null;
    notes: string | null;
    sent_at: string | null;
    paid_at: string | null;
    created_by: string;
  };
  const insert: Insert = {
    org_id: parsed.data.org_id,
    kind: parsed.data.kind,
    amount_gbp: parsed.data.amount_gbp,
    status: parsed.data.status,
    due_date: parsed.data.due_date ?? null,
    period_start: parsed.data.period_start ?? null,
    period_end: parsed.data.period_end ?? null,
    notes: parsed.data.notes ?? null,
    // Status-derived stamps so the lifecycle history is honest from
    // the moment the row lands.
    sent_at: parsed.data.status !== "draft" ? now : null,
    paid_at: parsed.data.status === "paid" ? now : null,
    created_by: admin.id,
  };

  const inserted = await untypedAdminTable("billing_invoices")
    .insert(insert)
    .select("id");
  // Insert returns the chain — we want the data id. Use a follow-up
  // single() pattern since the insert path doesn't natively chain.
  let newId: string | null = null;
  try {
    const idRes = (inserted as unknown as {
      data: Array<{ id: string }> | null;
    }).data;
    newId = idRes?.[0]?.id ?? null;
  } catch {
    newId = null;
  }

  // Also flip the org's setup_fee_status if this is a setup_fee
  // invoice — keeps the customer detail header in sync.
  if (parsed.data.kind === "setup_fee") {
    const supabase = createAdminClient();
    const setupStatus =
      parsed.data.status === "paid"
        ? "paid"
        : parsed.data.status === "void"
          ? "pending"
          : "sent";
    await supabase
      .from("organizations")
      .update({
        setup_fee_status: setupStatus,
        setup_fee_paid_at: parsed.data.status === "paid" ? now : null,
      } as never)
      .eq("id", parsed.data.org_id);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `billing.invoice_${parsed.data.status}`,
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      invoice_id: newId,
      kind: parsed.data.kind,
      amount_gbp: parsed.data.amount_gbp,
      status: parsed.data.status,
    },
  });

  revalidatePath("/admin/billing");
  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  redirect(`/admin/billing?saved=invoice_created&org=${parsed.data.org_id}`);
}

// --------------------------------------------------------------------
// Status flips on an existing invoice — Mark paid / Mark failed /
// Refund / Void.
// --------------------------------------------------------------------

const flipSchema = z.object({
  invoice_id: z.string().uuid(),
  status: z.enum(["paid", "failed", "refunded", "void"]),
  failure_reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal("").transform(() => null)),
});

export async function setBillingInvoiceStatus(
  formData: FormData,
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = flipSchema.safeParse({
    invoice_id: formData.get("invoice_id"),
    status: formData.get("status"),
    failure_reason: formData.get("failure_reason") ?? "",
  });
  if (!parsed.success) {
    redirect(`/admin/billing?error=${encodeURIComponent("Invalid status flip")}`);
  }

  const now = new Date().toISOString();
  type Update = {
    status: string;
    paid_at?: string | null;
    failed_at?: string | null;
    voided_at?: string | null;
    failure_reason?: string | null;
  };
  const update: Update = { status: parsed.data.status };
  if (parsed.data.status === "paid") {
    update.paid_at = now;
    update.failed_at = null;
    update.failure_reason = null;
  } else if (parsed.data.status === "failed") {
    update.failed_at = now;
    update.failure_reason = parsed.data.failure_reason ?? null;
  } else if (parsed.data.status === "refunded") {
    // Keep paid_at; refunded implies it was paid first.
  } else if (parsed.data.status === "void") {
    update.voided_at = now;
  }

  // Load the row for audit metadata + so we can flip the org's
  // setup_fee_status when this is the setup invoice.
  const { data: rowData, error: rowError } = await untypedAdminTable(
    "billing_invoices",
  )
    .select("id, org_id, kind, amount_gbp")
    .eq("id", parsed.data.invoice_id)
    .maybeSingle();
  if (rowError) {
    // Throw BEFORE the status update: proceeding with a failed read would
    // flip the invoice without syncing the org's setup_fee_status.
    throw readFailure("admin setBillingInvoiceStatus: invoice", rowError);
  }
  const row = rowData as
    | {
        id: string;
        org_id: string;
        kind: string;
        amount_gbp: number | string;
      }
    | null;

  const result = await untypedAdminTable("billing_invoices")
    .update(update)
    .eq("id", parsed.data.invoice_id);
  if (result.error) {
    console.error("[hq/billing] setBillingInvoiceStatus failed", result.error);
    redirect(
      `/admin/billing?error=${encodeURIComponent("Couldn't save — try again.")}`,
    );
  }

  // Keep org-level setup_fee_status in sync for setup invoices.
  if (row?.kind === "setup_fee") {
    const supabase = createAdminClient();
    const setupStatus =
      parsed.data.status === "paid"
        ? "paid"
        : parsed.data.status === "refunded"
          ? "refunded"
          : parsed.data.status === "void"
            ? "pending"
            : "sent";
    await supabase
      .from("organizations")
      .update({
        setup_fee_status: setupStatus,
        setup_fee_paid_at: parsed.data.status === "paid" ? now : null,
      } as never)
      .eq("id", row.org_id);

    // When the operator marks a setup-fee invoice paid (e.g. for a
    // bank-transfer payment outside Stripe), notify customer + HQ
    // the same as if Stripe had told us.
    if (parsed.data.status === "paid") {
      await emitNotifications(
        notifyOnSetupFeePaid({
          org_id: row.org_id,
          amount_gbp: Number(row.amount_gbp ?? 1000),
        }),
      );
    }
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `billing.invoice_${parsed.data.status}`,
    targetTable: "organizations",
    targetId: row?.org_id ?? parsed.data.invoice_id,
    metadata: {
      invoice_id: parsed.data.invoice_id,
      kind: row?.kind ?? null,
      amount_gbp: row?.amount_gbp ?? null,
      failure_reason: parsed.data.failure_reason ?? null,
    },
  });

  revalidatePath("/admin/billing");
  if (row?.org_id) {
    revalidatePath(`/admin/customers/${row.org_id}`);
  }
  redirect(
    `/admin/billing?saved=invoice_${parsed.data.status}${row ? `&org=${row.org_id}` : ""}`,
  );
}

// --------------------------------------------------------------------
// Renewal date — operator-managed today, Stripe-managed once we wire
// up the subscription.updated webhook.
// --------------------------------------------------------------------

const renewalSchema = z.object({
  org_id: z.string().uuid(),
  next_renewal_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => null)),
});

export async function setNextRenewal(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = renewalSchema.safeParse({
    org_id: formData.get("org_id"),
    next_renewal_at: formData.get("next_renewal_at") ?? "",
  });
  if (!parsed.success) {
    redirect(`/admin/billing?error=${encodeURIComponent("Invalid date")}`);
  }

  const supabase = createAdminClient();
  // Convert YYYY-MM-DD → midnight UTC timestamp.
  const ts = parsed.data.next_renewal_at
    ? `${parsed.data.next_renewal_at}T00:00:00Z`
    : null;
  const { error } = await supabase
    .from("organizations")
    .update({ next_renewal_at: ts } as never)
    .eq("id", parsed.data.org_id);
  if (error) {
    console.error("[hq/billing] setNextRenewal failed", error);
    redirect(`/admin/billing?error=${encodeURIComponent("Couldn't save.")}`);
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "billing.renewal_set",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: { next_renewal_at: parsed.data.next_renewal_at ?? null },
  });

  revalidatePath("/admin/billing");
  redirect(`/admin/billing?saved=renewal&org=${parsed.data.org_id}`);
}
