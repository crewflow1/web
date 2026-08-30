import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { queueNotificationEmail } from "@/lib/notifications/email";
import { resolveEmailRecipient } from "@/lib/notifications/email-routing";
import { resolveNotificationDelivery } from "@/lib/notifications/preferences";
import { enqueuePushForNotifications } from "@/lib/notifications/push";
import { enqueueSmsForNotifications } from "@/lib/notifications/sms";
import { getPreferencesForUserKeys } from "@/server/services/notification-preferences-service";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";

/** The legacy `related_id` alias column is uuid-typed; `source_id` is text.
 *  Mirroring a non-uuid source id (e.g. a retention-milestone slug like
 *  "first_customer") into it made Postgres reject the ENTIRE insert — the
 *  notification silently never existed (loud log only). Mirror only real
 *  uuids; legacy readers only ever consumed uuid references (the column type
 *  is the proof). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(v: string | null | undefined): string | null {
  return v != null && UUID_RE.test(v) ? v : null;
}

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
    // and any existing readers working. related_id is uuid-typed: mirror
    // only a real uuid (see uuidOrNull) or the whole insert is rejected.
    related_table: input.source_module ?? null,
    related_id: uuidOrNull(input.source_id),
  };
  const res = await admin().insert(payload);
  if (res.error) {
    console.error("[notifications] createNotification failed", res.error.message);
    return null;
  }
  return (res.data as NotificationRow | null) ?? null;
}

/**
 * The single insert path for the notification bus: inserts the rows AND
 * returns their persisted representation (with ids). The ids are what the
 * email bridge needs to populate notification_email_queue.notification_id,
 * so both `createBulkNotifications` and `emitNotifications` funnel through
 * here — one authoritative writer, no duplicated payload building.
 *
 * Best-effort: returns [] on error. A single insert statement is atomic,
 * so on success the returned rows align 1:1 (and in order) with `inputs`.
 */
async function insertNotificationsReturning(
  inputs: ReadonlyArray<NotificationCreate>,
): Promise<NotificationRow[]> {
  if (inputs.length === 0) return [];
  const payload = inputs.map((n) => ({
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
    // Legacy aliases — keeps the old NotificationsBell + any existing
    // readers working (mirror of createNotification's dual-write).
    // related_id is uuid-typed: mirror only a real uuid or Postgres rejects
    // the ENTIRE batch (how milestone notifications silently never landed).
    related_table: n.source_module ?? null,
    related_id: uuidOrNull(n.source_id),
  }));
  const c = createAdminClient();
  const { data, error } = await c
    .from("notifications" as never)
    .insert(payload as never)
    .select(ALL_COLS as never);
  if (error) {
    console.error(
      "[notifications] insertNotificationsReturning failed",
      (error as { message?: string }).message ?? String(error),
    );
    return [];
  }
  const list = (data as unknown as unknown[] | null) ?? [];
  return list.map(coerce);
}

export async function createBulkNotifications(
  inputs: ReadonlyArray<NotificationCreate>,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const rows = await insertNotificationsReturning(inputs);
  return rows.length;
}

/**
 * Best-effort wrapper used by the wire-points so a notification
 * failure NEVER breaks the primary action. The directive is firm:
 * "Real actions must create real notifications" — but if the
 * notification insert errors out, we log + swallow.
 *
 * This is also the ONE place the in-app bus bridges to the OTHER channels:
 *   * EMAIL — any input that opted in via its `email` directive is fanned out to
 *     notification_email_queue (drained → Resend by /api/cron/notifications-drain).
 *     Notifications without an `email` directive stay in-app-only — byte-for-byte
 *     the historical behaviour — so email is deliberate and per-notification.
 *   * WEB PUSH — every persisted row is offered to the push channel, which is
 *     DARK unless VAPID is configured AND the recipient has a subscription AND
 *     their per-category push preference is on (default on). It ENQUEUES onto
 *     push_deliveries (network-free); /api/cron/push-drain dispatches it.
 *   * SMS — Twilio-gated, refuse-before-send. It ENQUEUES onto sms_deliveries
 *     (network-free): org-wide rows fan out to each member with a usable phone,
 *     honouring the per-category sms_enabled opt-in; /api/cron/sms-drain
 *     dispatches via the Twilio transport. DARK unless Twilio is configured
 *     (getSmsProvider), in which case nothing is enqueued and nothing is sent.
 * All three bridges are best-effort: a channel failure NEVER breaks the primary
 * action or the other channels.
 */
