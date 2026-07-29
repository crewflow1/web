"use server";

import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  createBlueprint, addBlueprintRevision, deleteBlueprint,
} from "@/server/services/blueprints";
import { createBlueprintSchema, addRevisionSchema, blueprintIdSchema, BLUEPRINT_STATUSES } from "@/lib/blueprints/schema";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Blueprint Centre server actions. These return `FormState` (the client
 * navigates via `redirectTo` through <StateForm>, a full document load)
 * instead of calling `redirect()`. A Server-Action redirect at this route
 * depth (/jobs/[id]/blueprints) loses a race in the Next 15.5 client router:
 * the row is written but the URL never changes and no error surfaces. See
 * components/forms/StateForm.tsx. No revalidatePath, deliberately: this page
 * renders per-request (cookie-authed reads), so the post-success document
 * load is always fresh.
 */

const jobIdSchema = z.string().uuid();

async function fileFromForm(formData: FormData): Promise<{ bytes: Uint8Array; mime: string; fileName: string } | null> {
  const f = formData.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.type, fileName: f.name };
}

export async function uploadBlueprint(jobId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!jobIdSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");

  const parsed = createBlueprintSchema.safeParse({
    drawing_number: formData.get("drawing_number"), title: formData.get("title"),
    discipline: formData.get("discipline") || undefined, revision: formData.get("revision"),
    revision_date: formData.get("revision_date"), notes: formData.get("notes"),
  });
  if (!parsed.success) return formError(parsed.error.issues[0]?.message ?? "Check the form");
  const file = await fileFromForm(formData);
  if (!file) return formError("Choose a drawing file to upload.");

  const res = await createBlueprint({ jobId, meta: parsed.data, file });
  if (!res.ok) return formError(res.error);
  return formSuccess({ redirectTo: `/jobs/${jobId}/blueprints?saved=created` });
}

export async function uploadRevision(jobId: string, blueprintId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!jobIdSchema.safeParse(jobId).success || !blueprintIdSchema.safeParse(blueprintId).success) {
    return formError("That drawing link looks wrong — reload and try again.");
  }

  const parsed = addRevisionSchema.safeParse({
    revision: formData.get("revision"), revision_date: formData.get("revision_date"), notes: formData.get("notes"),
  });
  if (!parsed.success) return formError(parsed.error.issues[0]?.message ?? "Check the form");
  const file = await fileFromForm(formData);
  if (!file) return formError("Choose a drawing file to upload.");

  const res = await addBlueprintRevision({ blueprintId, meta: parsed.data, file });
  if (!res.ok) return formError(res.error);
  return formSuccess({ redirectTo: `/jobs/${jobId}/blueprints?saved=revision` });
}

export async function setBlueprintStatus(jobId: string, blueprintId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!blueprintIdSchema.safeParse(blueprintId).success) return formError("That drawing link looks wrong — reload and try again.");
  if (!isAdmin) return formError("Only owners/admins can change status.");
  const status = String(formData.get("status") ?? "");
  if (!(BLUEPRINT_STATUSES as readonly string[]).includes(status)) {
    return formError("That status isn't available — reload and try again.");
  }

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("blueprints" as never) as unknown as {
      update: (r: unknown, o?: { count?: string }) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }> };
    }
  ).update({ status }, { count: "exact" }).eq("id", blueprintId);
  if (error || !count) return formError("Couldn't update the status.");
  await recordAdminActivity({ actorId: user.id, actorEmail: user.email ?? null, action: "blueprint.status_set", targetTable: "blueprints", targetId: blueprintId, metadata: { status } });
  return formSuccess({ redirectTo: `/jobs/${jobId}/blueprints?saved=status` });
}

export async function removeBlueprint(
  jobId: string,
  blueprintId: string,
  _prev: FormState, _formData: FormData, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<FormState> {
  if (!blueprintIdSchema.safeParse(blueprintId).success) return formError("That drawing link looks wrong — reload and try again.");
  const res = await deleteBlueprint(blueprintId);
  if (!res.ok) return formError(res.error);
  return formSuccess({ redirectTo: `/jobs/${jobId}/blueprints?saved=deleted` });
}
