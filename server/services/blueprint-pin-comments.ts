import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  createPinCommentSchema,
  type PinComment,
  type CreatePinCommentInput,
} from "@/lib/blueprints/pin-comments";

/**
 * Blueprint Pin Comments service (P2 pins wave).
 *
 * Threaded discussion on a pin. All writes go through the TENANT client so RLS
 * scopes them and the before-write DB trigger derives org_id from the parent
 * pin (client-sent tenancy is ignored). Reads are pinned to the ACTIVE org (not
 * merely RLS-scoped): current_org_ids() admits every org a dual-org member
 * belongs to, so an RLS-only read of a foreign pin id would surface the other
 * company's discussion. Same class as the pins service reads (#456/#463).
 *
 * F-1: the thread is read with fetchAllRows so a long discussion is never
 * silently clipped at the PostgREST row cap.
 */

export type CommentResult<T = { id: string }> = { ok: true; data: T } | { ok: false; error: string };

type CommentRow = {
  id: string; pin_id: string; parent_comment_id: string | null;
  body: string; author_id: string | null; created_at: string;
};

// Minimal structural view of the tenant client (blueprint_pin_comments is not
// in the generated types). Mirrors blueprint-pins.ts.
type Chain = PromiseLike<{ data: Record<string, unknown>[] | null; error: SupabaseReadError | null }> & {
  eq: (k: string, v: unknown) => Chain;
  in: (k: string, v: unknown[]) => Chain;
  order: (k: string, o: { ascending: boolean }) => Chain;
  range: (from: number, to: number) => Chain;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: SupabaseReadError | null }>;
};
type Mutation = PromiseLike<{ error: { message: string } | null; count: number | null }> & {
  eq: (k: string, v: unknown) => Mutation;
};
type CommentClient = {
  from: (t: string) => {
    select: (c: string) => Chain;
    insert: (r: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
    delete: (o: { count: string }) => Mutation;
  };
};
const cc = (c: Awaited<ReturnType<typeof createClient>>) => c as unknown as CommentClient;

/** Assert a pin exists in the ACTIVE org; returns the pin id or null. */
async function pinInActiveOrg(supabase: CommentClient, pinId: string, orgId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("blueprint_pins")
    .select("id")
    .eq("id", pinId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("blueprint-pin-comments: pin scope check", error);
  return !!data;
}

/**
 * The full thread for a pin (oldest first, id-tiebroken for a stable page
 * boundary), with each author's display name joined in ONE batched query.
 */
export async function listPinComments(pinId: string): Promise<PinComment[]> {
  const { ctx } = await requireOrgContext();
  const supabase = cc(await createClient());

  // Scope the pin to the active org BEFORE reading its thread — a foreign pin id
  // must never surface another org's discussion.
  if (!(await pinInActiveOrg(supabase, pinId, ctx.org.id))) return [];

  const { data, error } = await fetchAllRows<CommentRow>((from, to) =>
    supabase
      .from("blueprint_pin_comments")
      .select("id, pin_id, parent_comment_id, body, author_id, created_at")
      .eq("org_id", ctx.org.id)
      .eq("pin_id", pinId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<CommentRow>>,
  );
  if (error) throw readFailure("blueprint-pin-comments: thread", error as SupabaseReadError);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.filter((r) => r.author_id).map((r) => r.author_id as string))];
  const nameById = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: users } = await supabase
      .from("users")
      .select("id, full_name, email")
      .in("id", authorIds);
    for (const u of (users ?? []) as unknown as { id: string; full_name: string | null; email: string | null }[]) {
      nameById.set(u.id, u.full_name || u.email || "Member");
    }
  }

  return rows.map((r) => ({
    id: r.id, pin_id: r.pin_id, parent_comment_id: r.parent_comment_id,
    body: r.body, author_id: r.author_id, created_at: r.created_at,
    author_name: r.author_id ? nameById.get(r.author_id) ?? null : null,
  }));
}

/** Post a comment (or reply) on a pin. */
export async function createPinComment(raw: CreatePinCommentInput): Promise<CommentResult> {
  const parsed = createPinCommentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid comment." };
  const { ctx, user } = await requireOrgContext();
  const supabase = cc(await createClient());

  // Scope the pin to the active org before writing — RLS + the trigger both
  // guard tenancy, but this yields a clean error instead of a DB rejection when
  // a member targets a pin outside their active org.
  if (!(await pinInActiveOrg(supabase, parsed.data.pin_id, ctx.org.id))) {
    return { ok: false, error: "That pin no longer exists." };
  }

  const { data, error } = await supabase
    .from("blueprint_pin_comments")
    .insert({
      pin_id: parsed.data.pin_id,
      parent_comment_id: parsed.data.parent_comment_id ?? null,
      body: parsed.data.body,
      author_id: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: friendly(error?.message) };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin_comment.created",
    targetTable: "blueprint_pin_comments", targetId: data.id,
    metadata: { pin_id: parsed.data.pin_id, org_id: ctx.org.id, is_reply: !!parsed.data.parent_comment_id },
  });
  return { ok: true, data };
}

/**
 * Delete a comment. RLS allows the AUTHOR or an org admin; the count gate turns
 * an RLS refusal (a member deleting someone else's comment) into a deterministic
 * "not allowed" instead of a silent no-op success. Replies cascade in the DB.
 */
export async function deletePinComment(commentId: string): Promise<CommentResult> {
  const { ctx, user } = await requireOrgContext();
  const supabase = cc(await createClient());
  const { error, count } = await supabase
    .from("blueprint_pin_comments")
    .delete({ count: "exact" })
    .eq("id", commentId)
    .eq("org_id", ctx.org.id);
  if (error) return { ok: false, error: friendly(error.message) };
  if (!count) return { ok: false, error: "You can only delete your own comments." };
  await recordAdminActivity({
    actorId: user.id, actorEmail: user.email ?? null, action: "blueprint_pin_comment.deleted",
    targetTable: "blueprint_pin_comments", targetId: commentId, metadata: { org_id: ctx.org.id },
  });
  return { ok: true, data: { id: commentId } };
}

function friendly(dbMessage?: string): string {
  if (!dbMessage) return "Couldn't save the comment.";
  if (dbMessage.includes("same pin")) return "That reply target is on a different pin.";
  if (dbMessage.includes("does not exist") || dbMessage.includes("foreign key")) return "That pin or comment no longer exists.";
  return "Couldn't save the comment.";
}
