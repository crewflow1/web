"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";
import { formatDayKeyUK } from "@/lib/time/format";

/**
 * Job progress — server actions (migration 20261078).
 *
 * Records one dated percent-complete observation against a job.
 *
 * NAVIGATION: returns `FormState` and lets <StateForm> navigate via
 * `redirectTo` (a full document load). NOT `redirect()` — a Server-Action
 * redirect back onto /jobs/[id] is the same-route deep swap measured losing
 * 60–100% of navigations to the Next 15.5 stranded-commit race
 * (vercel/next.js#83386). No `revalidatePath`, matching retention-actions.ts:
 * the job page renders per-request from cookie-authed reads, so revalidation
 * only adds weight to the racy response.
 *
 * ACTIVE-ORG PINNING: `ctx.org.id` pins every statement. RLS alone is NOT
 * enough — `current_org_ids()` admits every org the caller belongs to, so a
 * dual-org member could otherwise write an observation into the workspace they
 * are not looking at. The composite FK (job_id, org_id) → jobs(id, org_id) then
 * makes a cross-tenant write structurally impossible even if this predicate
 * were ever dropped; the explicit read below exists to turn that constraint
 * violation into a sentence a human can act on.
 *
 * NOT A VALUATION: this action writes a percentage and nothing else. It raises
 * no invoice, touches no finances row and reads no billing plan. Staged billing
 * (job_billing_plans + generate_stage_invoice) remains the only path to money,
 * and it stays driven by an explicit human act per stage.
 */

const idSchema = z.string().uuid();
const jobUrl = (jobId: string, params: string): string => `/jobs/${jobId}?${params}`;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const progressSchema = z.object({
  percent: z.coerce
    .number({ message: "Enter a percentage between 0 and 100" })
    .int("Use a whole number")
    .min(0, "Progress can't be below 0%")
    .max(100, "Progress can't be above 100%"),
  observed_on: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD")
      .optional(),
  ),
  note: z.preprocess(blankToUndefined, z.string().trim().max(2000).optional()),
});

type UpsertClient = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          maybeSingle: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    upsert: (
      row: unknown,
      opts: { onConflict: string },
    ) => {
      select: (c: string) => {
        maybeSingle: () => Promise<{
          data: { id: string } | null;
          error: { message: string; code?: string | null } | null;
        }>;
      };
    };
  };
};

/**
 * Record (or correct) today's — or a back-dated — progress reading.
 *
 * UPSERT on the (job_id, observed_on) unique key: the table holds ONE reading
 * per job per day by design, so re-submitting a day is a CORRECTION of that
 * day, not a second contradictory point on the curve. `recorded_by` moves with
 * the correction (the author of the current figure), while `created_at` keeps
 * the original entry time — so a corrected figure still shows when the day was
 * first assessed.
 *
 * Progress may go DOWN. Nothing here compares the new figure with the previous
 * one: rework and failed inspections are real, and a form that refused them
 * would just teach site staff to stop recording.
 */
export async function recordJobProgress(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) {
    return formError("That job link looks wrong — reload and try again.");
  }

  const parsed = progressSchema.safeParse({
    percent: formData.get("percent"),
    observed_on: formData.get("observed_on") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the figures and try again.");
  }
  const input = parsed.data;

  // Default to the EUROPE/LONDON day, not the server's UTC day: at 00:30 BST a
  // UK user's "today" is still the previous UTC date, and defaulting to that
  // would file the reading a day early — and be rejected outright if they then
  // corrected it forward.
  const today = formatDayKeyUK(new Date());
  const observedOn = input.observed_on ?? today;
  if (observedOn > today) {
    return formError("Progress can't be recorded for a future date.");
  }

  const supabase = (await createClient()) as unknown as UpsertClient;

  // ACTIVE-org check (see header) — a friendly refusal instead of an FK error.
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError || !job) {
    return formError("That job isn't in this workspace — switch workspace and try again.");
  }

  const { error } = await supabase
    .from("job_progress_observations")
    .upsert(
      {
        org_id: ctx.org.id,
        job_id: jobId,
        observed_on: observedOn,
        percent: input.percent,
        note: input.note ?? null,
        recorded_by: user.id,
      },
      { onConflict: "job_id,observed_on" },
    )
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[job-progress] record failed", error);
    return formError("Couldn't save that progress update. Refresh and try again.");
  }

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=progress#progress") });
}
