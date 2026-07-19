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
