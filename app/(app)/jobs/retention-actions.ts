"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  computeRetentionPosition,
  maxReleasable,
} from "@/lib/retentions/compute";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Retention server actions (Programme C).
 *
 * RLS posture:
 *   - jobs.retention_percent  → UPDATE is admins-only (jobs update policy).
 *   - retention_releases      → members INSERT; the DB guard enforces the
 *     commercial invariants (no over-release, org integrity, positive amount);
 *     a recorded release is immutable.
 *
 * The DB is the authority; here we pre-check with the SAME derivation the guard
 * uses so the operator gets a friendly message instead of a raw constraint
 * error, then let the guard be the backstop.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`:
 * a Server-Action redirect back onto /jobs/[id] is the same-route swap shape
 * measured losing 60-100% of navigations on the app's heavy detail pages to
 * the Next 15.5 stranded-commit race (rows written, URL frozen, no error —
 * vercel/next.js#83386). No revalidatePath, deliberately: the job page renders
 * per-request from cookie-authed reads, so revalidation only added weight to
 * the racy response. See components/forms/StateForm.tsx.
 */

const idSchema = z.string().uuid();
const jobUrl = (jobId: string, params: string): string => `/jobs/${jobId}?${params}`;

const rateSchema = z.coerce.number().min(0, "Rate can't be negative").max(100, "Rate can't exceed 100%");

export async function setJobRetentionRate(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");

  const parsed = rateSchema.safeParse(formData.get("retention_percent"));
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Invalid rate");
  }
  const rate = Math.round(parsed.data * 100) / 100;

  const supabase = await createClient();
  // jobs.retention_percent is added by 20261005000000 but not yet in the
  // generated Supabase types — cast the writer.
  const { data, error } = await (
    supabase.from("jobs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            select: (c: string) => {
              maybeSingle: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
            };
          };
        };
      };
    }
  )
    .update({ retention_percent: rate })
    .eq("id", jobId)
    // Active-org scope — RLS's is_org_admin() passes for every org the caller
    // administers, so this predicate is what pins the write to the org the
    // user is actually working in. See lib/jobs/load.
    .eq("org_id", ctx.org.id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // RLS filters the row out for non-admins → zero rows, no error.
    console.error("[retention] set rate failed", error);
    return formError("Couldn't set the retention rate — only admins can, and the job must be in this workspace.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "retention.rate_set",
    targetTable: "jobs",
    targetId: jobId,
    metadata: { retention_percent: rate },
  });

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=retention_rate") });
}

const releaseSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than zero").max(10_000_000, "Unrealistic amount"),
  released_on: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  ),
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
});

export async function recordRetentionRelease(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");

  const parsed = releaseSchema.safeParse({
    amount: formData.get("amount"),
    released_on: formData.get("released_on") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Invalid release");
  }
  const input = parsed.data;

  const supabase = await createClient();

  // Resolve the job (ACTIVE-org check + current retention rate) and the current
  // position, so we can refuse an over-release with a clear message up front.
  // The org predicate is load-bearing: this row's org_id was previously used as
  // the insert target below, so an unscoped read let a release be written into
  // ANOTHER org's ledger. retention_percent / retention_releases /
  // invoices.job_id are not yet in the generated types — cast the readers.
  const { data: job } = await (
    supabase.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string; org_id: string; retention_percent: number | string | null } | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, org_id, retention_percent")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!job) return formError("Job not found in this workspace.");

  const [{ data: invoices }, { data: releases }] = await Promise.all([
    (
      supabase.from("invoices" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => Promise<{ data: Array<{ status: string; amount: number | string | null }> | null }>;
        };
      }
    )
      .select("status, amount")
      .eq("job_id", jobId),
    (
      supabase.from("retention_releases" as never) as unknown as {
        select: (c: string) => {
          eq: (k: string, v: unknown) => Promise<{ data: Array<{ amount: number | string | null }> | null }>;
        };
      }
    )
      .select("amount")
      .eq("job_id", jobId),
  ]);

  const position = computeRetentionPosition({
    ratePercent: job.retention_percent,
    invoices: invoices ?? [],
    releases: releases ?? [],
  });

  if (!position.isActive) {
    return formError("Set a retention rate on this job before recording a release.");
  }
  if (input.amount > maxReleasable(position) + 0.005) {
    return formError(`Release exceeds retention held (${maxReleasable(position).toFixed(2)} available)`);
  }

  const { data, error } = await (
    supabase.from("retention_releases" as never) as unknown as {
      insert: (row: unknown) => {
        select: (c: string) => {
          single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
        };
      };
    }
  )
    .insert({
      // Identical to job.org_id now that the read above is org-scoped; written
      // from ctx so the active org is the explicit source of truth.
      org_id: ctx.org.id,
      job_id: jobId,
      amount: input.amount,
      released_on: input.released_on ?? undefined,
      note: input.note ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    // The DB guard is the backstop (over-release / org mismatch → check_violation).
    console.error("[retention] release insert failed", error);
    const overRelease = (error?.message ?? "").includes("exceeds held retention");
    return formError(
      overRelease
        ? "That release exceeds the retention currently held."
        : "Couldn't record the release — try again.",
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "retention.released",
    targetTable: "retention_releases",
    targetId: data.id,
    metadata: { job_id: jobId, amount: input.amount, released_on: input.released_on ?? null },
  });

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=retention_release") });
}

/**
 * Set the retention release schedule terms on a job (Programme C extension):
 * Practical Completion date, Defects Liability Period (months), and the % of
 * accrued retention released at PC. These drive the DERIVED release forecast
 * (`lib/retentions/schedule.ts`) — nothing here touches the releases ledger.
 *
 * Admin-only, exactly like `setJobRetentionRate`: the tenant client + the
 * admin-only `jobs` UPDATE RLS mean a non-admin's UPDATE matches 0 rows. The DB
 * CHECK constraints (months 0–120, pct 0–100) are the backstop; zod gives a
 * friendly message first. No service-role path.
 */
const scheduleSchema = z.object({
  practical_completion_date: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid completion date (YYYY-MM-DD)").nullable(),
  ),
  defects_liability_months: z.coerce
    .number()
    .int("Months must be a whole number")
    .min(0, "Can't be negative")
    .max(120, "Defects period can't exceed 120 months"),
  retention_first_release_pct: z.coerce
    .number()
    .min(0, "Can't be negative")
    .max(100, "Can't exceed 100%"),
});

export async function setRetentionSchedule(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");

  const parsed = scheduleSchema.safeParse({
    practical_completion_date: formData.get("practical_completion_date"),
    defects_liability_months: formData.get("defects_liability_months"),
    retention_first_release_pct: formData.get("retention_first_release_pct"),
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the retention schedule");
  }
  const values = parsed.data;

  const supabase = await createClient();
  // These jobs columns (20261013) aren't in the generated Supabase types — cast
  // the writer, same idiom as setJobRetentionRate. (Types regen is tracked in #398.)
  const { data, error } = await (
    supabase.from("jobs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            select: (c: string) => {
              maybeSingle: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
            };
          };
        };
      };
    }
  )
    .update({
      practical_completion_date: values.practical_completion_date,
      defects_liability_months: values.defects_liability_months,
      retention_first_release_pct: values.retention_first_release_pct,
    })
    .eq("id", jobId)
    // Active-org scope — see setJobRetentionRate.
    .eq("org_id", ctx.org.id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // RLS filters the row out for non-admins → zero rows, no error.
    console.error("[retention] set schedule failed", error);
    return formError("Couldn't save the retention schedule — only admins can, and the job must be in this workspace.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "retention.schedule_set",
    targetTable: "jobs",
    targetId: jobId,
    metadata: { ...values },
  });

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=retention_schedule") });
}
