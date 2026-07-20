"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  assertTransition,
  createInspectionSchema,
  issueInspectionSchema,
  materializeInspectionSnapshot,
  type InspectionKind,
  type InspectionStatus,
} from "@/lib/assets/inspection";
import {
  canStartInspection,
  deriveOutcome,
  materializeTemplateSnapshot,
  missingFailComments,
  missingRequired,
  templateDefinitionSchema,
  type Answers,
  type CheckLevel,
  type TemplateSnapshot,
  type TemplateStatus,
} from "@/lib/assets/inspection-template";

/**
 * Asset inspection actions (M4a). Create writes a DRAFT; issue MATERIALISES the
 * frozen snapshot + outcome in a single row write (the DB immutability trigger
 * then makes it write-once, and rejects an issued row with no outcome/snapshot);
 * archive is a count-gated terminal transition. All go through the tenant
 * (user-JWT) client so RLS scopes every read and write.
 */

type InsertChain = {
  insert: (row: unknown) => {
    select: (c: string) => {
      single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  };
};

type LoadChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => { maybeSingle: () => Promise<{ data: InspectionRow | null }> };
    };
  };
};

type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ error: { message: string } | null; count: number | null }>;
      };
    };
  };
};

type InspectionRow = {
  id: string;
  asset_id: string;
  status: InspectionStatus;
  title: string;
  kind: InspectionKind | null;
  safety_critical: boolean;
  content: Record<string, unknown> | null;
  assets: { id: string; name: string; asset_ref: string | null } | null;
};

export async function createInspection(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createInspectionSchema.safeParse({
    asset_id: formData.get("asset_id"),
    title: formData.get("title"),
    kind: formData.get("kind"),
    safety_critical: formData.get("safety_critical") ?? false,
    notes: formData.get("notes"),
    due_at: formData.get("due_at"),
  });
  if (!parsed.success) {
    const assetId = String(formData.get("asset_id") ?? "");
    redirect(`/assets/${assetId}?error=inspection_invalid`);
  }
  const input = parsed.data;

  const tenant = await createClient();
  const { data, error } = await (tenant.from("asset_inspections" as never) as unknown as InsertChain)
    .insert({
      org_id: ctx.org.id,
      asset_id: input.asset_id,
      title: input.title,
      kind: input.kind ?? null,
      safety_critical: input.safety_critical,
      status: "draft",
      content: input.notes ? { notes: input.notes } : {},
      due_at: input.due_at ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-inspection] create failed", error);
    redirect(`/assets/${input.asset_id}?error=inspection_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_created",
    targetTable: "asset_inspections",
    targetId: data.id,
    metadata: { asset_id: input.asset_id, safety_critical: input.safety_critical },
  });

  revalidatePath(`/assets/${input.asset_id}`);
  redirect(`/assets/${input.asset_id}?saved=inspection`);
}

export async function issueInspection(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const inspectionId = String(formData.get("inspection_id") ?? "");

  const parsed = issueInspectionSchema.safeParse({
    outcome: formData.get("outcome"),
    inspected_at: formData.get("inspected_at"),
    notes: formData.get("notes"),
  });

  const tenant = await createClient();

  // Load the draft + its asset (RLS-scoped). notFound-equivalent → back to assets.
  const { data: insp } = await (tenant.from("asset_inspections" as never) as unknown as LoadChain)
    .select("id, asset_id, status, title, kind, safety_critical, content, assets(id, name, asset_ref)")
    .eq("id", inspectionId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!insp) redirect(`/assets?error=inspection_missing`);
  if (!parsed.success) redirect(`/assets/${insp.asset_id}?error=inspection_outcome`);

  // App-layer state machine (the DB immutability trigger is the hard gate).
  try {
    assertTransition(insp.status, "issued");
  } catch {
    redirect(`/assets/${insp.asset_id}?error=inspection_not_draft`);
  }

  const issuedAt = new Date().toISOString();
  const inspectedAt = parsed.data.inspected_at ?? issuedAt;
  const content = {
    ...(insp.content ?? {}),
    ...(parsed.data.notes ? { issue_notes: parsed.data.notes } : {}),
  };
  const snapshot = materializeInspectionSnapshot({
    title: insp.title,
    kind: insp.kind,
    safety_critical: insp.safety_critical,
    outcome: parsed.data.outcome,
    content,
    asset: insp.assets ?? { id: insp.asset_id, name: "", asset_ref: null },
    inspected_at: inspectedAt,
    issuedAt,
  });

  // Atomic: status + outcome + snapshot + content + inspected_at in one write.
  const { error, count } = await (tenant.from("asset_inspections" as never) as unknown as UpdateChain)
    .update(
      {
        status: "issued",
        outcome: parsed.data.outcome,
        snapshot,
        content,
        inspected_at: inspectedAt,
        inspected_by: user.id,
      },
      { count: "exact" },
    )
    .eq("id", inspectionId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[asset-inspection] issue failed", error);
    redirect(`/assets/${insp.asset_id}?error=inspection_failed`);
  }
  if (!count) redirect(`/assets/${insp.asset_id}?error=inspection_not_draft`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_issued",
    targetTable: "asset_inspections",
    targetId: inspectionId,
    metadata: { asset_id: insp.asset_id, outcome: parsed.data.outcome, safety_critical: insp.safety_critical },
  });

  revalidatePath(`/assets/${insp.asset_id}`);
  redirect(`/assets/${insp.asset_id}?saved=inspection_issued`);
}

export async function archiveInspection(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const inspectionId = String(formData.get("inspection_id") ?? "");
  const assetId = String(formData.get("asset_id") ?? "");

  const tenant = await createClient();
  // M4a archive = discard an unfinished DRAFT (the status='draft' filter makes a
  // repeat a no-op and refuses to hide an ISSUED compliance record — archiving
  // issued inspections is a permissioned M4c concern, not a silent action here).
  const { error, count } = await (tenant.from("asset_inspections" as never) as unknown as UpdateChain)
    .update({ status: "archived" }, { count: "exact" })
    .eq("id", inspectionId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[asset-inspection] archive failed", error);
    redirect(`/assets/${assetId}?error=inspection_failed`);
  }
  if (!count) redirect(`/assets/${assetId}?error=inspection_locked`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_archived",
    targetTable: "asset_inspections",
    targetId: inspectionId,
    metadata: { asset_id: assetId },
  });

  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=inspection_archived`);
}

// ── Templated inspections (M4b) ───────────────────────────────────────────────

type TemplatePickRow = {
  id: string;
  family_id: string;
  version: number;
  name: string;
  check_level: CheckLevel;
  status: TemplateStatus;
  definition: unknown;
};

type TemplatedInspectionRow = {
  id: string;
  asset_id: string;
  status: InspectionStatus;
  title: string;
  kind: InspectionKind | null;
  content: Record<string, unknown> | null;
  template_snapshot: TemplateSnapshot | null;
  schedule_id: string | null;
  assets: { id: string; name: string; asset_ref: string | null } | null;
};

/** Extract `answer.<key>` / `comment.<key>` fields from the run form. */
function parseRunForm(formData: FormData): { answers: Answers; comments: Record<string, string> } {
  const answers: Answers = {};
  const comments: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v !== "string") continue;
    if (k.startsWith("answer.")) answers[k.slice("answer.".length)] = v;
    else if (k.startsWith("comment.")) comments[k.slice("comment.".length)] = v;
  }
  return { answers, comments };
}

