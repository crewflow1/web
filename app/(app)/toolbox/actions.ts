"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import {
  createToolboxTalkSchema,
  toolboxTalkIdSchema,
} from "@/lib/toolbox-talks/schema";

/**
 * Toolbox Talks server actions. `toolbox_talks` is newer than the generated
 * Supabase types, so queries are cast through a minimal precise shape — the
 * same idiom snags / site diary use. All writes go through the tenant (user-JWT)
 * client so RLS scopes them; mutations are count-gated.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
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

export async function createToolboxTalk(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createToolboxTalkSchema.safeParse({
    talk_date: formData.get("talk_date") ?? "",
    topic: formData.get("topic") ?? "",
    job_id: formData.get("job_id") ?? "",
    presenter: formData.get("presenter") ?? "",
    attendees: formData.get("attendees") ?? "",
    attendee_count: formData.get("attendee_count") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/toolbox/new?error=${encodeURIComponent(firstError)}`);
  }
  const data = parsed.success ? parsed.data : null;

  const id = randomUUID();
  const tenant = await createClient();
  const { error } = await (
    tenant.from("toolbox_talks" as never) as unknown as InsertChain
  ).insert({
    id,
    org_id: ctx.org.id,
    talk_date: data?.talk_date,
    topic: data?.topic,
    job_id: data?.job_id ?? null,
    presenter: data?.presenter ?? null,
    attendees: data?.attendees ?? null,
    attendee_count: data?.attendee_count ?? null,
    notes: data?.notes ?? null,
    created_by: user.id,
  });
  if (error) {
    console.error("[toolbox] insert failed", error);
    redirect(`/toolbox/new?error=record_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.created",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { topic: data?.topic, talk_date: data?.talk_date, job_id: data?.job_id ?? null },
  });

  revalidatePath("/toolbox");
  redirect(`/toolbox/${id}?saved=created`);
}

export async function deleteToolboxTalk(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!toolboxTalkIdSchema.safeParse(id).success) redirect(`/toolbox?error=bad_id`);

  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/toolbox?error=forbidden`);
  }

  const tenant = await createClient();

  const { data: atts } = await (
    tenant.from("tenant_attachments" as never) as unknown as AttachmentIdsChain
  )
    .select("id")
    .eq("target_table", "toolbox_talks")
    .eq("target_id", id)
    .eq("org_id", ctx.org.id);
  for (const a of atts ?? []) {
    await deleteTenantAttachment(a.id).catch(() => undefined);
  }

  const { error, count } = await (
    tenant.from("toolbox_talks" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[toolbox] delete failed", error);
    redirect(`/toolbox?error=delete_failed`);
  }
  if (!count) redirect(`/toolbox?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "toolbox_talk.deleted",
    targetTable: "toolbox_talks",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });

  revalidatePath("/toolbox");
  redirect(`/toolbox?saved=deleted`);
}
