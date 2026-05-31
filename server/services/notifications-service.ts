import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  notificationCategoryForType,
  type NotificationRow,
  type NotificationCreate,
  type NotificationAudience,
} from "@/lib/notifications/types";

/**
 * CrewFlow — Notifications service (HQ-8).
 *
 * Two clients in use:
 *   * admin (service-role)   → cross-tenant reads/writes, HQ pages,
 *                              event helpers.
 *   * supabase (user JWT)    → customer-side reads/marks. RLS
 *                              enforces audience + org scope.
 *
 * Writes ALWAYS go through the admin client because most callers
 * are server actions that need to create rows targeted at users
 * outside the current session (HQ replying to a customer, etc.).
 */

// ---------------------------------------------------------------------
// Admin table helper (notifications + notification_email_queue aren't
// in the generated Supabase types yet — `as never` casts past).
// ---------------------------------------------------------------------

type AnyQuery = {
  eq: (k: string, v: unknown) => AnyQuery;
  in: (k: string, v: unknown[]) => AnyQuery;
  is: (k: string, v: unknown) => AnyQuery;
  not: (k: string, op: string, v: unknown) => AnyQuery;
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
  eq: (k: string, v: unknown) => AnyMutation &
    Promise<{ error: { message: string } | null }>;
};

function admin() {
  const c = createAdminClient();
  return c.from("notifications" as never) as unknown as {
    select: (cols: string, opts?: { count?: "exact"; head?: boolean }) => AnyQuery & Promise<{
      data: unknown[] | null;
      count: number | null;
      error: { message: string } | null;
    }>;
    insert: (payload: unknown) => Promise<{
      data: unknown | null;
      error: { message: string } | null;
    }> & { select: (cols?: string) => AnyQuery };
    update: (payload: unknown) => AnyMutation;
  };
}

// ---------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------

export async function createNotification(
  input: NotificationCreate,
): Promise<NotificationRow | null> {
  const payload = {
    org_id: input.org_id,
    user_id: input.user_id,
    audience: input.audience,
    type: input.type,
    category: input.category,
    title: input.title,
    body: input.body ?? null,
    priority: input.priority,
    source_module: input.source_module ?? null,
    source_id: input.source_id ?? null,
    action_url: input.action_url ?? null,
    metadata: input.metadata ?? {},
    // Legacy aliases — keeps the old NotificationsBell behaviour
    // and any existing readers working.
    related_table: input.source_module ?? null,
    related_id: input.source_id ?? null,
  };
  const res = await admin().insert(payload);
  if (res.error) {
    console.error("[notifications] createNotification failed", res.error.message);
    return null;
  }
  return (res.data as NotificationRow | null) ?? null;
}

export async function createBulkNotifications(
  inputs: ReadonlyArray<NotificationCreate>,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const rows = inputs.map((n) => ({
    org_id: n.org_id,
    user_id: n.user_id,
    audience: n.audience,
    type: n.type,
    category: n.category,
    title: n.title,
    body: n.body ?? null,
    priority: n.priority,
    source_module: n.source_module ?? null,
    source_id: n.source_id ?? null,
    action_url: n.action_url ?? null,
    metadata: n.metadata ?? {},
    related_table: n.source_module ?? null,
    related_id: n.source_id ?? null,
  }));
  const res = await admin().insert(rows);
  if (res.error) {
    console.error("[notifications] createBulkNotifications failed", res.error.message);
    return 0;
  }
  return rows.length;
}

/**
 * Best-effort wrapper used by the wire-points so a notification
 * failure NEVER breaks the primary action. The directive is firm:
 * "Real actions must create real notifications" — but if the
 * notification insert errors out, we log + swallow.
 */
