"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { deleteTenantAttachment } from "@/server/services/tenant-attachments";
import { createSnagRecord } from "@/server/services/offline-writes";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  createSnagSchema,
  reassignSnagSchema,
  resolvedAtForTransition,
  setSnagPrioritySchema,
  snagIdSchema,
  updateSnagSchema,
  updateSnagStatusSchema,
  type SnagStatus,
} from "@/lib/snags/schema";

/**
 * Snagging server actions.
 *
 * `snags` is newer than the generated Supabase types, so every query is
 * cast through a minimal precise shape — the same idiom compliance_documents
 * uses (app/(app)/compliance/actions.ts). All writes go through the tenant
 * (user-JWT) client so RLS scopes them; the service-role client is never used
 * here (snags carry no storage of their own — photos ride tenant_attachments).
 *
 * Every mutation is count-gated: an update/delete that RLS turns into a no-op
 * returns count 0 and we surface "not found" rather than a false success.
 *
 * CREATE is delegated to `createSnagRecord` (server/services/offline-writes.ts),
 * the SAME function the offline write queue replays through — the diary's
 * two-entry-point contract. A snag logged in a basement and synced two hours
 * later must hit identical validation, identical RLS, identical cross-org
 * job/assignee guards and identical audit as one typed at a desk; two insert
 * statements would eventually drift, and the offline one is exactly the one
 * nobody would notice drifting.
 */

type SelectStatusChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{
          data: { status: string; title: string | null } | null;
          error: SupabaseReadError | null;
        }>;
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
type LookupChain = {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => {
        maybeSingle: () => Promise<{
          data: { id?: string; user_id?: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export async function createSnag(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = createSnagSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    location: formData.get("location") ?? "",
    trade: formData.get("trade") ?? "",
    priority: formData.get("priority") ?? "medium",
    job_id: formData.get("job_id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
    due_date: formData.get("due_date") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/snags/new?error=${encodeURIComponent(firstError)}`);
  }
  const data = parsed.success ? parsed.data : null;
  if (!data) redirect(`/snags/new?error=validation`);

  // The SHARED write core — see the file header. It mints its own idempotency
  // key for an online post (one is stored on every row, so there is one write
  // path to reason about), pins status 'open', and performs the cross-org
  // job + assignee guards and the audit call that the queued replay also gets.
  const outcome = await createSnagRecord({ ctx, user, input: data });

  if (outcome.status === "rejected") {
    // A form post can realistically only hit job_missing / assignee_missing
    // here (a job or member removed between page render and submit); the rest
    // are shapes the Zod parse above already refused.
    const reason =
      outcome.reason === "job_missing" || outcome.reason === "assignee_missing"
        ? outcome.reason
        : "record_failed";
    redirect(`/snags/new?error=${reason}`);
  }
  if (outcome.status === "retry") {
    redirect(`/snags/new?error=record_failed`);
  }

  revalidatePath("/snags");
  redirect(`/snags/${outcome.id}?saved=created`);
}

export async function updateSnag(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = updateSnagSchema.safeParse({
    id: formData.get("id") ?? "",
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    location: formData.get("location") ?? "",
    trade: formData.get("trade") ?? "",
    priority: formData.get("priority") ?? "medium",
    job_id: formData.get("job_id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
    due_date: formData.get("due_date") ?? "",
  });
  if (!parsed.success) {
    const id = String(formData.get("id") ?? "");
    redirect(`/snags/${id}/edit?error=validation`);
  }
  const data = parsed.success ? parsed.data : null;
  const id = data?.id ?? "";

  const tenant = await createClient();

  // Cross-org guards, pinned to the ACTIVE org — the create core's guards, applied
  // to the online edit too (snags.job_id / assigned_to carry plain FKs with no
  // org guard, and RLS admits every org a multi-org member belongs to).
  if (data?.job_id) {
    const { data: job, error } = await (
      tenant.from("jobs" as never) as unknown as LookupChain
    )
      .select("id")
      .eq("id", data.job_id)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (error) redirect(`/snags/${id}/edit?error=record_failed`);
    if (!job) redirect(`/snags/${id}/edit?error=job_missing`);
  }
  if (data?.assigned_to) {
    const { data: member, error } = await (
      tenant.from("memberships" as never) as unknown as LookupChain
    )
      .select("user_id")
      .eq("user_id", data.assigned_to)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (error) redirect(`/snags/${id}/edit?error=record_failed`);
    if (!member) redirect(`/snags/${id}/edit?error=assignee_missing`);
  }

  const { error, count } = await (
    tenant.from("snags" as never) as unknown as UpdateChain
  )
    .update(
      {
        title: data?.title,
        description: data?.description ?? null,
        location: data?.location ?? null,
        trade: data?.trade ?? null,
        priority: data?.priority ?? "medium",
        job_id: data?.job_id ?? null,
        assigned_to: data?.assigned_to ?? null,
        due_date: data?.due_date ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[snags] update failed", error);
    redirect(`/snags/${id}/edit?error=record_failed`);
  }
  if (!count) redirect(`/snags?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "snag.updated",
    targetTable: "snags",
    targetId: id,
    metadata: { title: data?.title ?? null, priority: data?.priority ?? null },
  });

  revalidatePath("/snags");
  revalidatePath(`/snags/${id}`);
  redirect(`/snags/${id}?saved=updated`);
}

export async function updateSnagStatus(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = updateSnagStatusSchema.safeParse({
    id: formData.get("id") ?? "",
    status: formData.get("status") ?? "",
  });
  if (!parsed.success) redirect(`/snags?error=bad_status`);
  const { id, status } = parsed.success
    ? parsed.data
    : { id: "", status: "open" as SnagStatus };

  const tenant = await createClient();

  // Read the current status (org-scoped) so we can derive resolved_at.
  const { data: row, error: rowError } = await (
    tenant.from("snags" as never) as unknown as SelectStatusChain
  )
    .select("status, title")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (rowError) throw readFailure("snags: status read", rowError);
  if (!row) redirect(`/snags?error=not_found`);

  const resolved = resolvedAtForTransition(
    row.status as SnagStatus,
    status,
    new Date(),
  );
  const patch: Record<string, unknown> = { status };
  if (resolved !== undefined) {
    patch.resolved_at = resolved ? resolved.toISOString() : null;
  }

  const { error, count } = await (
    tenant.from("snags" as never) as unknown as UpdateChain
  )
    .update(patch, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[snags] status update failed", error);
    redirect(`/snags/${id}?error=update_failed`);
  }
  if (!count) redirect(`/snags?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "snag.status_changed",
    targetTable: "snags",
    targetId: id,
    metadata: { from: row.status, to: status, title: row.title ?? null },
  });

  revalidatePath("/snags");
  revalidatePath(`/snags/${id}`);
  redirect(`/snags/${id}?saved=status`);
}

export async function reassignSnag(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = reassignSnagSchema.safeParse({
    id: formData.get("id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
  });
  if (!parsed.success) redirect(`/snags?error=bad_assignee`);
  const id = parsed.success ? parsed.data.id : "";
  const assignedTo = parsed.success ? (parsed.data.assigned_to ?? null) : null;

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("snags" as never) as unknown as UpdateChain
  )
    .update({ assigned_to: assignedTo }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[snags] reassign failed", error);
    redirect(`/snags/${id}?error=update_failed`);
  }
  if (!count) redirect(`/snags?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "snag.reassigned",
    targetTable: "snags",
    targetId: id,
    metadata: { assigned_to: assignedTo },
  });

  revalidatePath(`/snags/${id}`);
  redirect(`/snags/${id}?saved=assigned`);
}

export async function setSnagPriority(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = setSnagPrioritySchema.safeParse({
    id: formData.get("id") ?? "",
    priority: formData.get("priority") ?? "",
  });
  if (!parsed.success) redirect(`/snags?error=bad_priority`);
  const { id, priority } = parsed.success
    ? parsed.data
    : { id: "", priority: "medium" as const };

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("snags" as never) as unknown as UpdateChain
  )
    .update({ priority }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[snags] priority update failed", error);
    redirect(`/snags/${id}?error=update_failed`);
  }
  if (!count) redirect(`/snags?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "snag.priority_changed",
    targetTable: "snags",
    targetId: id,
    metadata: { priority },
  });

  revalidatePath(`/snags/${id}`);
  redirect(`/snags/${id}?saved=priority`);
}

export async function deleteSnag(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!snagIdSchema.safeParse(id).success) redirect(`/snags?error=bad_id`);

  // Hard delete is admin-only. The RLS delete policy is is_org_admin(org_id);
  // re-enforce in code so a member gets a deterministic "forbidden" and we
  // never even attempt the attachment cleanup below for a non-admin. Mirrors
  // the compliance/tenant-attachments delete gate.
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/snags?error=forbidden`);
  }

  const tenant = await createClient();

  // Best-effort: remove this snag's photos first so we don't orphan them in the
  // tenant_attachments bucket. Reuses the universal delete (which re-checks the
  // admin role + count-gates each removal) rather than duplicating storage code.
  const { data: atts } = await (
    tenant.from("tenant_attachments" as never) as unknown as AttachmentIdsChain
  )
    .select("id")
    .eq("target_table", "snags")
    .eq("target_id", id)
    .eq("org_id", ctx.org.id);
  for (const a of atts ?? []) {
    await deleteTenantAttachment(a.id).catch(() => undefined);
  }

  const { error, count } = await (
    tenant.from("snags" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[snags] delete failed", error);
    redirect(`/snags?error=delete_failed`);
  }
  if (!count) redirect(`/snags?error=not_found`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "snag.deleted",
    targetTable: "snags",
    targetId: id,
    metadata: { org_id: ctx.org.id },
  });

  revalidatePath("/snags");
  redirect(`/snags?saved=deleted`);
}