export async function startInspectionFromTemplate(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const templateId = String(formData.get("template_id") ?? "");
  if (!assetId || !templateId) redirect(`/assets/${assetId}?error=inspection_invalid`);

  const tenant = await createClient();
  const { data: template } = await (
    tenant.from("asset_inspection_templates" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: TemplatePickRow | null }> };
        };
      };
    }
  )
    .select("id, family_id, version, name, check_level, status, definition")
    .eq("id", templateId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!template) redirect(`/assets/${assetId}?error=template_missing`);
  // Only the LIVE version may seed new inspections (archived/superseded never).
  if (!canStartInspection(template.status)) redirect(`/assets/${assetId}?error=template_not_published`);
  const def = templateDefinitionSchema.safeParse(template.definition);
  if (!def.success) redirect(`/assets/${assetId}?error=template_failed`);

  const snapshot = materializeTemplateSnapshot({
    id: template.id,
    family_id: template.family_id,
    version: template.version,
    name: template.name,
    check_level: template.check_level,
    definition: def.data,
  });

  const { data, error } = await (tenant.from("asset_inspections" as never) as unknown as InsertChain)
    .insert({
      org_id: ctx.org.id,
      asset_id: assetId,
      title: template.name,
      status: "draft",
      // Derived at issue from the answers; false until then.
      safety_critical: false,
      content: {},
      template_id: template.id,
      template_version: template.version,
      template_snapshot: snapshot, // write-once at the DB from this moment
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-inspection] start from template failed", error);
    redirect(`/assets/${assetId}?error=inspection_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_started_from_template",
    targetTable: "asset_inspections",
    targetId: data.id,
    metadata: { asset_id: assetId, template_id: template.id, template_version: template.version },
  });

  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}/inspections/${data.id}`);
}

