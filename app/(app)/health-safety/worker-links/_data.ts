import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Reads for the worker-links staff surface. Tenant client → RLS scopes to the
 * caller's orgs; every read is additionally pinned to the ACTIVE org id so the
 * list reflects the company the operator is working in, never a blend.
 *
 * F-1: every set-read here PAGES the complete set via fetchAllRows on a stable
 * order — a bare .select() (or a .limit) would be silently clamped at PostgREST
 * max_rows and could drop a link (or a picker option) past the cap.
 */

export type WorkerLinkRow = {
  id: string;
  jobId: string;
  jobLabel: string;
  workerName: string;
  workerCompany: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  signedCount: number;
  state: "live" | "revoked" | "expired";
};

export type JobOption = { id: string; label: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FromChain = { from: (t: string) => any };
type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

type TokenRow = {
  id: string;
  job_id: string;
  worker_name: string;
  worker_company: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  job: { status: string; scheduled_date: string | null; customer: { name: string | null } | null } | null;
};

export async function listWorkerLinks(orgId: string): Promise<WorkerLinkRow[]> {
  const supabase = (await createClient()) as unknown as FromChain;

  const { data, error } = await fetchAllRows<TokenRow>((from, to) =>
    supabase
      .from("worker_signoff_tokens")
      .select("id, job_id, worker_name, worker_company, expires_at, revoked_at, last_used_at, created_at, job:jobs ( id, status, scheduled_date, customer:customers ( name ) )")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as Page<TokenRow>,
  );
  if (error) throw readFailure("worker-links: list", error);
  const rows = data ?? [];

  // Signed-count per link, in ONE paged read (never per-row).
  const ids = rows.map((r) => r.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: acks, error: ackErr } = await fetchAllRows<{ token_id: string }>((from, to) =>
      supabase
        .from("worker_acknowledgements")
        .select("id, token_id")
        .eq("org_id", orgId)
        .in("token_id", ids)
        .order("id", { ascending: true })
        .range(from, to) as Page<{ token_id: string }>,
    );
    if (ackErr) throw readFailure("worker-links: signed counts", ackErr);
    for (const a of acks ?? []) counts.set(a.token_id, (counts.get(a.token_id) ?? 0) + 1);
  }

  const now = Date.now();
  return rows.map((r) => {
    const state: WorkerLinkRow["state"] = r.revoked_at
      ? "revoked"
      : Date.parse(r.expires_at) <= now
        ? "expired"
        : "live";
    return {
      id: r.id,
      jobId: r.job_id,
      jobLabel: r.job?.customer?.name ?? "Job",
      workerName: r.worker_name,
      workerCompany: r.worker_company,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      signedCount: counts.get(r.id) ?? 0,
      state,
    };
  });
}

type JobRow = { id: string; scheduled_date: string | null; created_at: string; customer: { name: string | null } | null };

/** Jobs available to scope a link to — active, non-completed work in this org.
 *  PAGED (F-1 picker-completion): a preset/saved job must never be dropped past
 *  a cap, so the full set is paged on a stable (created_at desc, id desc) order. */
export async function listJobOptions(orgId: string): Promise<JobOption[]> {
  const supabase = (await createClient()) as unknown as FromChain;
  const { data, error } = await fetchAllRows<JobRow>((from, to) =>
    supabase
      .from("jobs")
      .select("id, scheduled_date, created_at, customer:customers ( name )")
      .eq("org_id", orgId)
      .in("status", ["new", "in-progress", "blocked"])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as Page<JobRow>,
  );
  if (error) throw readFailure("worker-links: job options", error);
  return (data ?? []).map((j) => ({
    id: j.id,
    label: `${j.customer?.name ?? "Job"}${j.scheduled_date ? ` · ${j.scheduled_date}` : ""}`,
  }));
}