export async function emitNotifications(
  inputs: NotificationCreate | ReadonlyArray<NotificationCreate>,
): Promise<void> {
  try {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    if (list.length === 0) return;
    const rows = await insertNotificationsReturning(list);
    await queueEmailsForNotifications(list, rows);
    // Push + SMS are keyed off the PERSISTED rows (not the email opt-in
    // directive): they follow the per-user channel preference, not a per-
    // notification flag. Isolated so one channel's failure can't take the others
    // (or the primary action) down.
    await Promise.allSettled([
      enqueuePushForNotifications(rows),
      enqueueSmsForNotifications(rows),
    ]);
  } catch (e) {
    console.error(
      "[notifications] emitNotifications threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * The notification→email bridge. For every input that carried an opt-in
 * `email` directive, resolve a recipient (via the pure `resolveEmailRecipient`)
 * and enqueue a row on notification_email_queue. Best-effort throughout: a
 * resolution or queue failure for one row NEVER blocks the others and NEVER
 * bubbles out of the caller's primary action.
 *
 * A single insert is atomic, so on success `rows` aligns 1:1 and in order
 * with `inputs`; if the lengths ever disagree we skip email entirely rather
 * than risk mis-addressing a notification.
 */
async function queueEmailsForNotifications(
  inputs: ReadonlyArray<NotificationCreate>,
  rows: ReadonlyArray<NotificationRow>,
): Promise<void> {
  if (inputs.length === 0 || inputs.length !== rows.length) return;

  const pendingAll = inputs
    .map((input, i) => ({ input, row: rows[i] as NotificationRow }))
    .filter((p) => p.input.email != null);
  if (pendingAll.length === 0) return;

  // PER-USER PREFERENCE HONORING. For notifications DIRECTED AT a specific user
  // (row.user_id set), consult that user's stored preference before queueing an
  // immediate email: an opt-out suppresses it, a digest cadence defers it to the
  // notifications-digest cron, and immediate/critical falls through unchanged.
  // ORG-WIDE notifications (user_id null) are left exactly as before — there is
  // no single user to key a preference on, and the digest cron handles their
  // per-user fan-out via each member's own cursor. The critical floor
  // (money/security category or urgent priority) always sends, whatever the
  // preference — enforced in resolveNotificationDelivery.
  const userKeys = pendingAll
    .filter((p) => p.row.user_id != null)
    .map((p) => ({ org_id: p.row.org_id, user_id: p.row.user_id as string }));
  const prefIndex =
    userKeys.length > 0
      ? await getPreferencesForUserKeys(userKeys)
      : new Map();

  const pending = pendingAll.filter(({ row }) => {
    if (row.user_id == null) return true; // org-wide: unchanged behaviour
    const pref =
      prefIndex.get(`${row.org_id}::${row.user_id}::${row.category}`) ?? null;
    const decision = resolveNotificationDelivery({
      category: row.category,
      priority: row.priority,
      preference: pref,
    });
    // Only an IMMEDIATE decision queues here; 'off' suppresses and 'digest'
    // is picked up by the digest cron.
    return decision.email === "immediate";
  });
  if (pending.length === 0) return;

  // One roster read for all opted-in orgs in this emit — not one per row.
  const orgEmails = await fetchOrgEmails(
    Array.from(new Set(pending.map((p) => p.row.org_id))),
  );

  for (const { input, row } of pending) {
    try {
      const recipient = resolveEmailRecipient({
        directive: input.email,
        audience: row.audience,
        orgEmail: orgEmails.get(row.org_id) ?? null,
      });
      if (!recipient) continue;
      await queueNotificationEmail({
        notification: row,
        to_email: recipient.to,
        reply_to_email: recipient.replyTo,
      });
    } catch (e) {
      console.error(
        "[notifications] queueEmailsForNotifications row failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

/**
 * Resolve org id → contact email (`organizations.email`) for the given
 * ids in a single service-role read. Missing/errored reads degrade to an
 * empty map so the bridge simply skips those rows (in-app still fired).
 */
async function fetchOrgEmails(
  orgIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (orgIds.length === 0) return out;
  const c = createAdminClient();
  // PAGED (F-1): a cross-org emit (e.g. an estate-wide broadcast) can resolve
  // emails for >1000 orgs in one `.in(id)` read; a max_rows=1000 clamp would
  // silently drop recipients so those orgs never receive the email. Stable
  // total order on the unique `id`.
  type OrgEmailRow = { id: string; email: string | null };
  const { data, error } = await fetchAllRows<OrgEmailRow>(
    (from, to) =>
      c
        .from("organizations")
        .select("id, email")
        .in("id", orgIds)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<OrgEmailRow>>,
  );
  if (error) {
    console.error("[notifications] fetchOrgEmails failed", (error as { message?: string }).message ?? String(error));
    return out;
  }
  for (const r of data) {
    out.set(r.id, r.email ?? null);
  }
  return out;
}

// ---------------------------------------------------------------------
// READ — customer side (RLS-gated via user JWT, pinned to the ACTIVE org)
// ---------------------------------------------------------------------
//
// RLS is the OUTER boundary, not the scope: `current_org_ids()` returns EVERY
// org the viewer belongs to, so an RLS-only read put the OTHER company's alerts
// (and their deep links into that company's records) in this org's notification
// centre and unread badge. The caller passes the ACTIVE org explicitly.

const ALL_COLS =
  "id, org_id, user_id, audience, type, category, title, body, priority, source_module, source_id, action_url, read_at, dismissed_at, metadata, created_at, updated_at";

export async function getLatestNotificationsForCustomer(
  orgId: string,
): Promise<NotificationRow[]> {
  const supabase = await createClient();
  // F-1: page the FULL set (fetchAllRows, created_at desc + id tiebreaker). The
  // notifications centre derives its unread badge from `.length` of this set, so
  // the previous `.limit(Math.min(limit,1000))` UNDER-counted the badge and hid
  // older notifications the moment the active org crossed the cap. There is no
  // "load more" here, so a capped read is not a paginated feed — it is a
  // truncated one; the complete read makes every derived count exact.
  const { data, error } = await fetchAllRows<NotificationRow>(
    (from, to) =>
      supabase
        .from("notifications" as never)
        .select(ALL_COLS as never)
        .eq("org_id" as never, orgId as never)
        .order("created_at" as never, { ascending: false })
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<NotificationRow>>,
  );
  if (error) {
    console.error("[notifications] getLatestForCustomer failed", error);
    return [];
  }
  return (data as unknown as NotificationRow[]).map(coerce);
}

export async function getUnreadCountForCustomer(orgId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications" as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("org_id" as never, orgId as never)
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

export async function getLatestNotificationsForHq(): Promise<NotificationRow[]> {
  const c = createAdminClient();
  // F-1: page the FULL set (fetchAllRows, created_at desc + id tiebreaker). The
  // HQ notifications page derives EVERY headline number from `.length` on this
  // set — the urgent/high unread tiles, the 24h count AND the org-filter
  // dropdown (distinct orgs) — plus the cross-tenant list itself. A capped 500
  // silently under-counted all of them and dropped orgs from the dropdown once
  // the estate's hq/both backlog crossed the cap. Complete read = exact tiles.
  type HqRow = NotificationRow & { org?: { name?: string | null } | null };
  const { data, error } = await fetchAllRows<HqRow>(
    (from, to) =>
      c
        .from("notifications" as never)
        .select(`${ALL_COLS}, org:organizations ( name )` as never)
        .in("audience" as never, ["hq", "both"])
        .order("created_at" as never, { ascending: false })
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<HqRow>>,
  );
  if (error) {
    console.error("[notifications] getLatestForHq failed", error);
    return [];
  }
  return (data as unknown as Array<NotificationRow & { org?: { name?: string | null } | null }>).map((row) => {
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

/**
 * ACTIVE-ORG SCOPE for the tenant-side (customer-audience) mutations.
 *
 * These run on the user-JWT client, and the comment below used to reason that
 * this meant customers "only flip their own rows". RLS does not deliver that:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so for a user
 * who belongs to two orgs the tenant client happily updates the other org's
 * notification rows. Callers in `app/(app)/notifications/actions.ts` pass
 * `ctx.org.id`, making the predicate visible at the call site.
 *
 * Deliberately optional and deliberately NOT applied to the admin-client
 * branches: `app/admin/notifications/**` is HQ-internal, operates across all
 * orgs by design, and has no tenant org context to supply.
 */
type MutateOptions = { audience?: NotificationAudience; orgId?: string };

export async function markNotificationRead(
  id: string,
  options: MutateOptions = {},
): Promise<void> {
  // For HQ audience the user-JWT client can't update (RLS blocks
  // audience != customer|both). Use admin client when we know
  // the caller is HQ; default to user client for customers.
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
  const q = supabase
    .from("notifications" as never)
    .update({ read_at: new Date().toISOString() } as never)
    .eq("id" as never, id);
  await (options.orgId ? q.eq("org_id" as never, options.orgId) : q);
}

export async function markAllNotificationsRead(
  scope: { audience: "customer" | "hq"; orgId?: string },
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
  // The widest write in this file: no id, no org filter — one click marked
  // EVERY unread notification read across EVERY org the viewer belonged to,
  // silently clearing another org's unread queue. `orgId` confines it.
  const q = supabase
    .from("notifications" as never)
    .update({ read_at: now } as never)
    .is("read_at" as never, null);
  const { error } = await (scope.orgId
    ? q.eq("org_id" as never, scope.orgId)
    : q);
  if (error) {
    console.error("[notifications] markAllForCustomer failed", error);
    return 0;
  }
  return 1;
}

export async function dismissNotification(
  id: string,
  options: MutateOptions = {},
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
  const q = supabase
    .from("notifications" as never)
    .update(payload as never)
    .eq("id" as never, id);
  await (options.orgId ? q.eq("org_id" as never, options.orgId) : q);
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
