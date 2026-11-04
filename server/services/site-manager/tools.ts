import "server-only";
import { createClient } from "@/lib/supabase/server";
import { loadJobForOrg } from "@/lib/jobs/load";
import { loadJobDiaryPanel, loadJobSnagsPanel } from "@/server/services/job-site-hub";
import { loadJobMaterialsPanel } from "@/server/services/material-requests";
import { canSeeCommercial } from "@/server/auth/financial-visibility";
import { formatDayKeyUK } from "@/lib/time/format";
import type { AiSource } from "@/lib/ai/safety";

/**
 * AI Site Manager — the READ tool layer.
 *
 * Each tool wraps an EXISTING user-JWT (`createClient()`) reader, so Postgres
 * RLS (`current_org_ids()` + `my_assigned_job_ids()`) fail-closes org + assignment
 * scope before any row leaves the DB — a staff caller physically cannot read an
 * unassigned job. On top of RLS, `get_job_financials` adds the role gate (owner/
 * admin only). No tool takes an org id (it comes from the caller's context), none
 * uses the service-role client, and each returns a compact projection + sources
 * (never raw rows / secrets). Tool SELECTION is done server-side (not by the
 * model), so adversarial text in retrieved notes can never pick a tool or widen
 * scope — the gate, not the prompt, decides access.
 */

export type SiteManagerCtx = {
  org: { id: string };
  membership: { role: string };
};

export type ToolResult = {
  /** Compact, model-safe facts (no secrets). Rendered into the transcript as untrusted DATA. */
  facts: Record<string, unknown>;
  /** Deep-link sources for the answer. */
  sources: AiSource[];
  /** True when a gate denied the data (financial). */
  unauthorised?: boolean;
};

const jobHref = (jobId: string, tab?: string) => `/jobs/${jobId}${tab ? `?tab=${tab}` : ""}`;

/** List the caller's jobs (RLS → assigned jobs for staff, all for admins). */
export async function toolListMyJobs(
  ctx: SiteManagerCtx,
  args: { status?: string; limit?: number } = {},
): Promise<ToolResult> {
  const supabase = await createClient();
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (supabase as any)
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.status) q = q.eq("status", args.status);
  const { data } = await q;
  const jobs = (data ?? []) as Array<{ id: string; status: string; scheduled_date: string | null; customer: { name: string | null } | null }>;
  return {
    facts: {
      count: jobs.length,
      jobs: jobs.map((j) => ({ id: j.id, status: j.status, scheduled_date: j.scheduled_date, customer: j.customer?.name ?? null })),
    },
    sources: [{ label: `Your jobs (${jobs.length})`, href: "/jobs" }],
  };
}

/** Job overview — status/schedule/site/customer only (NO commercial fields). */
export async function toolJobOverview(ctx: SiteManagerCtx, jobId: string): Promise<ToolResult> {
  const supabase = await createClient();
  const job = await loadJobForOrg(
    supabase as never,
    jobId,
    ctx.org.id,
    "id, status, scheduled_date, end_date, site_address_line1, site_city, site_postcode, customer:customers ( name )",
  ).catch(() => null);
  if (!job) return { facts: { found: false }, sources: [] };
  const j = job as unknown as {
    id: string; status: string; scheduled_date: string | null; end_date: string | null;
    site_address_line1: string | null; site_city: string | null; site_postcode: string | null;
    customer: { name: string | null } | null;
  };
  return {
    facts: {
      found: true,
      status: j.status,
      scheduled_date: j.scheduled_date,
      end_date: j.end_date,
      site: [j.site_address_line1, j.site_city, j.site_postcode].filter(Boolean).join(", ") || null,
      customer: j.customer?.name ?? null,
    },
    sources: [{ label: "Job overview", href: jobHref(jobId) }],
  };
}

export async function toolSiteDiary(ctx: SiteManagerCtx, jobId: string): Promise<ToolResult> {
  const d = await loadJobDiaryPanel(ctx.org.id, jobId);
  return {
    facts: { totalEntries: d.total, lastEntryDate: d.lastEntryDate, withDelays: d.withDelays, recent: d.recent?.slice(0, 5) ?? [] },
    sources: [{ label: "Site diary", href: jobHref(jobId, "diary") }],
  };
}

export async function toolSnags(ctx: SiteManagerCtx, jobId: string): Promise<ToolResult> {
  const s = await loadJobSnagsPanel(ctx.org.id, jobId, formatDayKeyUK(new Date()));
  return {
    facts: { total: s.total, open: s.open, overdue: s.overdue, open_snags: (s.openSnags ?? []).slice(0, 8) },
    sources: [{ label: "Snags", href: jobHref(jobId, "snags") }],
  };
}

export async function toolMaterials(ctx: SiteManagerCtx, jobId: string): Promise<ToolResult> {
  const m = await loadJobMaterialsPanel(ctx.org.id, jobId, formatDayKeyUK(new Date()));
  const commercial = canSeeCommercial(ctx);
  // Strip any cost/total fields for non-privileged callers (defence in depth;
  // the panel is quantity-centric but never let unit costs reach the prompt).
  const items = (m.items ?? []).slice(0, 10).map((it) => {
    const row = it as Record<string, unknown>;
    if (commercial) return { description: row.description, quantity: row.quantity, status: row.status, unit_cost: row.unit_cost, total: row.total };
    return { description: row.description, quantity: row.quantity, status: row.status };
  });
  return {
    facts: { total: m.total, open: m.open, awaitingApproval: m.awaitingApproval, overdue: m.overdue, items },
    sources: [{ label: "Materials", href: jobHref(jobId, "materials") }],
  };
}

/**
 * Financial tool — the role gate. Staff / non-`reports:view` get
 * `{ unauthorised:true }` and NEVER a number. Owner/admin get a pointer to the
 * Commercial tab (the deterministic lane does not fabricate aggregates; when the
 * model tier is armed it may summarise the Commercial-tab data the owner can
 * already see). The security-critical guarantee is the denial for non-privileged
 * callers, enforced here regardless of what the question asks.
 */
export async function toolJobFinancials(ctx: SiteManagerCtx, jobId: string): Promise<ToolResult> {
  if (!canSeeCommercial(ctx)) {
    return { facts: { authorised: false }, sources: [], unauthorised: true };
  }
  return {
    facts: {
      authorised: true,
      note: "Commercial figures (budget, valuations, retention, profit) are on the job's Commercial tab.",
    },
    sources: [{ label: "Commercial", href: jobHref(jobId, "commercial") }],
  };
}
