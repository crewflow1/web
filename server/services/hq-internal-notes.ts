import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { InternalNoteRow } from "@/lib/hq/internal-notes";

/**
 * CrewFlow HQ — Internal Notes service (HQ-9).
 *
 * Service-role only. Every caller MUST have confirmed
 * isSuperAdminEmail before invoking. RLS on internal_notes has zero
 * policies so the user-JWT client can never read these rows.
 */

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  is: (k: string, v: unknown) => AnyQuery;
  order: (k: string, opts: { ascending: boolean }) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  limit: (n: number) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
  }> & AnyQuery;
  maybeSingle: () => Promise<{
    data: unknown | null;
    error: { message: string } | null;
  }>;
};

type AnyMutation = {
  eq: (k: string, v: unknown) => Promise<{
    error: { message: string } | null;
    data: unknown | null;
  }> & {
    select: (cols?: string) => {
      maybeSingle: () => Promise<{
        data: unknown | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function table(name: string) {
  const c = createAdminClient();
  return c.from(name as never) as unknown as {
    select: (cols: string) => AnyQuery;
    insert: (payload: unknown) => Promise<{
      data: unknown | null;
      error: { message: string } | null;
    }> & {
      select: (cols?: string) => {
        single: () => Promise<{
          data: unknown | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (payload: unknown) => AnyMutation;
    delete: () => AnyMutation;
  };
}

const ALL_COLS =
  "id, org_id, author_user_id, author_email, title, body, category, priority, pinned, archived_at, created_at, updated_at";

// ---------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------

export type CreateInternalNoteInput = {
  org_id: string;
  author_user_id: string;
  author_email: string;
  title?: string | null;
  body: string;
  category: string;
  priority: string;
  pinned?: boolean;
};

export async function createInternalNote(
  input: CreateInternalNoteInput,
): Promise<InternalNoteRow | null> {
  const payload = {
    org_id: input.org_id,
    author_user_id: input.author_user_id,
    author_email: input.author_email,
    title: input.title ?? null,
    body: input.body,
    category: input.category,
    priority: input.priority,
    pinned: input.pinned ?? false,
  };
  const ins = await table("internal_notes")
    .insert(payload)
    .select(ALL_COLS)
    .single();
  if (ins.error) {
    console.error("[internal-notes] createInternalNote failed", ins.error.message);
    return null;
  }
  return ins.data as InternalNoteRow | null;
}

// ---------------------------------------------------------------------
// UPDATE / ARCHIVE / PIN
// ---------------------------------------------------------------------

export type UpdateInternalNoteInput = {
  id: string;
  title?: string | null;
  body?: string;
  category?: string;
  priority?: string;
  pinned?: boolean;
};

export async function updateInternalNote(
  input: UpdateInternalNoteInput,
): Promise<InternalNoteRow | null> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  if (input.category !== undefined) patch.category = input.category;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.pinned !== undefined) patch.pinned = input.pinned;
  if (Object.keys(patch).length === 0) return null;
  const upd = await table("internal_notes")
    .update(patch)
    .eq("id", input.id)
    .select(ALL_COLS)
    .maybeSingle();
  if (upd.error) {
    console.error("[internal-notes] updateInternalNote failed", upd.error.message);
    return null;
  }
  return upd.data as InternalNoteRow | null;
}

export async function archiveInternalNote(id: string): Promise<void> {
  const r = await table("internal_notes")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (r.error) {
    console.error("[internal-notes] archive failed", r.error.message);
  }
}

export async function unarchiveInternalNote(id: string): Promise<void> {
  const r = await table("internal_notes")
    .update({ archived_at: null })
    .eq("id", id);
  if (r.error) {
    console.error("[internal-notes] unarchive failed", r.error.message);
  }
}

export async function pinInternalNote(
  id: string,
  pinned: boolean,
): Promise<void> {
  const r = await table("internal_notes")
    .update({ pinned })
    .eq("id", id);
  if (r.error) {
    console.error("[internal-notes] pin failed", r.error.message);
  }
}

// ---------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------

export async function listInternalNotesForOrg(
  orgId: string,
  options: { include_archived?: boolean } = {},
): Promise<InternalNoteRow[]> {
  const c = createAdminClient();
  let q = c
    .from("internal_notes" as never)
    .select(ALL_COLS as never)
    .eq("org_id" as never, orgId)
    .order("pinned" as never, { ascending: false })
    .order("created_at" as never, { ascending: false });
  if (!options.include_archived) {
    // PostgREST is filter, not OR — explicit IS NULL filter.
    q = q.is("archived_at" as never, null);
  }
  const { data, error } = await q;
  if (error) {
    console.error("[internal-notes] listForOrg failed", error.message);
    return [];
  }
  return (data ?? []) as InternalNoteRow[];
}

export async function listAllInternalNotesForHQ(
  options: { include_archived?: boolean; limit?: number } = {},
): Promise<InternalNoteRow[]> {
  const c = createAdminClient();
  let q = c
    .from("internal_notes" as never)
    .select(
      `${ALL_COLS}, org:organizations ( name )` as never,
    )
    .order("pinned" as never, { ascending: false })
    .order("created_at" as never, { ascending: false })
    // F-1: bounded sample — cap provably (PostgREST clamps every read to 1000).
    .limit(Math.min(options.limit ?? 500, 500));
  if (!options.include_archived) {
    q = q.is("archived_at" as never, null);
  }
  const { data, error } = await q;
  if (error) {
    console.error("[internal-notes] listForHQ failed", error.message);
    return [];
  }
  type RawRow = InternalNoteRow & { org?: { name?: string | null } | null };
  return ((data ?? []) as unknown as RawRow[]).map((r) => ({
    ...r,
    org_name: r.org?.name ?? null,
  }));
}

export async function countPinnedNotes(): Promise<number> {
  const c = createAdminClient();
  const { count, error } = await c
    .from("internal_notes" as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("pinned" as never, true)
    .is("archived_at" as never, null);
  if (error) {
    console.error("[internal-notes] countPinned failed", error.message);
    return 0;
  }
  return count ?? 0;
}

export async function loadInternalNoteById(
  id: string,
): Promise<InternalNoteRow | null> {
  const c = createAdminClient();
  const { data, error } = await c
    .from("internal_notes" as never)
    .select(`${ALL_COLS}, org:organizations ( name )` as never)
    .eq("id" as never, id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as InternalNoteRow & {
    org?: { name?: string | null } | null;
  };
  return { ...row, org_name: row.org?.name ?? null };
}
