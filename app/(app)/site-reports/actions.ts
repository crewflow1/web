"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { gatherReportSources } from "@/server/services/site-report-sources";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  defaultSelection,
  materializeSnapshot,
} from "@/lib/site-reports/aggregate";
import {
  createSiteReportSchema,
  reportContentSchema,
  reportSourcesSchema,
  siteReportIdSchema,
  type ReportContent,
} from "@/lib/site-reports/schema";
import {
  assertTransition,
  isDeletable,
  isEditable,
  type SiteReportStatus,
} from "@/lib/site-reports/state";
import {
  filterVerifiedPhotoIds,
  parsePhotoSelection,
  type VerifiablePhotoAttachment,
} from "@/lib/site-reports/photo-selection";

/**
 * Site Reports lifecycle actions.
 *
 * `site_reports` is newer than the generated Supabase types, so queries are cast
 * through minimal precise shapes. Every write goes through the tenant (user-JWT)
 * client so RLS scopes it. Every status change validates the transition
 * server-side (assertTransition); the DB additionally freezes an issued report's
 * snapshot + content. Mutations are count-gated.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
};
type ReportRow = {
  id: string;
  status: string;
  job_id: string | null;
  customer_id: string | null;
  title: string;
  report_number: string | null;
  revision: number;
  period_start: string;
  period_end: string;
  content: ReportContent | null;
};
type SelectReportChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{ data: ReportRow | null; error: SupabaseReadError | null }>;
      };
    };
  };
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

function reports(tenant: unknown) {
  return tenant as { from: (n: string) => unknown };
}

async function getReport(
  tenant: unknown,
  orgId: string,
  id: string,
): Promise<ReportRow | null> {
  const { data, error } = await (
    reports(tenant).from("site_reports") as unknown as SelectReportChain
  )
    .select(
      "id, status, job_id, customer_id, title, report_number, revision, period_start, period_end, content",
    )
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  // Loud fail for all seven action callers: a failed read must not become the
  // "not_found" banner while the report actually exists.
  if (error) throw readFailure("site-reports: load", error);
  return data;
}

/**
 * Load the attachment rows a photo-id candidate set claims to be — on the
 * TENANT (user-JWT) client so RLS bounds it to the caller's orgs — pinned to
 * the ACTIVE org, to job attachments, and to THE report's own job in SQL. The
 * pure `filterVerifiedPhotoIds` re-checks job binding + image mime in code, so
 * a client-supplied id survives only if it is an image attachment of exactly
 * this job in exactly this org — the same double-pin the portal read side uses.
 */
async function loadVerifiablePhotoRows(
  tenant: unknown,
  orgId: string,
  jobId: string,
  ids: string[],
): Promise<VerifiablePhotoAttachment[]> {
  if (ids.length === 0) return [];
  const { data, error } = await (
    reports(tenant).from("tenant_attachments") as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => {
              in: (k: string, v: unknown[]) => Promise<{
                data: VerifiablePhotoAttachment[] | null;
                error: SupabaseReadError | null;
              }>;
            };
          };
        };
      };
    }
  )
    .select("id, target_id, mime_type")
    .eq("org_id", orgId)
    .eq("target_table", "jobs")
    .eq("target_id", jobId)
    .in("id", ids);
  // Loud fail: a failed verification read must never pass as "no valid photos".
  if (error) throw readFailure("site-reports: photo verify", error);
  return data ?? [];
}

async function nextReportNumber(tenant: unknown, orgId: string): Promise<string> {
  // Per-org sequential-ish number. Low volume + cosmetic; a race just yields a
  // duplicate label, never a data-integrity problem.
  const { count } = await (
    reports(tenant).from("site_reports") as unknown as {
      select: (
        c: string,
        o: { count: "exact"; head: true },
      ) => {
        eq: (k: string, v: unknown) => Promise<{ count: number | null }>;
      };
    }
  )
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  return `SR-${String((count ?? 0) + 1).padStart(4, "0")}`;
}