export async function emitNotifications(
  inputs: NotificationCreate | ReadonlyArray<NotificationCreate>,
): Promise<void> {
  try {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    if (list.length === 0) return;
    await createBulkNotifications(list);
  } catch (e) {
    console.error(
      "[notifications] emitNotifications threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------------------------------------------------------------------
// READ — customer side (RLS-scoped via user JWT)
// ---------------------------------------------------------------------

const ALL_COLS =
  "id, org_id, user_id, audience, type, category, title, body, priority, source_module, source_id, action_url, read_at, dismissed_at, metadata, created_at, updated_at";

export async function getLatestNotificationsForCustomer(
  limit = 50,
): Promise<NotificationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications" as never)
    .select(ALL_COLS as never)
    .order("created_at" as never, { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[notifications] getLatestForCustomer failed", error);
    return [];
  }
  return ((data ?? []) as unknown as NotificationRow[]).map(coerce);
}

export async function getUnreadCountForCustomer(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications" as never)
    .select("id" as never, { count: "exact", head: true })
    .is("read_at" as never, null)
    .is("dismissed_at" as never, null);
  if (error) {
    console.error("[notifications] getUnreadCountForCustomer failed", error);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// READ — HQ side (service role, cross-tenant)
// ---------------------------------------------------------------------

export async function getLatestNotificationsForHq(
  limit = 200,
): Promise<NotificationRow[]> {
  const c = createAdminClient();
  const { data, error } = await c
    .from("notifications" as never)
    .select(
      `${ALL_COLS}, org:organizations ( name )` as never,
    )
    .in("audience" as never, ["hq", "both"])
    .order("created_at" as never, { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[notifications] getLatestForHq failed", error);
    return [];
  }
  return ((data ?? []) as unknown as Array<NotificationRow & { org?: { name?: string | null } | null }>).map((row) => {
    const out = coerce(row) as NotificationRow & {
      org_name?: string | null;
    };
    out.org_name = (row as { org?: { name?: string | null } | null }).org?.name ?? null;
    return out;
  });
}

export async function getUnreadCountForHq(): Promise<number> {
  const c = createAdminClient();
  const { count, error } = await c
    .from("notifications" as never)
    .select("id" as never, { count: "exact", head: true })
    .in("audience" as never, ["hq", "both"])
    .is("read_at" as never, null)
    .is("dismissed_at" as never, null);
  if (error) {
    console.error("[notifications] getUnreadCountForHq failed", error);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// MUTATE (read / dismiss / mark all read)
// ---------------------------------------------------------------------

export async function markNotificationRead(
  id: string,
  options: { audience?: NotificationAudience } = {},
): Promise<void> {
  // For HQ audience the user-JWT client can't update (RLS blocks
  // audience != customer|both). Use admin client when we know
  // the caller is HQ; default to user client for customers so
  // they only flip their own rows.
  const useAdmin = options.audience === "hq" || options.audience === "both";
  if (useAdmin) {
    const c = createAdminClient();
    await c
      .from("notifications" as never)
      .update({ read_at: new Date().toISOString() } as never)
      .eq("id" as never, id);
    return;
  }
  const supabase = await createClient();
  await supabase
    .from("notifications" as never)
    .update({ read_at: new Date().toISOString() } as never)
    .eq("id" as never, id);
}

export async function markAllNotificationsRead(
  scope: { audience: "customer" | "hq" },
): Promise<number> {
  const now = new Date().toISOString();
  if (scope.audience === "hq") {
    const c = createAdminClient();
    const { error } = await c
      .from("notifications" as never)
      .update({ read_at: now } as never)
      .in("audience" as never, ["hq", "both"])
      .is("read_at" as never, null);
    if (error) {
      console.error("[notifications] markAllForHq failed", error);
      return 0;
    }
    return 1;
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications" as never)
    .update({ read_at: now } as never)
    .is("read_at" as never, null);
  if (error) {
    console.error("[notifications] markAllForCustomer failed", error);
    return 0;
  }
  return 1;
}

export async function dismissNotification(
  id: string,
  options: { audience?: NotificationAudience } = {},
): Promise<void> {
  const useAdmin = options.audience === "hq" || options.audience === "both";
  const payload = { dismissed_at: new Date().toISOString() };
  if (useAdmin) {
    const c = createAdminClient();
    await c
      .from("notifications" as never)
      .update(payload as never)
      .eq("id" as never, id);
    return;
  }
  const supabase = await createClient();
  await supabase
    .from("notifications" as never)
    .update(payload as never)
    .eq("id" as never, id);
}

// ---------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------

function coerce(raw: unknown): NotificationRow {
  const r = raw as Record<string, unknown>;
  const type = (r.type as string) ?? "";
  const storedCategory = (r.category as NotificationRow["category"]) ?? "other";
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    user_id: (r.user_id as string | null) ?? null,
    audience: (r.audience as NotificationRow["audience"]) ?? "customer",
    type,
    // L1 — backfill the category for trigger-written invoice/payment rows
    // that defaulted to "other" (see notificationCategoryForType).
    category: notificationCategoryForType(type, storedCategory),
    title: (r.title as string) ?? "",
    body: (r.body as string | null) ?? null,
    priority: (r.priority as NotificationRow["priority"]) ?? "medium",
    source_module: (r.source_module as string | null) ?? null,
    source_id: (r.source_id as string | null) ?? null,
    action_url: (r.action_url as string | null) ?? null,
    read_at: (r.read_at as string | null) ?? null,
    dismissed_at: (r.dismissed_at as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    created_at: r.created_at as string,
    updated_at: (r.updated_at as string) ?? (r.created_at as string),
  };
}
