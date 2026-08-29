import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import type { VariationRequestStatus } from "@/lib/variation-requests/schema";

/**
 * Portal read-side for variation requests (G2, migration 20261221).
 *
 * SCOPING: variation_requests carries org_id + job_id, not customer_id — the
 * customer boundary is derived through THEIR jobs: we list the customer's own
 * jobs (org_id + customer_id pinned) and only then read requests `.in()` that
 * id set, org-pinned again. A request on another customer's job is therefore
 * unrepresentable in this query, not merely filtered.
 *
 * PROJECTION: the customer sees a COARSE stage word and their own submitted
 * text — never review_note (a staff decision trail), reviewer identity, or the
 * raw status vocabulary. Same posture as _future-work.ts: internal fields
 * cannot round-trip because the returned shape has no slot for them.
 */

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** Coarse, customer-safe stage word per internal status. */
export const PORTAL_CHANGE_STAGES = {
  requested: "received",
  reviewing: "in_review",
  accepted: "approved",
  rejected: "declined",
  converted: "quoted",
} as const satisfies Record<VariationRequestStatus, string>;

export type PortalChangeStage =
  (typeof PORTAL_CHANGE_STAGES)[VariationRequestStatus];

export const PORTAL_CHANGE_STAGE_LABELS: Record<PortalChangeStage, string> = {
  received: "Received",
  in_review: "Being reviewed",
  approved: "Approved — being priced",
  declined: "Declined",
  quoted: "Quote issued",
};

export type PortalChangeRequest = {
  id: string;
  title: string;
  stage: PortalChangeStage;
  submitted_on: string;
  job_label: string;
};

export type PortalJobOption = {
  id: string;
  label: string;
};

function jobLabel(j: {
  id: string;
  status: string;
  scheduled_date: string | null;
  created_at: string;
}): string {
  const when = j.scheduled_date
    ? `scheduled ${dateFmt.format(new Date(j.scheduled_date))}`
    : `started ${dateFmt.format(new Date(j.created_at))}`;
  return `Job ${when} (${j.status.replace("-", " ")})`;
}

type JobRow = {
  id: string;
  status: string;
  scheduled_date: string | null;
  created_at: string;
};

/**
 * The customer's jobs a change can be requested against (open work only) plus
 * their existing change requests — one loader so both stay on the same
 * customer-pinned job set.
 */
export async function loadPortalChangeRequests(
  customerId: string,
  orgId: string,
): Promise<{ jobs: PortalJobOption[]; requests: PortalChangeRequest[] }> {
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = admin as unknown as { from: (t: string) => any };

  // F-1: the COMPLETE job set (fetchAllRows) — this feeds a PICKER and the
  // request read-back's job-id batch, so a flat .limit would silently hide a
  // high-volume customer's older jobs from both. Stable order: created_at desc
  // + id as the unique tiebreaker (the portal jobs page idiom).
  const { data: jobRows, error: jobsError } = await fetchAllRows<JobRow>(
    (from, to) =>
      db
        .from("jobs")
        .select("id, status, scheduled_date, created_at")
        .eq("org_id", orgId)
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as PromiseLike<{
        data: JobRow[] | null;
        error: unknown;
      }>,
  );
  if (jobsError) {
    console.error("[portal/change-requests] jobs read failed", jobsError);
    return { jobs: [], requests: [] };
  }
  const allJobs = jobRows;
  const labelById = new Map(allJobs.map((j) => [j.id, jobLabel(j)]));

  // Changes are requested against OPEN work; completed/cancelled jobs are for
  // the "future work" form beside this one instead.
  const openJobs = allJobs.filter(
    (j) => j.status !== "completed" && j.status !== "cancelled",
  );

  if (allJobs.length === 0) return { jobs: [], requests: [] };

  const { data: reqRows, error: reqError } = await db
    .from("variation_requests")
    .select("id, title, status, created_at, job_id")
    .eq("org_id", orgId)
    .in("job_id", allJobs.map((j) => j.id))
    .eq("requester_type", "customer")
    .order("created_at", { ascending: false })
    .limit(50);
  if (reqError) {
    console.error("[portal/change-requests] requests read failed", reqError);
  }

  const requests: PortalChangeRequest[] = (
    (reqRows ?? []) as Array<{
      id: string;
      title: string;
      status: VariationRequestStatus;
      created_at: string;
      job_id: string;
    }>
  ).map((r) => ({
    id: r.id,
    title: r.title,
    stage: PORTAL_CHANGE_STAGES[r.status] ?? "received",
    submitted_on: dateFmt.format(new Date(r.created_at)),
    job_label: labelById.get(r.job_id) ?? "Job",
  }));

  return {
    jobs: openJobs.map((j) => ({ id: j.id, label: jobLabel(j) })),
    requests,
  };
}