export async function createSiteReport(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createSiteReportSchema.safeParse({
    job_id: formData.get("job_id") ?? "",
    title: formData.get("title") ?? "",
    period_start: formData.get("period_start") ?? "",
    period_end: formData.get("period_end") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/site-reports/new?error=${encodeURIComponent(firstError)}`);
  }
  const data = parsed.success ? parsed.data : null;
  if (!data) redirect(`/site-reports/new?error=validation`);

  const tenant = await createClient();

  // Resolve the job's customer for portal scoping (RLS-scoped read).
  const { data: job, error: jobError } = await tenant
    .from("jobs")
    .select("id, customer_id")
    .eq("id", data.job_id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError) throw readFailure("site-reports: job resolve", jobError);
  if (!job) redirect(`/site-reports/new?error=bad_job`);

  // Seed the draft: aggregate the period's sources and propose them all.
  const sources = await gatherReportSources(
    data.job_id,
    data.period_start,
    data.period_end,
  );
  const content: ReportContent = { sources: defaultSelection(sources) };
  const reportNumber = await nextReportNumber(tenant, ctx.org.id);

  const id = randomUUID();
  const { error } = await (
    reports(tenant).from("site_reports") as unknown as InsertChain
  ).insert({
    id,
    org_id: ctx.org.id,
    job_id: data.job_id,
    customer_id: (job as { customer_id: string | null }).customer_id ?? null,
    report_number: reportNumber,
    title: data.title,
    period_start: data.period_start,
    period_end: data.period_end,
    status: "draft",
    revision: 1,
    content,
    prepared_by: user.id,
  });
  if (error) {
    console.error("[site-reports] insert failed", error);
    redirect(`/site-reports/new?error=record_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.created",
    targetTable: "site_reports",
    targetId: id,
    metadata: { job_id: data.job_id, period_start: data.period_start, period_end: data.period_end },
  });

  revalidatePath("/site-reports");
  redirect(`/site-reports/${id}?saved=created`);
}

export async function updateReportContent(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  if (!isEditable(report.status as SiteReportStatus)) {
    redirect(`/site-reports/${id}?error=not_editable`);
  }

  const parsed = reportContentSchema.safeParse({
    overall_status: formData.get("overall_status") ?? "",
    current_phase: formData.get("current_phase") ?? "",
    progress_percent: formData.get("progress_percent") ?? "",
    summary: formData.get("summary") ?? "",
    achievements: formData.get("achievements") ?? "",
    work_planned: formData.get("work_planned") ?? "",
    programme_notes: formData.get("programme_notes") ?? "",
    completion_forecast: formData.get("completion_forecast") ?? "",
    weather_notes: formData.get("weather_notes") ?? "",
    risks: formData.get("risks") ?? "",
    client_decisions: formData.get("client_decisions") ?? "",
    next_steps: formData.get("next_steps") ?? "",
  });
  if (!parsed.success) redirect(`/site-reports/${id}?error=validation`);

  // Merge the edited commentary over the existing content, PRESERVING the source
  // selection (edited through a separate control, not this form).
  const merged: ReportContent = {
    ...(report.content ?? {}),
    ...(parsed.success ? parsed.data : {}),
    sources: report.content?.sources,
  };

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update({ content: merged }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] content update failed", error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.section_updated",
    targetTable: "site_reports",
    targetId: id,
    metadata: {},
  });

  revalidatePath(`/site-reports/${id}`);
  redirect(`/site-reports/${id}?saved=content`);
}

/**
 * Update the report's PHOTO selection (Train 4 — the producer for the portal
 * photos tab). Draft/ready_for_review only, exactly like the commentary form —
 * an issued report's content is frozen by the DB trigger AND refused here, so
 * the photos a customer was shown can never change after issue.
 *
 * SECURITY: the checkbox values are client-supplied ids. Each one is
 * re-verified server-side — RLS-scoped read, pinned to the active org, to
 * target_table='jobs' and to THIS report's job, then image-mime re-checked in
 * code (filterVerifiedPhotoIds). Any id that fails REJECTS the whole
 * submission rather than silently saving a subset: a dropped id is either
 * tampering or a stale form, and both deserve a visible error, not a quiet
 * partial save.
 */
export async function updateReportPhotos(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  if (!isEditable(report.status as SiteReportStatus)) {
    redirect(`/site-reports/${id}?error=not_editable`);
  }
  if (!report.job_id) redirect(`/site-reports/${id}?error=no_job`);

  const candidates = parsePhotoSelection(
    formData.getAll("photo_ids").map((v) => String(v)),
  );
  if (candidates === null) {
    redirect(`/site-reports/${id}?error=photo_validation`);
  }

  const rows = await loadVerifiablePhotoRows(tenant, ctx.org.id, report.job_id, candidates);
  const verified = filterVerifiedPhotoIds(candidates, rows, report.job_id);
  if (verified.length !== candidates.length) {
    redirect(`/site-reports/${id}?error=photo_not_on_job`);
  }

  // Replace ONLY the photo selection; the diary/snag/toolbox curation is
  // edited elsewhere and must survive this write untouched.
  const existingSources = reportSourcesSchema.parse(report.content?.sources ?? {});
  const merged: ReportContent = {
    ...(report.content ?? {}),
    sources: { ...existingSources, photo_attachment_ids: verified },
  };

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update({ content: merged }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] photo update failed", error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.photos_updated",
    targetTable: "site_reports",
    targetId: id,
    metadata: { photo_count: verified.length },
  });

  revalidatePath(`/site-reports/${id}`);
  redirect(`/site-reports/${id}?saved=photos`);
}

