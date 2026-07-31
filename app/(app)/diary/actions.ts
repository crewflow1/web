"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import { createDiaryEntryRecord } from "@/server/services/offline-writes";
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
 *
 * CREATE is delegated to `createDiaryEntryRecord`
 * (server/services/offline-writes.ts), which is the SAME function the offline
 * write queue replays through. That is intentional: an entry authored in a
 * basement and synced two hours later must hit identical validation, identical
 * RLS, identical cross-org job guard and identical audit as one typed at a desk.
 * If the two had separate insert statements they would eventually drift, and the
 * offline path is exactly the one nobody would notice drifting.
 */

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

  if (!data) redirect(`/diary/new?error=validation`);

  // The SHARED write core — see the file header. It mints its own idempotency key
  // for an online post (one is stored on every row, so there is one write path to
  // reason about, not an online one and a divergent offline one) and performs the
  // cross-org job guard + audit that the queued replay also gets.
  const outcome = await createDiaryEntryRecord({ ctx, user, input: data });

  if (outcome.status === "rejected") {
    // A form post can realistically only hit job_missing here (a job deleted or
    // switched away between page render and submit); the rest are shapes the Zod
    // parse above already refused.
    redirect(
      `/diary/new?error=${outcome.reason === "job_missing" ? "job_missing" : "record_failed"}`,
    );
  }
  if (outcome.status === "retry") {
    redirect(`/diary/new?error=record_failed`);
  }

  revalidatePath("/diary");
  redirect(`/diary/${outcome.id}?saved=created`);
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
