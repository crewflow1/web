"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createBlueprint, addBlueprintRevision, deleteBlueprint,
} from "@/server/services/blueprints";
import { createBlueprintSchema, addRevisionSchema, blueprintIdSchema, BLUEPRINT_STATUSES } from "@/lib/blueprints/schema";

const jobIdSchema = z.string().uuid();

async function fileFromForm(formData: FormData): Promise<{ bytes: Uint8Array; mime: string; fileName: string } | null> {
  const f = formData.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, fileName: f.name };
}

export async function uploadBlueprint(jobId: string, formData: FormData): Promise<void> {
  if (!jobIdSchema.safeParse(jobId).success) redirect("/jobs");
  const back = (q: string) => redirect(`/jobs/${jobId}/blueprints?${q}`);

  const parsed = createBlueprintSchema.safeParse({
    drawing_number: formData.get("drawing_number"), title: formData.get("title"),
    discipline: formData.get("discipline") || undefined, revision: formData.get("revision"),
    revision_date: formData.get("revision_date"), notes: formData.get("notes"),
  });
  if (!parsed.success) back(`error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the form")}`);
  const file = await fileFromForm(formData);
  if (!file) back("error=" + encodeURIComponent("Choose a drawing file to upload."));

  const res = await createBlueprint({ jobId, meta: parsed.success ? parsed.data : ({} as never), file: file! });
  if (!res.ok) back(`error=${encodeURIComponent(res.error)}`);
  revalidatePath(`/jobs/${jobId}/blueprints`);
  back("saved=created");
}

export async function uploadRevision(jobId: string, blueprintId: string, formData: FormData): Promise<void> {
  if (!jobIdSchema.safeParse(jobId).success || !blueprintIdSchema.safeParse(blueprintId).success) redirect("/jobs");
  const back = (q: string) => redirect(`/jobs/${jobId}/blueprints?${q}`);

  const parsed = addRevisionSchema.safeParse({
    revision: formData.get("revision"), revision_date: formData.get("revision_date"), notes: formData.get("notes"),
  });
  if (!parsed.success) back(`error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the form")}`);
  const file = await fileFromForm(formData);
  if (!file) back("error=" + encodeURIComponent("Choose a drawing file to upload."));

  const res = await addBlueprintRevision({ blueprintId, meta: parsed.success ? parsed.data : ({} as never), file: file! });
  if (!res.ok) back(`error=${encodeURIComponent(res.error)}`);
  revalidatePath(`/jobs/${jobId}/blueprints`);
  back("saved=revision");
}

export async function setBlueprintStatus(jobId: string, blueprintId: string, formData: FormData): Promise<void> {
  const { user, ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const back = (q: string) => redirect(`/jobs/${jobId}/blueprints?${q}`);
  if (!blueprintIdSchema.safeParse(blueprintId).success) redirect("/jobs");
  if (!isAdmin) back("error=" + encodeURIComponent("Only owners/admins can change status."));
  const status = String(formData.get("status") ?? "");
  if (!(BLUEPRINT_STATUSES as readonly string[]).includes(status)) back("error=bad_status");

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("blueprints" as never) as unknown as {
      update: (r: unknown, o?: { count?: string }) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }> };
    }
  ).update({ status }, { count: "exact" }).eq("id", blueprintId);
  if (error || !count) back("error=" + encodeURIComponent("Couldn't update the status."));
  await recordAdminActivity({ actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.status_set", targetTable: "blueprints", targetId: blueprintId, metadata: { status } });
  revalidatePath(`/jobs/${jobId}/blueprints`);
  back("saved=status");
}

export async function removeBlueprint(jobId: string, blueprintId: string): Promise<void> {
  if (!blueprintIdSchema.safeParse(blueprintId).success) redirect("/jobs");
  const res = await deleteBlueprint(blueprintId);
  revalidatePath(`/jobs/${jobId}/blueprints`);
  redirect(`/jobs/${jobId}/blueprints?${res.ok ? "saved=deleted" : "error=" + encodeURIComponent(res.error)}`);
}
