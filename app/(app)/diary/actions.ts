"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import {
  createDiaryEntrySchema,
  diaryIdSchema,
  updateDiaryEntrySchema,
} from "@/lib/site-diary/schema";

/**
 * Site Diary server actions.
 *
 * `site_diary_entries` is newer than the generated Supabase types, so every
 * query is cast through a minimal precise shape — the same idiom snags and
 * compliance_documents use. All writes go through the tenant (user-JWT) client
 * so RLS scopes them; the service-role client is never used here (photos ride
 * tenant_attachments). Mutations are count-gated: an RLS no-op returns "not
 * found" rather than a false success.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
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
type AttachmentIdsChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ data: { id: string }[] | null }>;
      };
    };
  };
};

function parseEntry(formData: FormData) {
  return {
    entry_date: formData.get("entry_date") ?? "",
    job_id: formData.get("job_id") ?? "",
    weather: formData.get("weather") ?? "",
    labour_count: formData.get("labour_count") ?? "",
    work_summary: formData.get("work_summary") ?? "",
    delays: formData.get("delays") ?? "",
    notes: formData.get("notes") ?? "",
  };
}

export async function createDiaryEntry(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createDiaryEntrySchema.safeParse(parseEntry(formData));
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/diary/new?error=${encodeURIComponent(firstError)}`);
  }
  const data = parsed.success ? parsed.data : null;

  const id = randomUUID();
  const tenant = await createClient();
  const { error } = await (
    tenant.from("site_diary_entries" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: ctx.org.id,
    entry_date: data?.entry_date,
    job_id: data?.job_id ?? null,
    weather: data?.weather ?? null,
    labour_count: data?.labour_count ?? null,
    work_summary: data?.work_summary ?? null,
    delays: data?.delays ?? null,
    notes: data?.notes ?? null,
    created_by: user.id,
  });
  if (error) {
    console.error("[diary] insert failed", error);
    redirect(`/diary/new?error=record_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_diary.created",
    targetTable: "site_diary_entries",
    targetId: id,
    metadata: { entry_date: data?.entry_date, job_id: data?.job_id ?? null },
  });

  revalidatePath("/diary");
  redirect(`/diary/${id}?saved=created`);
}

export async function updateDiaryEntry(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = updateDiaryEntrySchema.safeParse({
    id: formData.get("id") ?? "",
    ...parseEntry(formData),
  });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    redirect(`/diary/${id}/edit?error=validation`);
  }
  const data = parsed.success ? parsed.data : null;
  const id = data?.id ?? "";

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("site_diary_entries" as never) as unknown as UpdateChain
  )
    .update(
      {
        entry_date: data?.entry_date,
        job_id: data?.job_id ?? null,
        weather: data?.weather ?? null,
        labour_count: data?.labour_count ?? null,
        work_summary: data?.work_summary ?? null,
        delays: data?.delays ?? null,
        notes: data?.notes ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[diary] update failed", error);
    redirect(`/diary/${id}/edit?error=record_failed`);
  }
  if (!count) redirect(`/diary?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_diary.updated",
    targetTable: "site_diary_entries",
    targetId: id,
    metadata: { entry_date: data?.entry_date },
  });

  revalidatePath("/diary");
  revalidatePath(`/diary/${id}`);
  redirect(`/diary/${id}?saved=updated`);
}

export async function deleteDiaryEntry(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!diaryIdSchema.safeParse(id).success) redirect(`/diary?error=bad_id`);

  // Hard delete is admin-only (RLS delete policy is is_org_admin). Re-enforce in
  // code so a member gets a deterministic "forbidden" and we never attempt the
  // attachment cleanup for a non-admin.
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/diary?error=forbidden`);
  }

  const tenant = await createClient();

  // Remove this entry's photos first (reuses the universal delete; no dup code).
  const { data: atts } = await (
    tenant.from("tenant_attachments" as never) as unknown as AttachmentIdsChain
  )
    .select("id")
    .eq("target_table", "site_diary_entries")
    .eq("target_id", id)
    .eq("org_id", ctx.org.id);
  for (const a of atts ?? []) {
    await deleteTenantAttachment(a.id).catch(() => undefined);
  }

  const { error, count } = await (
    tenant.from("site_diary_entries" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[diary] delete failed", error);
    redirect(`/diary?error=delete_failed`);
  }
  if (!count) redirect(`/diary?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site_diary.deleted",
    targetTable: "site_diary_entries",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });

  revalidatePath("/diary");
  redirect(`/diary?saved=deleted`);
}
