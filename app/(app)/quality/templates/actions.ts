"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createTemplateSchema,
  templateIdSchema,
  templateItemSchema,
  templateItemIdSchema,
  instantiateTemplateSchema,
  orNull,
} from "@/lib/quality/schema";
import type { TemplateItemRow } from "@/lib/quality/schema";
import { getTemplate } from "./_data";

/**
 * Works Quality — ITP template server actions (M2).
 *
 * Tenant (user-JWT) client only; the DB owns the invariants (lifecycle,
 * publish atomicity + item gate, item freeze once published, org derivation).
 * Instantiation copies a PUBLISHED template's items into a brand-new DRAFT
 * plan — real inspection_plan_items rows, so from that moment the plan is
 * indistinguishable from a hand-built one and M1's freeze-on-issue applies
 * untouched.
 *
 * NOTHING here writes to `finances`, and there is no AI on any path.
 * Route-swap depth is 3 (/quality/templates/[id]) — plain redirect() holds.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type FromChain = { from: (t: string) => any };
// Bind `this` — `.from` is a prototype method; unbound it throws on first use.
const tbl = (c: unknown) => (c as FromChain).from.bind(c);
type RpcChain = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function firstError(issues: { message: string }[]): string {
  return issues[0]?.message ?? "Invalid input";
}

// ---------------------------------------------------------------------------
// Create / new version
// ---------------------------------------------------------------------------
export async function createTemplate(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = createTemplateSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quality/templates?error=${encodeURIComponent(firstError(parsed.error.issues))}`);
  }
  const v = parsed.data;
  const id = randomUUID();
  const supabase = await createClient();

  // Version 1 of a new family — or, if the name exists, the next version
  // number. One pinned read; unique (org_id, name, version) backstops a race.
  const { data: existing, error: readError } = await tbl(supabase)("inspection_plan_templates")
    .select("version")
    .eq("org_id", ctx.org.id)
    .eq("name", v.name)
    .order("version", { ascending: false })
    .limit(1);
  if (readError) {
    redirect(`/quality/templates?error=${encodeURIComponent(readError.message)}`);
  }
  const nextVersion = ((existing?.[0] as { version: number } | undefined)?.version ?? 0) + 1;

  const { error } = await tbl(supabase)("inspection_plan_templates").insert({
    id,
    org_id: ctx.org.id,
    name: v.name,
    version: nextVersion,
    description: orNull(v.description),
    created_by: user.id,
  });
  if (error) redirect(`/quality/templates?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/quality/templates");
  redirect(`/quality/templates/${id}?saved=created`);
}

/** New draft version FROM an existing version (items copied). */
export async function createTemplateVersion(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = templateIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality/templates?error=bad_id`);
  const id = parsed.data.id;

  const loaded = await getTemplate(ctx.org.id, id);
  if (!loaded) redirect(`/quality/templates?error=not_found`);
  const { template, items } = loaded;

  const supabase = await createClient();
  const { data: latest, error: latestError } = await tbl(supabase)("inspection_plan_templates")
    .select("version")
    .eq("org_id", ctx.org.id)
    .eq("name", template.name)
    .order("version", { ascending: false })
    .limit(1);
  if (latestError) {
    redirect(`/quality/templates/${id}?error=${encodeURIComponent(latestError.message)}`);
  }
  const nextVersion = ((latest?.[0] as { version: number } | undefined)?.version ?? 0) + 1;

  const newId = randomUUID();
  const { error } = await tbl(supabase)("inspection_plan_templates").insert({
    id: newId,
    org_id: ctx.org.id,
    name: template.name,
    version: nextVersion,
    description: template.description,
    supersedes_id: template.id,
    created_by: user.id,
  });
  if (error) redirect(`/quality/templates/${id}?error=${encodeURIComponent(error.message)}`);

  if (items.length > 0) {
    // Every column supplied on every row (the PostgREST batch NULL trap).
    const { error: itemsError } = await tbl(supabase)("inspection_plan_template_items").insert(
      items.map((i: TemplateItemRow) => ({
        org_id: ctx.org.id, // trigger-derived; passed for RLS
        template_id: newId,
        item_number: i.item_number,
        title: i.title,
        acceptance_criteria: i.acceptance_criteria,
        inspection_method: i.inspection_method,
        specification_ref: i.specification_ref,
        control_point: i.control_point,
        is_hold_point: i.is_hold_point,
        required: i.required,
      })),
    );
    if (itemsError) {
      // Leave nothing half-built — the new row is a draft, so delete is allowed.
      await tbl(supabase)("inspection_plan_templates")
        .delete()
        .eq("id", newId)
        .eq("org_id", ctx.org.id);
      redirect(`/quality/templates/${id}?error=${encodeURIComponent(itemsError.message)}`);
    }
  }

  revalidatePath("/quality/templates");
  redirect(`/quality/templates/${newId}?saved=version_created`);
}

// ---------------------------------------------------------------------------
// Items (drafts only — the DB trigger enforces it)
// ---------------------------------------------------------------------------
export async function addTemplateItem(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("templateId") ?? "");
  const parsed = templateItemSchema.safeParse({
    templateId,
    itemNumber: formData.get("itemNumber"),
    title: formData.get("title"),
    acceptanceCriteria: formData.get("acceptanceCriteria"),
    inspectionMethod: formData.get("inspectionMethod") ?? "",
    specificationRef: formData.get("specificationRef") ?? "",
    controlPoint: formData.get("controlPoint") ?? "inspect",
    isHoldPoint: formData.get("isHoldPoint") === "on",
    // The hidden-"off" idiom: the form always sends "off", adds "on" when
    // ticked — ask for the tick, never for the absence of one.
    required: formData.getAll("required").includes("on"),
  });
  if (!parsed.success) {
    redirect(
      `/quality/templates/${templateId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`,
    );
  }
  const v = parsed.data;
  const supabase = await createClient();
  const { error } = await tbl(supabase)("inspection_plan_template_items").insert({
    org_id: ctx.org.id, // trigger-derived from the template; passed for RLS
    template_id: v.templateId,
    item_number: v.itemNumber,
    title: v.title,
    acceptance_criteria: v.acceptanceCriteria,
    inspection_method: orNull(v.inspectionMethod),
    specification_ref: orNull(v.specificationRef),
    control_point: v.controlPoint,
    // A hold point is always required (ipti_hold_point_is_required).
    is_hold_point: v.isHoldPoint ?? false,
    required: v.isHoldPoint ? true : (v.required ?? true),
  });
  if (error) {
    const code = /duplicate key|unique/i.test(error.message)
      ? "duplicate_item_number"
      : encodeURIComponent(error.message);
    redirect(`/quality/templates/${v.templateId}?error=${code}`);
  }
  revalidatePath(`/quality/templates/${v.templateId}`);
  redirect(`/quality/templates/${v.templateId}?saved=item_added`);
}

export async function deleteTemplateItem(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = templateItemIdSchema.safeParse({
    id: formData.get("id"),
    templateId: formData.get("templateId"),
  });
  if (!parsed.success) redirect(`/quality/templates?error=bad_id`);
  const { id, templateId } = parsed.data;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_plan_template_items")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) redirect(`/quality/templates/${templateId}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/templates/${templateId}?error=not_found`);
  revalidatePath(`/quality/templates/${templateId}`);
  redirect(`/quality/templates/${templateId}?saved=item_removed`);
}

// ---------------------------------------------------------------------------
// Publish (atomic — the RPC archives the family's current published version)
// ---------------------------------------------------------------------------
export async function publishTemplate(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const parsed = templateIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality/templates?error=bad_id`);
  const id = parsed.data.id;

  // Friendly pre-check; the DB re-enforces the item gate.
  // ACTIVE-org pinned so a dual-org member cannot drive the publish flow
  // against the other company's template.
  const loaded = await getTemplate(ctx.org.id, id);
  if (!loaded) redirect(`/quality/templates?error=not_found`);
  if (loaded.items.length === 0) {
    redirect(`/quality/templates/${id}?error=no_items`);
  }

  const supabase = await createClient();
  const { error } = await (supabase as unknown as RpcChain).rpc(
    "publish_inspection_plan_template",
    { p_id: id },
  );
  if (error) redirect(`/quality/templates/${id}?error=${encodeURIComponent(error.message)}`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inspection_plan_template.published",
    targetTable: "inspection_plan_templates",
    targetId: id,
    metadata: { name: loaded.template.name, version: loaded.template.version },
  }).catch(() => {});

  revalidatePath("/quality/templates");
  revalidatePath(`/quality/templates/${id}`);
  redirect(`/quality/templates/${id}?saved=published`);
}