async function loadTemplatedInspection(orgId: string, inspectionId: string) {
  const tenant = await createClient();
  const { data } = await (tenant.from("asset_inspections" as never) as unknown as {
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: TemplatedInspectionRow | null }> };
      };
    };
  })
    .select("id, asset_id, status, title, kind, content, template_snapshot, schedule_id, assets(id, name, asset_ref)")
    .eq("id", inspectionId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

/** Save partial progress on a draft templated inspection (field-interruption recovery). */
export async function saveInspectionAnswers(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const inspectionId = String(formData.get("inspection_id") ?? "");
  const insp = await loadTemplatedInspection(ctx.org.id, inspectionId);
  if (!insp) redirect(`/assets?error=inspection_missing`);

  const { answers, comments } = parseRunForm(formData);
  const tenant = await createClient();
  const { error, count } = await (tenant.from("asset_inspections" as never) as unknown as UpdateChain)
    .update({ content: { ...(insp.content ?? {}), answers, comments } }, { count: "exact" })
    .eq("id", inspectionId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[asset-inspection] save answers failed", error);
    redirect(`/assets/${insp.asset_id}/inspections/${inspectionId}?error=inspection_failed`);
  }
  if (!count) redirect(`/assets/${insp.asset_id}/inspections/${inspectionId}?error=inspection_not_draft`);

  revalidatePath(`/assets/${insp.asset_id}/inspections/${inspectionId}`);
  redirect(`/assets/${insp.asset_id}/inspections/${inspectionId}?saved=progress`);
}

/**
 * Complete a templated inspection: validate answers against the FROZEN template
 * snapshot, DERIVE the outcome (a failed safety-critical item → fail +
 * safety_critical, engaging the M4c custody block), then issue atomically.
 */
export async function completeTemplatedInspection(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const inspectionId = String(formData.get("inspection_id") ?? "");
  const insp = await loadTemplatedInspection(ctx.org.id, inspectionId);
  if (!insp) redirect(`/assets?error=inspection_missing`);
  const runUrl = `/assets/${insp.asset_id}/inspections/${inspectionId}`;
  if (!insp.template_snapshot) redirect(`${runUrl}?error=inspection_invalid`);

  try {
    assertTransition(insp.status, "issued");
  } catch {
    redirect(`${runUrl}?error=inspection_not_draft`);
  }

  const { answers, comments } = parseRunForm(formData);
  const sections = insp.template_snapshot.sections;
  if (missingRequired(sections, answers).length > 0) {
    redirect(`${runUrl}?error=answers_missing`);
  }
  if (missingFailComments(sections, answers, comments).length > 0) {
    redirect(`${runUrl}?error=fail_comment_missing`);
  }

  const derived = deriveOutcome(sections, answers);
  const issuedAt = new Date().toISOString();
  const content = {
    ...(insp.content ?? {}),
    answers,
    comments,
    failed_keys: derived.failed_keys,
    critical_failed_keys: derived.critical_failed_keys,
  };
  const snapshot = materializeInspectionSnapshot({
    title: insp.title,
    kind: insp.kind,
    safety_critical: derived.safety_critical,
    outcome: derived.outcome,
    content,
    asset: insp.assets ?? { id: insp.asset_id, name: "", asset_ref: null },
    inspected_at: issuedAt,
    issuedAt,
  });

  const tenant = await createClient();
  // Atomic: outcome + safety flag + evidence + snapshot in ONE write; the M4a
  // immutability trigger freezes it all, and template_snapshot is already
  // write-once from start.
  const { error, count } = await (tenant.from("asset_inspections" as never) as unknown as UpdateChain)
    .update(
      {
        status: "issued",
        outcome: derived.outcome,
        safety_critical: derived.safety_critical,
        snapshot,
        content,
        inspected_at: issuedAt,
        inspected_by: user.id,
      },
      { count: "exact" },
    )
    .eq("id", inspectionId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[asset-inspection] templated issue failed", error);
    redirect(`${runUrl}?error=inspection_failed`);
  }
  if (!count) redirect(`${runUrl}?error=inspection_not_draft`);

  // Informational writeback for the schedule that generated this inspection
  // (advancement happened at generation — fixed-cadence anchoring).
  if (insp.schedule_id) {
    const { error: writebackError } = await (
      tenant.from("asset_inspection_schedules" as never) as unknown as {
        update: (p: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
          };
        };
      }
    )
      .update({ last_completed_at: issuedAt })
      .eq("id", insp.schedule_id)
      .eq("org_id", ctx.org.id);
    if (writebackError) console.error("[asset-inspection] schedule writeback failed", writebackError);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_issued",
    targetTable: "asset_inspections",
    targetId: inspectionId,
    metadata: {
      asset_id: insp.asset_id,
      outcome: derived.outcome,
      safety_critical: derived.safety_critical,
      template_id: insp.template_snapshot.template_id,
      template_version: insp.template_snapshot.version,
    },
  });

  revalidatePath(`/assets/${insp.asset_id}`);
  redirect(`${runUrl}?saved=issued`);
}