// Shared transition runner for the simple status-only moves.
async function runTransition(
  id: string,
  to: SiteReportStatus,
  action: string,
  extraPatch: Record<string, unknown> = {},
  savedKey = "status",
): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);

  try {
    assertTransition(report.status as SiteReportStatus, to);
  } catch {
    redirect(`/site-reports/${id}?error=bad_transition`);
  }

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update({ status: to, ...extraPatch }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error(`[site-reports] ${action} failed`, error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action,
    targetTable: "site_reports",
    targetId: id,
    metadata: { to },
  });

  revalidatePath(`/site-reports/${id}`);
  revalidatePath("/site-reports");
  redirect(`/site-reports/${id}?saved=${savedKey}`);
}

export async function submitForReview(id: string): Promise<void> {
  await runTransition(id, "ready_for_review", "site_report.submitted");
}

export async function returnToDraft(id: string): Promise<void> {
  await runTransition(id, "draft", "site_report.returned_to_draft");
}

export async function approveReport(id: string): Promise<void> {
  const { user } = await requireOrgContext();
  await runTransition(id, "approved", "site_report.approved", {
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  });
}

export async function archiveReport(id: string): Promise<void> {
  await runTransition(id, "archived", "site_report.archived");
}

/**
 * Issue a report: validate approved→issued, then MATERIALISE the frozen snapshot
 * from the current content + freshly-resolved sources, and stamp issued_at. The
 * DB trigger makes the snapshot write-once and freezes content thereafter.
 */
export async function issueReport(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  try {
    assertTransition(report.status as SiteReportStatus, "issued");
  } catch {
    redirect(`/site-reports/${id}?error=bad_transition`);
  }
  if (!report.job_id) redirect(`/site-reports/${id}?error=no_job`);

  // Resolve display labels + re-fetch sources for a faithful, current freeze.
  const [{ data: job }, sources] = await Promise.all([
    tenant
      .from("jobs")
      .select("id, customer:customers ( name )")
      .eq("id", report.job_id)
      .maybeSingle(),
    gatherReportSources(report.job_id, report.period_start, report.period_end),
  ]);

  const content = report.content ?? {};
  const selection = reportSourcesSchema.parse(content.sources ?? {});

  // Re-verify the PHOTO selection at the moment of freeze, exactly like the
  // other sources are re-fetched above: each id must still be an image
  // attachment of THIS org and THIS job (RLS read + org/job pins + in-code
  // mime/job re-check). An attachment deleted or re-pointed since selection is
  // DROPPED from the freeze — the snapshot is what the customer will see, so
  // it may only ever claim photos that verifiably exist on the job right now.
  const photoRows = await loadVerifiablePhotoRows(
    tenant,
    ctx.org.id,
    report.job_id,
    selection.photo_attachment_ids,
  );
  const frozenSelection = {
    ...selection,
    photo_attachment_ids: filterVerifiedPhotoIds(
      selection.photo_attachment_ids,
      photoRows,
      report.job_id,
    ),
  };
  // The snapshot's content carries the VERIFIED selection — snapshot.content.
  // sources.photo_attachment_ids is precisely what the portal photos tab
  // trusts (app/customer-portal/_photos.ts), so nothing unverified may freeze.
  const contentForFreeze: ReportContent = { ...content, sources: frozenSelection };

  const snapshot = materializeSnapshot({
    title: report.title,
    reportNumber: report.report_number,
    revision: report.revision,
    periodStart: report.period_start,
    periodEnd: report.period_end,
    customerName: (job as { customer?: { name: string | null } | null } | null)?.customer?.name ?? null,
    jobLabel: (job as { customer?: { name: string | null } | null } | null)?.customer?.name ?? null,
    content: contentForFreeze,
    sources,
    selection: frozenSelection,
    issuedAt: new Date().toISOString(),
  });

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update(
      {
        status: "issued",
        snapshot,
        issued_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] issue failed", error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.issued",
    targetTable: "site_reports",
    targetId: id,
    metadata: { report_number: report.report_number, revision: report.revision },
  });

  revalidatePath(`/site-reports/${id}`);
  revalidatePath("/site-reports");
  redirect(`/site-reports/${id}?saved=issued`);
}

