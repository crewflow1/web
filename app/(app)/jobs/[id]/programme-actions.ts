"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Job programme — server actions (migration 20261085).
 *
 * Records a programme baseline revision: the planned window plus its
 * milestones, through the atomic `set_job_programme` RPC. The RPC is the ONLY
 * write path — supersede + header + children are one transaction under a
 * per-job advisory lock, so "two live baselines" and "a revision with half its
 * milestones" are unreachable states, not handled ones.
 *
 * NAVIGATION: returns `FormState` and lets <StateForm> navigate via
 * `redirectTo` (a full document load). NOT `redirect()` — a Server-Action
 * redirect back onto /jobs/[id] is the same-route deep swap measured losing
 * 60–100% of navigations to the Next 15.5 stranded-commit race
 * (vercel/next.js#83386). No `revalidatePath`, matching progress-actions.ts.
 *
 * ACTIVE-ORG PINNING: `ctx.org.id` pins the job check and is what the RPC
 * writes. RLS alone is NOT enough — `current_org_ids()` admits every org the
 * caller belongs to. The composite FK (job_id, org_id) → jobs(id, org_id) then
 * makes a cross-tenant write structurally impossible even if this predicate
 * were ever dropped; the explicit read below turns that constraint violation
 * into a sentence.
 *
 * THE ADMIN GATE IS THE DATABASE'S: the RPC is SECURITY INVOKER and the insert
 * policies are admin-only, so a staff member's JWT is refused by RLS whether
 * they come through this action or hit /rest/v1 directly. This action adds no
 * second gate to drift out of step with the real one.
 *
 * ERROR WORDING: the RPC raises pre-written human sentences ("a programme
 * needs at least one milestone", "milestone weights must sum to 100 …"). Those
 * are surfaced verbatim — they were authored for this form. Anything else
 * (constraint names, SQLSTATE noise) is replaced with a generic line: raw
 * Postgres is never echoed to a user (the C10 house rule).
 *
 * NOT A VALUATION: a milestone weight is a dimensionless share of the
 * programme. This action reads no billing plan, raises no invoice and touches
 * no finances row — the 20261078 decision-4 boundary, swept by
 * __tests__/security/job-programme-no-fabrication.test.ts.
 */

const idSchema = z.string().uuid();
const jobUrl = (jobId: string, params: string): string => `/jobs/${jobId}?${params}`;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const daySchema = z
  .string()
  .regex(DAY_KEY, "Use the date pickers — dates must be YYYY-MM-DD");

const headerSchema = z.object({
  planned_start: daySchema,
  planned_end: daySchema,
  note: z.preprocess(blankToUndefined, z.string().trim().max(2000).optional()),
});

/** How many milestone rows the form renders. Mirrored by _job-programme.tsx. */
const FORM_ROWS = 6;

interface MilestonePayload {
  title: string;
  planned_start: string | null;
  planned_end: string;
  weight: number | null;
  customer_visible: boolean;
}

type RpcClient = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
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
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

/**
 * The RPC's own refusal sentences, surfaced verbatim because they were written
 * for a human. A message matching none of these is replaced wholesale.
 */
const RPC_SENTENCES = [
  "a programme needs",
  "the planned end cannot be before",
  "every milestone needs",
  'milestone "',
  "a milestone weight must be",
  "weight every milestone or none",
  "milestone weights must sum to 100",
  "moving the programme needs a note",
];

function friendlyRpcError(message: string | undefined): string {
  const m = (message ?? "").trim();
  if (m && RPC_SENTENCES.some((s) => m.includes(s))) return m;
  return "Couldn't save the programme. Check the dates and milestones and try again.";
}

/**
 * Record (or re-baseline) this job's programme.
 *
 * Milestone rows arrive as indexed fields (milestone_title_1 … _N etc.); a row
 * with a blank title is SKIPPED (an unused form row, not an error), a row with
 * a title but no end date is refused with a sentence. Everything about the SET
 * — non-empty, dates inside the window, all-or-none weights summing to 100,
 * the note required to move an existing baseline — is enforced INSIDE the RPC,
 * where it also binds every other caller.
 */
export async function setJobProgramme(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) {
    return formError("That job link looks wrong — reload and try again.");
  }

  const parsed = headerSchema.safeParse({
    planned_start: formData.get("planned_start") ?? "",
    planned_end: formData.get("planned_end") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return formError(
      parsed.error.issues[0]?.message ?? "Check the programme dates and try again.",
    );
  }
  const input = parsed.data;
  if (input.planned_end < input.planned_start) {
    return formError("The planned end cannot be before the planned start.");
  }

  const milestones: MilestonePayload[] = [];
  for (let i = 1; i <= FORM_ROWS; i++) {
    const title = String(formData.get(`milestone_title_${i}`) ?? "").trim();
    if (!title) continue; // unused row
    if (title.length > 200) {
      return formError(`Milestone ${i}'s title is too long (200 characters max).`);
    }
    const end = String(formData.get(`milestone_end_${i}`) ?? "").trim();
    if (!DAY_KEY.test(end)) {
      return formError(`Milestone "${title}" needs a planned end date.`);
    }
    const start = String(formData.get(`milestone_start_${i}`) ?? "").trim();
    if (start && !DAY_KEY.test(start)) {
      return formError(`Milestone "${title}" has an unreadable start date.`);
    }
    const weightRaw = String(formData.get(`milestone_weight_${i}`) ?? "").trim();
    let weight: number | null = null;
    if (weightRaw) {
      const n = Number(weightRaw);
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        return formError(
          `Milestone "${title}"'s weight must be a number above 0 and at most 100.`,
        );
      }
      weight = n;
    }
    milestones.push({
      title,
      planned_start: start || null,
      planned_end: end,
      weight,
      customer_visible: formData.get(`milestone_visible_${i}`) === "on",
    });
  }
  if (milestones.length === 0) {
    return formError("A programme needs at least one milestone — add a title and a date.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;

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

  const { error } = await supabase.rpc("set_job_programme", {
    p_job_id: jobId,
    p_org_id: ctx.org.id,
    p_planned_start: input.planned_start,
    p_planned_end: input.planned_end,
    p_milestones: milestones,
    p_note: input.note ?? null,
  });

  if (error) {
    console.error("[job-programme] set failed", error);
    return formError(friendlyRpcError(error.message));
  }

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=programme#programme") });
}
