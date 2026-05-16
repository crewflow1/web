"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Job CRUD server actions.
 *
 * RLS posture on `jobs` (from migration 20260515150000):
 *   - SELECT / INSERT: org members
 *   - UPDATE / DELETE: admins/owners only
 *
 * Non-admins who attempt update/delete will see RLS silently filter the
 * row out (zero rows affected). We surface this as a generic error
 * message — the form re-renders and the user can ask an admin.
 *
 * customer_id and assigned_to are optional (nullable in schema):
 *   - assigned_to: empty string from <select> -> null
 *   - customer_id: empty string -> null (job not yet linked to a customer)
 */

const STATUSES = ["new", "in-progress", "completed", "blocked"] as const;

const RECURRING_PATTERNS = ["weekly", "biweekly", "monthly", "quarterly"] as const;

const jobSchema = z.object({
  customer_id: z.string().uuid().or(z.literal("").transform(() => undefined)).optional(),
  assigned_to: z.string().uuid().or(z.literal("").transform(() => undefined)).optional(),
  status: z.enum(STATUSES),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .or(z.literal("").transform(() => undefined))
    .optional(),
  notes: z.string().trim().max(5000).optional().or(z.literal("").transform(() => undefined)),
  recurring_pattern: z
    .enum(RECURRING_PATTERNS)
    .or(z.literal("").transform(() => undefined))
    .optional(),
  recurring_end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .or(z.literal("").transform(() => undefined))
    .optional(),
});

function parseForm(formData: FormData) {
  return jobSchema.safeParse({
    customer_id: formData.get("customer_id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
    status: formData.get("status") ?? "new",
    scheduled_date: formData.get("scheduled_date") ?? "",
    notes: formData.get("notes") ?? "",
    recurring_pattern: formData.get("recurring_pattern") ?? "",
    recurring_end_date: formData.get("recurring_end_date") ?? "",
  });
}

function buildRecurring(
  pattern: string | undefined,
  endDate: string | undefined,
): { pattern: string; end_date?: string } | null {
  if (!pattern) return null;
  return endDate ? { pattern, end_date: endDate } : { pattern };
}

export async function createJob(formData: FormData) {
  const { ctx } = await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/jobs/new?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const recurring = buildRecurring(
    parsed.data.recurring_pattern,
    parsed.data.recurring_end_date,
  );
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      org_id: ctx.org.id,
      customer_id: parsed.data.customer_id ?? null,
      assigned_to: parsed.data.assigned_to ?? null,
      status: parsed.data.status,
      scheduled_date: parsed.data.scheduled_date ?? null,
      notes: parsed.data.notes ?? null,
      recurring,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[jobs] create failed", error);
    redirect("/jobs/new?error=create_failed");
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${data.id}`);
}

export async function updateJob(id: string, formData: FormData) {
  await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid input";
    redirect(`/jobs/${id}?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const recurring = buildRecurring(
    parsed.data.recurring_pattern,
    parsed.data.recurring_end_date,
  );
  const { error, count } = await supabase
    .from("jobs")
    .update({
      customer_id: parsed.data.customer_id ?? null,
      assigned_to: parsed.data.assigned_to ?? null,
      status: parsed.data.status,
      scheduled_date: parsed.data.scheduled_date ?? null,
      notes: parsed.data.notes ?? null,
      recurring,
    }, { count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("[jobs] update failed", error);
    redirect(`/jobs/${id}?error=update_failed`);
  }
  // Zero rows = RLS denied (caller isn't admin) or row gone.
  if (count === 0) {
    redirect(`/jobs/${id}?error=update_denied`);
  }

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  redirect(`/jobs/${id}?saved=1`);
}

export async function deleteJob(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("jobs")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("[jobs] delete failed", error);
    redirect(`/jobs/${id}?error=delete_failed`);
  }
  if (count === 0) {
    redirect(`/jobs/${id}?error=delete_denied`);
  }
  revalidatePath("/jobs");
  redirect("/jobs");
}