/**
 * Supersede an issued report: mark it superseded and create a fresh DRAFT
 * revision (revision+1) that points back at it. The old report's snapshot stays
 * frozen and viewable; edits happen on the new revision.
 */
export async function supersedeReport(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  try {
    assertTransition(report.status as SiteReportStatus, "superseded");
  } catch {
    redirect(`/site-reports/${id}?error=bad_transition`);
  }

  // Old → superseded.
  const { error: supErr, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update({ status: "superseded" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (supErr || !count) redirect(`/site-reports/${id}?error=update_failed`);

  // New draft revision.
  const newId = randomUUID();
  const { error: insErr } = await (
    reports(tenant).from("site_reports") as unknown as InsertChain
  ).insert({
    id: newId,
    org_id: ctx.org.id,
    job_id: report.job_id,
    customer_id: report.customer_id,
    report_number: report.report_number,
    title: report.title,
    period_start: report.period_start,
    period_end: report.period_end,
    status: "draft",
    revision: report.revision + 1,
    supersedes_id: id,
    content: report.content ?? {},
    prepared_by: user.id,
  });
  if (insErr) {
    console.error("[site-reports] supersede insert failed", insErr);
    redirect(`/site-reports/${id}?error=update_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.superseded",
    targetTable: "site_reports",
    targetId: id,
    metadata: { new_revision: report.revision + 1, new_id: newId },
  });

  revalidatePath("/site-reports");
  redirect(`/site-reports/${newId}?saved=superseded`);
}

export async function deleteSiteReport(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/site-reports?error=forbidden`);
  }

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  // Only a draft may be destroyed; issued reports are contractual evidence.
  if (!isDeletable(report.status as SiteReportStatus)) {
    redirect(`/site-reports/${id}?error=not_deletable`);
  }

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] delete failed", error);
    redirect(`/site-reports?error=delete_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.deleted",
    targetTable: "site_reports",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });

  revalidatePath("/site-reports");
  redirect(`/site-reports?saved=deleted`);
}

/**
 * Publish an issued report to the customer portal — a deliberate, separate step
 * from issuing. Owner/admin only (publishing exposes a report to a customer).
 * Touches ONLY publication columns, so the frozen snapshot/content are untouched
 * (the immutability trigger is not engaged). Clears any prior withdrawal.
 */
export async function publishToPortal(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/site-reports?error=forbidden`);
  }

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  // Only an ISSUED report may be published — never a draft/approved one.
  if (report.status !== "issued") {
    redirect(`/site-reports/${id}?error=not_issued`);
  }

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update(
      {
        portal_published_at: new Date().toISOString(),
        portal_published_by: user.id,
        portal_withdrawn_at: null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] publish failed", error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.portal_published",
    targetTable: "site_reports",
    targetId: id,
    metadata: { report_number: report.report_number },
  });

  revalidatePath(`/site-reports/${id}`);
  revalidatePath("/site-reports");
  redirect(`/site-reports/${id}?saved=published`);
}

/**
 * Withdraw a report from the customer portal — hides it without deleting the
 * report or its audit history. Owner/admin only.
 */
export async function withdrawFromPortal(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!siteReportIdSchema.safeParse(id).success) redirect(`/site-reports?error=bad_id`);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/site-reports?error=forbidden`);
  }

  const tenant = await createClient();
  const report = await getReport(tenant, ctx.org.id, id);
  if (!report) redirect(`/site-reports?error=not_found`);
  if (report.status !== "issued" && report.status !== "superseded") {
    redirect(`/site-reports/${id}?error=not_published`);
  }

  const { error, count } = await (
    reports(tenant).from("site_reports") as unknown as UpdateChain
  )
    .update({ portal_withdrawn_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[site-reports] withdraw failed", error);
    redirect(`/site-reports/${id}?error=update_failed`);
  }
  if (!count) redirect(`/site-reports?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_report.portal_withdrawn",
    targetTable: "site_reports",
    targetId: id,
    metadata: { report_number: report.report_number },
  });

  revalidatePath(`/site-reports/${id}`);
  revalidatePath("/site-reports");
  redirect(`/site-reports/${id}?saved=withdrawn`);
}
