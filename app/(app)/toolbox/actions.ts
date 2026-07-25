"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import { canIssue, canTransition } from "@/lib/health-safety/toolbox-talks";
import { effectiveStatus, type PermitStatus } from "@/lib/health-safety/permits";
import { buildToolboxTalkSnapshot } from "@/lib/toolbox-talks/snapshot";
import {
  createToolboxTalkSchema,
  updateToolboxTalkSchema,
  toolboxTalkIdSchema,
} from "@/lib/toolbox-talks/schema";

/**
 * Toolbox Talks server actions. A talk is born a DRAFT, edited freely, then
 * DELIVERED (issued) — at which point it becomes frozen, referenced H&S evidence.
 *
 * Every write runs on the tenant (user-JWT) client so RLS scopes it to the org;
 * the service-role client is never used here. The DB is the authority for the
 * hard invariants (born-draft, immutable-on-issue, same-org links, one-current
 * revision, delete-guard) — these actions validate shape, gate the issue with
 * canIssue, and surface DB refusals honestly (a count-0 write means "not found /
 * not permitted / not a draft", never a false success). `toolbox_talks`
 * post-dates the generated types, so `.from` is cast through a precise shape.
 */

type FromChain = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
// Bind `this` to the client — `.from` is a prototype method (see rams actions).
const tbl = (c: unknown) => (c as FromChain).from.bind(c);

type Rpc = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: string | null; error: { message: string } | null }>;
};

function firstFieldError(issues: Record<string, string[] | undefined>): string {
  return Object.values(issues).flat()[0] ?? "validation";
}

