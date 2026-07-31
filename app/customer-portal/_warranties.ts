import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { buildPortalWarrantyView, type PortalWarrantyView } from "@/lib/warranties/portal";

/**
 * Customer-portal warranty reads (Phase 7).
 *
 * The portal runs on the RLS-bypassing admin client — the token is the entire
 * auth surface — so scoping is done IN CODE, twice, exactly as `_certificates.ts`
 * does it.
 *
 * SCOPING. `job_warranties` carries no `customer_id` ON PURPOSE. Certificates
 * denormalise one, which means a job later reassigned to a different customer
 * leaves a stale customer_id behind on the cert — a drift the portal would then
 * trust. So warranties are reached in two steps instead:
 *
 *   1. read the JOB IDS belonging to (org_id = customer.org_id,
 *      customer_id = customer.id);
 *   2. read warranties whose job_id is in that set AND whose org_id matches.
 *
 * The id set is derived from the customer on every request, so it cannot drift,
 * and an empty set short-circuits to an empty list rather than an unfiltered
 * `.in()`. No PostgREST embed is used — the join is explicit, per the loud-reads
 * house rule.
 *
 * PROJECTION. Rows are never returned raw. Every row goes through
 * `buildPortalWarrantyView`, which rebuilds a customer-safe shape field by
 * field, so a column added to `job_warranties` later cannot reach a customer by
 * default.
 *
 * VISIBILITY. Published, not withdrawn, not void. A voided warranty disappears
 * rather than being shown struck through: its `void_reason` is internal, and a
 * withdrawn promise is not a promise.
 *
 * The warranty's START DATE comes from the job's ISSUED completion certificate,
 * whether or not that certificate document is itself published to the portal.
 * The completion date is a TERM of the warranty the operator chose to publish,
 * not a second document — and it concerns the customer's own job. When no
 * certificate is issued the view says so in words (`awaiting_completion_certificate`).
 */

type WarrantyRow = {
  id: string;
  job_id: string;
  title: string;
  kind: string;
  cover: string;
  exclusions: string | null;
  provider: string | null;
  reference: string | null;
  period_months: number;
  service_interval_months: number | null;
  service_notes: string | null;
  status: string;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
  created_at: string;
};

const WARRANTY_COLS =
  "id, job_id, title, kind, cover, exclusions, provider, reference, period_months, " +
  "service_interval_months, service_notes, status, portal_published_at, portal_withdrawn_at, created_at";

type Res<T> = { data: T | null; error: SupabaseReadError | null };
type WarrantyChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      in: (k: string, v: unknown[]) => {
        order: (k: string, o: { ascending: boolean }) => PromiseLike<Res<WarrantyRow[]>>;
      };
    };
  };
};
type CertRow = { job_id: string | null; completion_date: string };
type CertChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        in: (k: string, v: unknown[]) => PromiseLike<Res<CertRow[]>>;
      };
    };
  };
};

export type PortalWarranty = PortalWarrantyView & {
  /** Short, non-identifying job handle — the same 8-char form certificates use. */
  job_reference: string;
};

export async function listPortalWarranties(
  customerId: string,
  orgId: string,
): Promise<PortalWarranty[]> {
  const admin = createAdminClient();

  // 1. The customer's own jobs — the only scope a warranty can be reached through.
  const { data: jobs, error: jobsError } = await admin
    .from("jobs")
    .select("id")
    .eq("org_id", orgId)
    .eq("customer_id", customerId);
  // Loud: a failed read here would render "no warranties" over real cover.
  if (jobsError) throw readFailure("portal warranties: jobs", jobsError);
  const jobIds = (jobs ?? []).map((j) => j.id);
  if (jobIds.length === 0) return [];

  // 2. Published, live warranties on exactly those jobs.
  const { data: rows, error: warrantyError } = await (
    admin.from("job_warranties" as never) as unknown as WarrantyChain
  )
    .select(WARRANTY_COLS)
    .eq("org_id", orgId)
    .in("job_id", jobIds)
    .order("created_at", { ascending: false });
  if (warrantyError) throw readFailure("portal warranties: warranties", warrantyError);

  const visible = (rows ?? []).filter(
    (w) => w.status === "active" && w.portal_published_at && !w.portal_withdrawn_at,
  );
  if (visible.length === 0) return [];

  // 3. The frozen completion date per job — the ONLY clock a warranty may run on.
  const { data: certs, error: certError } = await (
    admin.from("completion_certificates" as never) as unknown as CertChain
  )
    .select("job_id, completion_date")
    .eq("org_id", orgId)
    .eq("status", "issued")
    .in("job_id", [...new Set(visible.map((w) => w.job_id))]);
  if (certError) throw readFailure("portal warranties: certificates", certError);

  const completionByJob = new Map<string, string>();
  for (const c of certs ?? []) {
    if (c.job_id) completionByJob.set(c.job_id, c.completion_date);
  }

  return visible.map((w) => ({
    ...buildPortalWarrantyView({
      id: w.id,
      title: w.title,
      kind: w.kind,
      cover: w.cover,
      exclusions: w.exclusions,
      provider: w.provider,
      reference: w.reference,
      periodMonths: w.period_months,
      serviceIntervalMonths: w.service_interval_months,
      serviceNotes: w.service_notes,
      certificateCompletionDate: completionByJob.get(w.job_id) ?? null,
    }),
    job_reference: w.job_id.slice(0, 8),
  }));
}
