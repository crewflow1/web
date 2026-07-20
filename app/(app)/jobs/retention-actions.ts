"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  computeRetentionPosition,
  maxReleasable,
} from "@/lib/retentions/compute";

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
 */

const idSchema = z.string().uuid();
const back = (jobId: string, params: string): never => {
  redirect(`/jobs/${jobId}?${params}`);
};

const rateSchema = z.coerce.number().min(0, "Rate can't be negative").max(100, "Rate can't exceed 100%");

export async function setJobRetentionRate(jobId: string, formData: FormData) {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) redirect("/jobs");

  const parsed = rateSchema.safeParse(formData.get("retention_percent"));
  if (!parsed.success) {
    back(jobId, `error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid rate")}`);
  }
  const rate = Math.round((parsed.success ? parsed.data : 0) * 100) / 100;

  const supabase = await createClient();
  // jobs.retention_percent is added by 20261005000000 but not yet in the
  // generated Supabase types — cast the writer.
  const { data, error } = await (
    supabase.from("jobs" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          select: (c: string) => {
            maybeSingle: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
          };
        };
      };
    }
  )
    .update({ retention_percent: rate })
    .eq("id", jobId)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // RLS filters the row out for non-admins → zero rows, no error.
    console.error("[retention] set rate failed", error);
    back(jobId, "error=retention_rate_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "retention.rate_set",
    targetTable: "jobs",
    targetId: jobId,
    metadata: { retention_percent: rate },
  });

  revalidatePath(`/jobs/${jobId}`);
  back(jobId, "saved=retention_rate");
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

export async function recordRetentionRelease(jobId: string, formData: FormData) {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) redirect("/jobs");

  const parsed = releaseSchema.safeParse({
    amount: formData.get("amount"),
    released_on: formData.get("released_on") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    back(jobId, `error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid release")}`);
  }
  const input = parsed.success ? parsed.data : { amount: 0, released_on: undefined, note: undefined };

  const supabase = await createClient();

  // Resolve the job (org check + current retention rate) and the current
  // position, so we can refuse an over-release with a clear message up front.
  // retention_percent / retention_releases / invoices.job_id are not yet in the
  // generated types — cast the readers.
  const { data: job } = await (
    supabase.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { id: string; org_id: string; retention_percent: number | string | null } | null;
          }>;
        };
      };
    }
  )
    .select("id, org_id, retention_percent")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) redirect("/jobs?error=job_not_found");

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
    back(jobId, "error=retention_not_set");
  }
  if (input.amount > maxReleasable(position) + 0.005) {
    back(
      jobId,
      `error=${encodeURIComponent(`Release exceeds retention held (${maxReleasable(position).toFixed(2)} available)`)}`,
    );
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
      org_id: job.org_id,
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
    back(jobId, overRelease ? "error=retention_over_release" : "error=retention_release_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "retention.released",
    targetTable: "retention_releases",
    targetId: data!.id,
    metadata: { job_id: jobId, amount: input.amount, released_on: input.released_on ?? null },
  });

  revalidatePath(`/jobs/${jobId}`);
  back(jobId, "saved=retention_release");
}