// ---------------------------------------------------------------------------
// Create — always a draft (the DB born-draft trigger backstops this).
// ---------------------------------------------------------------------------
export async function createToolboxTalk(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createToolboxTalkSchema.safeParse({
    talk_date: formData.get("talk_date") ?? "",
    topic: formData.get("topic") ?? "",
    key_points: formData.get("key_points") ?? "",
    location: formData.get("location") ?? "",
    job_id: formData.get("job_id") ?? "",
    risk_assessment_id: formData.get("risk_assessment_id") ?? "",
    permit_to_work_id: formData.get("permit_to_work_id") ?? "",
    presenter: formData.get("presenter") ?? "",
    ppe: formData.get("ppe") ?? "",
    attendees: formData.get("attendees") ?? "",
    attendee_count: formData.get("attendee_count") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const first = firstFieldError(parsed.error.flatten().fieldErrors);
    redirect(`/toolbox/new?error=${encodeURIComponent(first)}`);
  }
  const data = parsed.data;

  const id = randomUUID();
  const supabase = await createClient();
  const { error } = await tbl(supabase)("toolbox_talks").insert({
    id,
    org_id: ctx.org.id,
    // status omitted — defaults to 'draft'; a born-issued INSERT is DB-rejected.
    talk_date: data.talk_date,
    topic: data.topic,
    key_points: data.key_points ?? null,
    location: data.location ?? null,
    job_id: data.job_id ?? null,
    risk_assessment_id: data.risk_assessment_id ?? null,
    permit_to_work_id: data.permit_to_work_id ?? null,
    presenter: data.presenter ?? null,
    ppe: data.ppe,
    attendees: data.attendees ?? null,
    attendee_count: data.attendee_count ?? null,
    notes: data.notes ?? null,
    created_by: user.id,
  });
  if (error) {
    console.error("[toolbox] insert failed", error);
    redirect(`/toolbox/new?error=${encodeURIComponent(error.message)}`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.created",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { topic: data.topic, talk_date: data.talk_date, job_id: data.job_id ?? null },
  }).catch(() => {});

  revalidatePath("/toolbox");
  redirect(`/toolbox/${id}?saved=created`);
}

// ---------------------------------------------------------------------------
// Update — draft only. The DB immutable trigger blocks any edit once issued;
// the .eq("status","draft") guard + count check make that an honest 404.
// ---------------------------------------------------------------------------
export async function updateToolboxTalk(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = updateToolboxTalkSchema.safeParse({
    id: formData.get("id") ?? "",
    talk_date: formData.get("talk_date") ?? "",
    topic: formData.get("topic") ?? "",
    key_points: formData.get("key_points") ?? "",
    location: formData.get("location") ?? "",
    job_id: formData.get("job_id") ?? "",
    risk_assessment_id: formData.get("risk_assessment_id") ?? "",
    permit_to_work_id: formData.get("permit_to_work_id") ?? "",
    presenter: formData.get("presenter") ?? "",
    ppe: formData.get("ppe") ?? "",
    attendees: formData.get("attendees") ?? "",
    attendee_count: formData.get("attendee_count") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) redirect(`/toolbox?error=validation`);
  const { id, ...data } = parsed.data;

  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("toolbox_talks")
    .update(
      {
        talk_date: data.talk_date,
        topic: data.topic,
        key_points: data.key_points ?? null,
        location: data.location ?? null,
        job_id: data.job_id ?? null,
        risk_assessment_id: data.risk_assessment_id ?? null,
        permit_to_work_id: data.permit_to_work_id ?? null,
        presenter: data.presenter ?? null,
        ppe: data.ppe,
        attendees: data.attendees ?? null,
        attendee_count: data.attendee_count ?? null,
        notes: data.notes ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) redirect(`/toolbox/${id}/edit?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/toolbox/${id}?error=not_editable`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.updated",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { topic: data.topic },
  }).catch(() => {});

  revalidatePath(`/toolbox/${id}`);
  redirect(`/toolbox/${id}?saved=updated`);
}

// ---------------------------------------------------------------------------
// Issue ("deliver") — gate readiness, allocate the per-org TBT-NNNN, FREEZE the
// worker-safe evidence snapshot, and flip draft->issued atomically-guarded.
// ---------------------------------------------------------------------------
export async function issueToolboxTalk(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!toolboxTalkIdSchema.safeParse(formData.get("id")).success) redirect(`/toolbox?error=bad_id`);
  const id = String(formData.get("id"));
  const supabase = await createClient();

  // Load current state (RLS-scoped) + linked docs for the frozen snapshot.
  const { data: talk } = await tbl(supabase)("toolbox_talks")
    .select(
      "id, status, reference, revision_number, talk_date, topic, key_points, location, ppe, presenter, job_id, risk_assessment_id, permit_to_work_id",
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!talk) redirect(`/toolbox?error=not_found`);

  const gate = canIssue({ status: talk.status, topic: talk.topic, key_points: talk.key_points });
  if (!gate.ok) redirect(`/toolbox/${id}?error=${encodeURIComponent(gate.reasons[0]!)}`);

  // Allocate the per-org reference; unique (org_id, reference) backstops races.
  const { data: reference, error: numErr } = await (supabase as unknown as Rpc).rpc("next_tbt_number", {
    target_org: ctx.org.id,
  });
  if (numErr || !reference) redirect(`/toolbox/${id}?error=numbering_failed`);

  // Denormalise the linked documents + names to point-in-time strings.
  const now = new Date();
  const [siteLabel, deliveredName, issuerName, rams, permit] = await Promise.all([
    resolveSiteLabel(supabase, talk.job_id),
    Promise.resolve(talk.presenter as string | null),
    resolveUserName(supabase, user.id),
    resolveRams(supabase, talk.risk_assessment_id),
    resolvePermit(supabase, talk.permit_to_work_id, now),
  ]);

  const snapshot = buildToolboxTalkSnapshot({
    talkReference: reference,
    revision: talk.revision_number ?? 1,
    talkDate: talk.talk_date,
    location: talk.location,
    siteLabel,
    deliveredBy: deliveredName ?? issuerName ?? "Site team",
    topic: talk.topic,
    keyPoints: talk.key_points,
    ppe: talk.ppe ?? [],
    ramsReference: rams?.reference ?? null,
    ramsRevision: rams?.revision ?? null,
    permitReference: permit?.reference ?? null,
    permitStatusAtIssue: permit?.status ?? null,
    externalAttendees: [], // Tier-B external attendee capture lands in M2
    issuedByName: issuerName,
    issuedOn: now.toISOString().slice(0, 10),
  });

  const { error, count } = await tbl(supabase)("toolbox_talks")
    .update(
      {
        status: "issued",
        reference,
        issued_at: now.toISOString(),
        issued_by: user.id,
        snapshot,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) redirect(`/toolbox/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/toolbox/${id}?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.issued",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { reference },
  }).catch(() => {});

  revalidatePath(`/toolbox/${id}`);
  redirect(`/toolbox/${id}?saved=issued`);
}

// ---------------------------------------------------------------------------
// Terminal transitions — supersede / withdraw an issued talk.
// ---------------------------------------------------------------------------
async function transition(formData: FormData, to: "superseded" | "withdrawn"): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!toolboxTalkIdSchema.safeParse(formData.get("id")).success) redirect(`/toolbox?error=bad_id`);
  const id = String(formData.get("id"));
  if (!canTransition("issued", to)) redirect(`/toolbox/${id}?error=bad_transition`);

  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("toolbox_talks")
    .update({ status: to }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "issued");
  if (error) redirect(`/toolbox/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/toolbox/${id}?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `toolbox_talk.${to}`,
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  }).catch(() => {});

  revalidatePath(`/toolbox/${id}`);
  redirect(`/toolbox/${id}?saved=${to}`);
}
export async function withdrawToolboxTalk(formData: FormData): Promise<void> {
  await transition(formData, "withdrawn");
}

// ---------------------------------------------------------------------------
// Delete — draft only (admin). The DB delete-guard blocks any issued evidence
// regardless of role; here we also clean up the draft's attachments first.
// ---------------------------------------------------------------------------
export async function deleteToolboxTalk(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!toolboxTalkIdSchema.safeParse(id).success) redirect(`/toolbox?error=bad_id`);
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/toolbox?error=forbidden`);
  }

  const supabase = await createClient();

  const { data: atts } = await tbl(supabase)("tenant_attachments")
    .select("id")
    .eq("target_table", "toolbox_talks")
    .eq("target_id", id)
    .eq("org_id", ctx.org.id);
  for (const a of (atts ?? []) as { id: string }[]) {
    await deleteTenantAttachment(a.id).catch(() => undefined);
  }

  const { error, count } = await tbl(supabase)("toolbox_talks")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[toolbox] delete failed", error);
    redirect(`/toolbox/${id}?error=delete_failed`);
  }
  if (!count) redirect(`/toolbox/${id}?error=not_deletable`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.deleted",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  }).catch(() => {});

  revalidatePath("/toolbox");
  redirect(`/toolbox?saved=deleted`);
}

// ---------------------------------------------------------------------------
// Snapshot denormalisation helpers — each returns point-in-time STRINGS (RLS
// keeps them intra-org). Failures degrade to null, never block the issue.
// ---------------------------------------------------------------------------
async function resolveSiteLabel(supabase: unknown, jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  const { data } = await tbl(supabase)("jobs")
    .select("id, site_address_line1, site_city, customer:customers ( name )")
    .eq("id", jobId)
    .maybeSingle();
  const j = data as
    | { site_address_line1?: string | null; site_city?: string | null; customer?: { name?: string | null } | null }
    | null;
  if (!j) return null;
  const parts = [j.site_address_line1, j.site_city].filter((s): s is string => !!s && s.trim().length > 0);
  if (parts.length) return parts.join(", ");
  return j.customer?.name ?? null;
}

async function resolveUserName(supabase: unknown, userId: string): Promise<string | null> {
  const { data } = await tbl(supabase)("users")
    .select("id, full_name, email")
    .eq("id", userId)
    .maybeSingle();
  const u = data as { full_name?: string | null; email?: string | null } | null;
  return u?.full_name ?? u?.email ?? null;
}

async function resolveRams(
  supabase: unknown,
  raId: string | null,
): Promise<{ reference: string | null; revision: number | null } | null> {
  if (!raId) return null;
  const { data } = await tbl(supabase)("risk_assessments")
    .select("id, reference, revision_number")
    .eq("id", raId)
    .maybeSingle();
  const r = data as { reference?: string | null; revision_number?: number | null } | null;
  if (!r) return null;
  return { reference: r.reference ?? null, revision: r.revision_number ?? null };
}

async function resolvePermit(
  supabase: unknown,
  permitId: string | null,
  now: Date,
): Promise<{ reference: string | null; status: string } | null> {
  if (!permitId) return null;
  const { data } = await tbl(supabase)("permits_to_work")
    .select("id, reference, status, valid_from, valid_until")
    .eq("id", permitId)
    .maybeSingle();
  const p = data as
    | { reference?: string | null; status?: string | null; valid_from?: string | null; valid_until?: string | null }
    | null;
  if (!p) return null;
  const status = effectiveStatus(
    (p.status ?? "draft") as PermitStatus,
    p.valid_until ?? null,
    now,
    p.valid_from ?? null,
  );
  return { reference: p.reference ?? null, status };
}