export async function archiveTemplate(formData: FormData): Promise<void> {
  const { ctx } = await requireOrgContext();
  const parsed = templateIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) redirect(`/quality/templates?error=bad_id`);
  const id = parsed.data.id;
  const supabase = await createClient();
  const { error, count } = await tbl(supabase)("inspection_plan_templates")
    .update({ status: "archived" }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .in("status", ["draft", "published"]);
  if (error) redirect(`/quality/templates/${id}?error=${encodeURIComponent(error.message)}`);
  if (!count) redirect(`/quality/templates/${id}?error=not_found`);
  revalidatePath("/quality/templates");
  revalidatePath(`/quality/templates/${id}`);
  redirect(`/quality/templates/${id}?saved=archived`);
}

// ---------------------------------------------------------------------------
// Instantiate: published template → a real DRAFT plan with real items
// ---------------------------------------------------------------------------
export async function instantiateTemplate(formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const templateId = String(formData.get("templateId") ?? "");
  const parsed = instantiateTemplateSchema.safeParse({
    templateId,
    jobId: formData.get("jobId"),
    workPackage: formData.get("workPackage"),
    title: formData.get("title") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/quality/templates/${templateId}?error=${encodeURIComponent(firstError(parsed.error.issues))}`,
    );
  }
  const v = parsed.data;

  // ACTIVE-org pinned read; only a PUBLISHED version instantiates.
  const loaded = await getTemplate(ctx.org.id, v.templateId);
  if (!loaded) redirect(`/quality/templates?error=not_found`);
  const { template, items } = loaded;
  if (template.status !== "published") {
    redirect(`/quality/templates/${v.templateId}?error=not_published`);
  }

  const planId = randomUUID();
  const supabase = await createClient();
  // Born a DRAFT (the DB refuses anything else), on the ACTIVE org, against a
  // job the DB verifies is same-org.
  const { error } = await tbl(supabase)("inspection_test_plans").insert({
    id: planId,
    org_id: ctx.org.id,
    job_id: v.jobId,
    title: orNull(v.title) ?? template.name,
    work_package: v.workPackage,
    notes: template.description,
    created_by: user.id,
  });
  if (error) redirect(`/quality/templates/${v.templateId}?error=${encodeURIComponent(error.message)}`);

  if (items.length > 0) {
    // REAL inspection_plan_items rows — the relational instantiation contract.
    // Every column supplied on every row (the PostgREST batch NULL trap).
    const { error: itemsError } = await tbl(supabase)("inspection_plan_items").insert(
      items.map((i: TemplateItemRow) => ({
        org_id: ctx.org.id, // trigger-derived from the plan; passed for RLS
        inspection_test_plan_id: planId,
        item_number: i.item_number,
        title: i.title,
        acceptance_criteria: i.acceptance_criteria,
        inspection_method: i.inspection_method,
        specification_ref: i.specification_ref,
        control_point: i.control_point,
        is_hold_point: i.is_hold_point,
        required: i.required,
      })),
    );
    if (itemsError) {
      await tbl(supabase)("inspection_test_plans")
        .delete()
        .eq("id", planId)
        .eq("org_id", ctx.org.id);
      redirect(`/quality/templates/${v.templateId}?error=${encodeURIComponent(itemsError.message)}`);
    }
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "inspection_plan.instantiated_from_template",
    targetTable: "inspection_test_plans",
    targetId: planId,
    metadata: { template_id: template.id, template_version: template.version },
  }).catch(() => {});

  revalidatePath("/quality");
  redirect(`/quality/${planId}?saved=created`);
}
