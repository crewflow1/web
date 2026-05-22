"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { SETUP_FEE_STATUSES } from "@/lib/hq/customer-financials";

/**
 * Customers OS — server actions.
 *
 * Every action is dual-write: the source-of-truth column on
 * `organizations` AND one row in `admin_activity_log` so the CEO
 * timeline can see exactly who flipped what, when, and from where.
 *
 * Gating: every action re-checks isSuperAdminEmail. The /admin/*
 * layout already 404s non-allowlisted users, but defence-in-depth
 * stops a stolen-cookie attempt that somehow reaches an action URL
 * directly.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

// --------------------------------------------------------------------
// Financials — MRR, setup fee, billing email
// --------------------------------------------------------------------

const financialsSchema = z.object({
  org_id: z.string().uuid(),
  setup_fee_status: z.enum(SETUP_FEE_STATUSES),
  mrr_gbp: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? 0 : v),
    z.coerce.number().min(0).max(100_000),
  ),
  billing_email: z
    .string()
    .trim()
    .max(254)
    .email()
    .or(z.literal("").transform(() => null))
    .optional(),
  ltv_gbp: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce.number().min(0).max(10_000_000).nullable(),
  ),
});

export async function updateCustomerFinancials(
  formData: FormData,
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = financialsSchema.safeParse({
    org_id: formData.get("org_id"),
    setup_fee_status: formData.get("setup_fee_status"),
    mrr_gbp: formData.get("mrr_gbp"),
    billing_email: formData.get("billing_email") ?? "",
    ltv_gbp: formData.get("ltv_gbp") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/admin/customers?error=${encodeURIComponent("Invalid financials input")}`,
    );
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Pull the current row so the audit entry can carry old → new.
  const { data: prev } = await supabase
    .from("organizations")
    .select(
      "setup_fee_status, setup_fee_paid_at, mrr_gbp, billing_email, ltv_gbp" as never,
    )
    .eq("id", parsed.data.org_id)
    .maybeSingle();
  const prevRow = prev as unknown as {
    setup_fee_status: string | null;
    setup_fee_paid_at: string | null;
    mrr_gbp: number | string | null;
    billing_email: string | null;
    ltv_gbp: number | string | null;
  } | null;

  type Update = {
    setup_fee_status: string;
    setup_fee_paid_at?: string | null;
    mrr_gbp: number;
    billing_email: string | null;
    ltv_gbp?: number | null;
  };
  const update: Update = {
    setup_fee_status: parsed.data.setup_fee_status,
    mrr_gbp: parsed.data.mrr_gbp,
    billing_email: parsed.data.billing_email ?? null,
    ltv_gbp: parsed.data.ltv_gbp ?? null,
  };
  // Stamp paid_at the FIRST time the operator flips to "paid".
  if (
    parsed.data.setup_fee_status === "paid" &&
    prevRow?.setup_fee_status !== "paid"
  ) {
    update.setup_fee_paid_at = now;
  }
  // If they're un-flagging paid, clear the timestamp so health-score
  // maths stays honest.
  if (
    parsed.data.setup_fee_status !== "paid" &&
    parsed.data.setup_fee_status !== "waived" &&
    prevRow?.setup_fee_paid_at
  ) {
    update.setup_fee_paid_at = null;
  }

  const { error } = await supabase
    .from("organizations")
    .update(update as never)
    .eq("id", parsed.data.org_id);
  if (error) {
    console.error("[hq/customers] updateCustomerFinancials failed", error);
    redirect(
      `/admin/customers/${parsed.data.org_id}?error=${encodeURIComponent("Couldn't save — try again.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "customer.financials_updated",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      setup_fee_from: prevRow?.setup_fee_status ?? null,
      setup_fee_to: parsed.data.setup_fee_status,
      mrr_from: prevRow?.mrr_gbp ?? null,
      mrr_to: parsed.data.mrr_gbp,
      billing_email: parsed.data.billing_email ?? null,
    },
  });

  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  redirect(`/admin/customers/${parsed.data.org_id}?saved=financials`);
}

// --------------------------------------------------------------------
// Onboarding / Migration progress
// --------------------------------------------------------------------

const progressSchema = z.object({
  org_id: z.string().uuid(),
  onboarding_percent: z.coerce.number().int().min(0).max(100),
  migration_percent: z.coerce.number().int().min(0).max(100),
  migration_stage: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => null)),
  migration_eta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => null)),
});

export async function updateCustomerProgress(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = progressSchema.safeParse({
    org_id: formData.get("org_id"),
    onboarding_percent: formData.get("onboarding_percent") ?? "0",
    migration_percent: formData.get("migration_percent") ?? "0",
    migration_stage: formData.get("migration_stage") ?? "",
    migration_eta: formData.get("migration_eta") ?? "",
  });
  if (!parsed.success) {
    redirect(`/admin/customers?error=${encodeURIComponent("Invalid progress input")}`);
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("organizations")
    .update({
      onboarding_percent: parsed.data.onboarding_percent,
      migration_percent: parsed.data.migration_percent,
      migration_stage: parsed.data.migration_stage ?? null,
      migration_eta: parsed.data.migration_eta ?? null,
    } as never)
    .eq("id", parsed.data.org_id);
  if (error) {
    console.error("[hq/customers] updateCustomerProgress failed", error);
    redirect(
      `/admin/customers/${parsed.data.org_id}?error=${encodeURIComponent("Couldn't save.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "customer.progress_updated",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      onboarding_percent: parsed.data.onboarding_percent,
      migration_percent: parsed.data.migration_percent,
      migration_stage: parsed.data.migration_stage ?? null,
      migration_eta: parsed.data.migration_eta ?? null,
    },
  });

  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  redirect(`/admin/customers/${parsed.data.org_id}?saved=progress`);
}

// --------------------------------------------------------------------
// CEO notes
// --------------------------------------------------------------------

const noteSchema = z.object({
  org_id: z.string().uuid(),
  notes: z.string().trim().max(10_000).optional().or(z.literal("")),
});

export async function updateCustomerNotes(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = noteSchema.safeParse({
    org_id: formData.get("org_id"),
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    redirect(`/admin/customers?error=${encodeURIComponent("Invalid note input")}`);
  }

  const supabase = createAdminClient();
  const value = parsed.data.notes ?? "";
  const { error } = await supabase
    .from("organizations")
    .update({ admin_org_notes: value || null } as never)
    .eq("id", parsed.data.org_id);
  if (error) {
    console.error("[hq/customers] updateCustomerNotes failed", error);
    redirect(
      `/admin/customers/${parsed.data.org_id}?error=${encodeURIComponent("Couldn't save notes.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "customer.notes_updated",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: { length: value.length },
  });

  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  redirect(`/admin/customers/${parsed.data.org_id}?saved=notes`);
}

// --------------------------------------------------------------------
// Suspend / Cancel (reuses the /admin/organizations status machinery
// but lives here so the customer detail page doesn't have to import
// across panels).
// --------------------------------------------------------------------

const lifecycleSchema = z.object({
  org_id: z.string().uuid(),
  status: z.enum(["suspended", "cancelled", "active", "trial"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function setCustomerLifecycle(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = lifecycleSchema.safeParse({
    org_id: formData.get("org_id"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    redirect(`/admin/customers?error=${encodeURIComponent("Invalid lifecycle input")}`);
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  type Update = {
    status: string;
    suspended_at?: string | null;
    cancelled_at?: string | null;
    approved_at?: string | null;
    rejection_reason?: string | null;
  };
  const update: Update = { status: parsed.data.status };
  if (parsed.data.status === "suspended") update.suspended_at = now;
  else if (parsed.data.status === "cancelled") update.cancelled_at = now;
  else if (parsed.data.status === "active" || parsed.data.status === "trial") {
    update.suspended_at = null;
    update.cancelled_at = null;
    update.approved_at = now;
  }

  const { error } = await supabase
    .from("organizations")
    .update(update as never)
    .eq("id", parsed.data.org_id);
  if (error) {
    console.error("[hq/customers] setCustomerLifecycle failed", error);
    redirect(
      `/admin/customers/${parsed.data.org_id}?error=${encodeURIComponent("Couldn't save.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `customer.lifecycle_${parsed.data.status}`,
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: { reason: parsed.data.reason ?? null },
  });

  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
  redirect(
    `/admin/customers/${parsed.data.org_id}?saved=lifecycle_${parsed.data.status}`,
  );
}

// --------------------------------------------------------------------
// Impersonate (stub — audit-only for HQ-3.0)
//
// Full impersonation (session swap with a banner injected into the
// customer workspace) needs its own focused PR. For now this action
// just records the intent to admin_activity_log so the audit trail
// is in place when the real flow lands.
// --------------------------------------------------------------------

const impersonateSchema = z.object({
  org_id: z.string().uuid(),
  reason: z.string().trim().min(1, "Reason required").max(500),
});

export async function logImpersonationAttempt(
  formData: FormData,
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = impersonateSchema.safeParse({
    org_id: formData.get("org_id"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/admin/customers?error=${encodeURIComponent("Impersonation reason required")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "customer.impersonation_requested",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      reason: parsed.data.reason,
      // Full session-swap implementation lands in HQ-3.1.
      implemented: false,
    },
  });

  redirect(
    `/admin/customers/${parsed.data.org_id}?saved=impersonation_logged`,
  );
}
