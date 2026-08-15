import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { queueDigestEmail } from "@/lib/notifications/email";
import {
  buildDigestEmail,
  type DigestNotification,
  type NotificationCadence,
  type NotificationPreference,
} from "@/lib/notifications/preferences";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/types";

/**
 * CrewFlow — Notification preferences service (P3).
 *
 * Two clients, exactly like notifications-service.ts:
 *   * supabase (user JWT)  → the settings UI read/upsert; RLS enforces
 *                            own-row + org scope (see the migration).
 *   * admin (service-role) → the sender-honoring bulk read and the digest cron,
 *                            which act across users the current session isn't.
 *
 * The DECISION logic (which channels, immediate vs digest, the critical floor)
 * lives in the pure lib/notifications/preferences.ts. This module is the IO half.
 */

const PREF_COLS =
  "org_id, user_id, category, in_app_enabled, email_enabled, email_cadence";

function coercePref(raw: unknown): NotificationPreference {
  const r = raw as Record<string, unknown>;
  const cadence = r.email_cadence as string;
  return {
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    category: r.category as string,
    in_app_enabled: (r.in_app_enabled as boolean) ?? true,
    email_enabled: (r.email_enabled as boolean) ?? true,
    email_cadence: (["immediate", "daily", "weekly"].includes(cadence)
      ? cadence
      : "immediate") as NotificationCadence,
  };
}

// ---------------------------------------------------------------------
// SETTINGS UI — read + upsert (user-JWT, RLS-gated, own rows only)
// ---------------------------------------------------------------------

/**
 * Read the caller's own preference rows for one org. RLS restricts this to
 * `user_id = auth.uid()` within an org they belong to. Returns [] on error
 * (the UI fills defaults over the canonical category list).
 */
export async function getPreferencesForUser(
  orgId: string,
  userId: string,
): Promise<NotificationPreference[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notification_preferences" as never)
    .select(PREF_COLS as never)
    .eq("org_id" as never, orgId as never)
    .eq("user_id" as never, userId as never);
  if (error) {
    console.error("[notif-prefs] getPreferencesForUser failed", error);
    return [];
  }
  return ((data as unknown as unknown[]) ?? []).map(coercePref);
}

export type PreferenceInput = {
  category: NotificationCategory;
  in_app_enabled: boolean;
  email_enabled: boolean;
  email_cadence: NotificationCadence;
};

/**
 * Upsert the caller's preferences for one org, one category at a time or in
 * bulk. Runs on the USER JWT so the RLS own-row + org policies are the real
 * boundary; `user_id`/`org_id` are pinned from the authenticated context by the
 * caller (the server action), never from client input. Returns true on success.
 */
export async function upsertPreferencesForUser(
  orgId: string,
  userId: string,
  inputs: ReadonlyArray<PreferenceInput>,
): Promise<boolean> {
  if (inputs.length === 0) return true;
  const supabase = await createClient();
  const rows = inputs.map((i) => ({
    org_id: orgId,
    user_id: userId,
    category: i.category,
    in_app_enabled: i.in_app_enabled,
    email_enabled: i.email_enabled,
    email_cadence: i.email_cadence,
  }));
  const { error } = await supabase
    .from("notification_preferences" as never)
    .upsert(rows as never, {
      onConflict: "org_id,user_id,category",
    } as never);
  if (error) {
    console.error("[notif-prefs] upsertPreferencesForUser failed", error);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// SENDER HONORING — bulk read for the immediate email bridge (service role)
// ---------------------------------------------------------------------

/**
 * Bulk-read preferences for a set of (org_id, user_id) pairs, service-role, so
 * the immediate email bridge in notifications-service can honor per-user
 * opt-outs / digest choices for user-directed notifications. Returns a map keyed
 * `org_id::user_id::category` → row. Missing entries = no preference (default).
 */
export async function getPreferencesForUserKeys(
  keys: ReadonlyArray<{ org_id: string; user_id: string }>,
): Promise<Map<string, NotificationPreference>> {
  const out = new Map<string, NotificationPreference>();
  if (keys.length === 0) return out;
  const orgIds = Array.from(new Set(keys.map((k) => k.org_id)));
  const userIds = Array.from(new Set(keys.map((k) => k.user_id)));
  const wanted = new Set(keys.map((k) => `${k.org_id}::${k.user_id}`));

  const c = createAdminClient();
  const { data, error } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      c
        .from("notification_preferences" as never)
        .select(PREF_COLS as never)
        .in("org_id" as never, orgIds as never)
        .in("user_id" as never, userIds as never)
        .order("org_id" as never, { ascending: true })
        .order("user_id" as never, { ascending: true })
        .order("category" as never, {
          ascending: true,
        }) as unknown as PromiseLike<PageResult<Record<string, unknown>>>,
  );
  if (error) {
    console.error("[notif-prefs] getPreferencesForUserKeys failed", error);
    return out;
  }
  for (const raw of data) {
    const p = coercePref(raw);
    // Guard against the cartesian product of the two `.in()` filters — keep only
    // rows for a (org,user) pair we actually asked for.
    if (!wanted.has(`${p.org_id}::${p.user_id}`)) continue;
    out.set(`${p.org_id}::${p.user_id}::${p.category}`, p);
  }
  return out;
}

// ---------------------------------------------------------------------
// DIGEST CRON (service role)
// ---------------------------------------------------------------------

/** The two batched cadences the digest cron handles (immediate is not batched). */
type DigestCadence = "daily" | "weekly";

export type DigestRunResult = {
  cadences: DigestCadence[];
  usersConsidered: number;
  digestsQueued: number;
  notificationsBatched: number;
  skippedEmpty: number;
  errors: string[];
  durationMs: number;
};

/** Which weekday (UTC, 0=Sun … 1=Mon) weekly digests fire on. */
const WEEKLY_DIGEST_DOW = 1; // Monday
/** New-user lookback when there is no cursor yet, per cadence. */
const DAILY_LOOKBACK_MS = 26 * 60 * 60 * 1000; // ~1 day + slack
const WEEKLY_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000; // ~1 week + slack
/** Fairness + safety bounds for a single pass. */
const MAX_USERS_PER_PASS = 500;
const MAX_NOTIFS_PER_DIGEST = 200;

type UserCadenceCategories = {
  org_id: string;
  user_id: string;
  daily: Set<string>;
  weekly: Set<string>;
};

/**
 * Run one digest pass. For each user who has opted a category into a daily /
 * weekly cadence, batch every digest-eligible notification created since their
 * per-cadence cursor into ONE email and enqueue it on the shared
 * notification_email_queue (drained → Resend by notifications-drain). Then
 * advance the cursor so a notification is digested exactly once.
 *
 * Network-free per user (only DB reads + queue inserts) and self-draining
 * (advancing each cursor removes those notifications from the next pass) — see
 * the cron-fairness allowlist entry.
 */
export async function runNotificationDigest(
  now: Date = new Date(),
): Promise<DigestRunResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const weeklyDue = now.getUTCDay() === WEEKLY_DIGEST_DOW;
  const cadences: DigestCadence[] = weeklyDue ? ["daily", "weekly"] : ["daily"];

  const c = createAdminClient();

  // (1) The candidate universe: every digest-eligible preference row.
  const { data: prefRows, error: prefErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("notification_preferences" as never)
        .select("org_id, user_id, category, email_cadence" as never)
        .eq("email_enabled" as never, true as never)
        .in("email_cadence" as never, ["daily", "weekly"] as never)
        .order("org_id" as never, { ascending: true })
        .order("user_id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (prefErr) {
    return {
      cadences,
      usersConsidered: 0,
      digestsQueued: 0,
      notificationsBatched: 0,
      skippedEmpty: 0,
      errors: [String((prefErr as { message?: string }).message ?? prefErr)],
      durationMs: Date.now() - startedAt,
    };
  }

  // (2) Group into per-user cadence category sets.
  const byUser = new Map<string, UserCadenceCategories>();
  for (const raw of prefRows) {
    const org_id = raw.org_id as string;
    const user_id = raw.user_id as string;
    const category = raw.category as string;
    const cadence = raw.email_cadence as string;
    const key = `${org_id}::${user_id}`;
    let u = byUser.get(key);
    if (!u) {
      u = { org_id, user_id, daily: new Set(), weekly: new Set() };
      byUser.set(key, u);
    }
    if (cadence === "daily") u.daily.add(category);
    else if (cadence === "weekly") u.weekly.add(category);
  }

  if (byUser.size === 0) {
    return {
      cadences,
      usersConsidered: 0,
      digestsQueued: 0,
      notificationsBatched: 0,
      skippedEmpty: 0,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  const users = Array.from(byUser.values());

  // (3) Bulk-read cursors + user emails for fairness ordering and delivery.
  const orgIds = Array.from(new Set(users.map((u) => u.org_id)));
  const userIds = Array.from(new Set(users.map((u) => u.user_id)));
  const cursors = await fetchCursors(c, orgIds, userIds);
  const emails = await fetchUserEmails(c, userIds);

  // (4) Fairness: process the STALEST cursors first (nullsFirst = never-sent),
  // bounded per pass so a huge roster can't blow the function budget. Use each
  // user's oldest cursor across cadences as the sort key.
  const cursorMs = (u: UserCadenceCategories): number => {
    const d = cursors.get(`${u.org_id}::${u.user_id}::daily`);
    const w = cursors.get(`${u.org_id}::${u.user_id}::weekly`);
    const vals = [d, w].filter((x): x is number => x != null);
    return vals.length ? Math.min(...vals) : -1; // -1 = never sent → first
  };
  users.sort((a, b) => cursorMs(a) - cursorMs(b));
  const pass = users.slice(0, MAX_USERS_PER_PASS);

  let digestsQueued = 0;
  let notificationsBatched = 0;
  let skippedEmpty = 0;

  for (const u of pass) {
    const email = emails.get(u.user_id);
    if (!email?.to) {
      // No deliverable address → don't advance the cursor (retry next pass once
      // the user has an email), just skip.
      continue;
    }
    for (const cadence of cadences) {
      const categories = cadence === "daily" ? u.daily : u.weekly;
      if (categories.size === 0) continue;
      try {
        const queued = await processUserCadence(c, {
          org_id: u.org_id,
          user_id: u.user_id,
          cadence,
          categories,
          toEmail: email.to,
          recipientName: email.name,
          cursorMs: cursors.get(`${u.org_id}::${u.user_id}::${cadence}`) ?? null,
          now,
        });
        if (queued.queued) {
          digestsQueued++;
          notificationsBatched += queued.count;
        } else {
          skippedEmpty++;
        }
      } catch (e) {
        errors.push(
          `${u.user_id}/${cadence}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  return {
    cadences,
    usersConsidered: pass.length,
    digestsQueued,
    notificationsBatched,
    skippedEmpty,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Process ONE (user, cadence): gather notifications since the cursor, compose +
 * enqueue a digest, and advance the cursor. Advancing the cursor even on an
 * empty batch is DELIBERATE — it keeps the window from growing unbounded and,
 * because empty batches queue nothing, is harmless. Returns whether an email was
 * queued and how many notifications it carried.
 */
async function processUserCadence(
  c: ReturnType<typeof createAdminClient>,
  args: {
    org_id: string;
    user_id: string;
    cadence: "daily" | "weekly";
    categories: Set<string>;
    toEmail: string;
    recipientName: string | null;
    cursorMs: number | null;
    now: Date;
  },
): Promise<{ queued: boolean; count: number }> {
  const {
    org_id,
    user_id,
    cadence,
    categories,
    toEmail,
    recipientName,
    cursorMs,
    now,
  } = args;

  const lookback = cadence === "daily" ? DAILY_LOOKBACK_MS : WEEKLY_LOOKBACK_MS;
  const windowStart =
    cursorMs != null
      ? new Date(cursorMs).toISOString()
      : new Date(now.getTime() - lookback).toISOString();

  // Digest-eligible notifications: this org, since the window, not dismissed,
  // audience customer/both (in-app tenant feed), in the opted categories, and
  // either org-wide (user_id null) OR directed at this user.
  const { data, error } = await c
    .from("notifications" as never)
    .select(
      "id, category, title, body, priority, action_url, created_at, user_id" as never,
    )
    .eq("org_id" as never, org_id as never)
    .in("audience" as never, ["customer", "both"] as never)
    .in("category" as never, Array.from(categories) as never)
    .is("dismissed_at" as never, null)
    .gt("created_at" as never, windowStart)
    .order("created_at" as never, { ascending: true })
    .limit(MAX_NOTIFS_PER_DIGEST);
  if (error) {
    throw new Error(
      `notifications read: ${(error as { message?: string }).message ?? String(error)}`,
    );
  }

  const rows = ((data as unknown as Array<Record<string, unknown>>) ?? []).filter(
    (r) => {
      const uid = (r.user_id as string | null) ?? null;
      return uid === null || uid === user_id;
    },
  );

  const notifications: DigestNotification[] = rows.map((r) => ({
    id: r.id as string,
    category: r.category as string,
    title: (r.title as string) ?? "",
    body: (r.body as string | null) ?? null,
    priority: (r.priority as string) ?? "medium",
    action_url: (r.action_url as string | null) ?? null,
    created_at: r.created_at as string,
  }));

  let queued = false;
  let count = 0;
  const composed = buildDigestEmail({ cadence, notifications, recipientName });
  if (composed) {
    const res = await queueDigestEmail({
      org_id,
      user_id,
      to_email: toEmail,
      subject: composed.subject,
      body_text: composed.body_text,
      body_html: composed.body_html,
    });
    if (res) {
      queued = true;
      count = notifications.length;
    }
  }

  // Advance the cursor to the newest notification we considered (or now if the
  // window was empty). Upsert on the per-cadence key.
  const newCursor =
    notifications.length > 0
      ? notifications[notifications.length - 1]!.created_at
      : now.toISOString();
  const { error: cursorErr } = await c
    .from("notification_digest_cursors" as never)
    .upsert(
      {
        org_id,
        user_id,
        cadence,
        last_sent_at: newCursor,
      } as never,
      { onConflict: "org_id,user_id,cadence" } as never,
    );
  if (cursorErr) {
    // A cursor-advance failure means we might re-digest next pass — logged, not
    // fatal (better a duplicate than silently dropping the send we just made).
    console.error("[notif-prefs] cursor advance failed", cursorErr);
  }

  return { queued, count };
}

async function fetchCursors(
  c: ReturnType<typeof createAdminClient>,
  orgIds: string[],
  userIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orgIds.length === 0 || userIds.length === 0) return out;
  const { data, error } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      c
        .from("notification_digest_cursors" as never)
        .select("org_id, user_id, cadence, last_sent_at" as never)
        .in("org_id" as never, orgIds as never)
        .in("user_id" as never, userIds as never)
        .order("org_id" as never, { ascending: true })
        .order("user_id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (error) {
    console.error("[notif-prefs] fetchCursors failed", error);
    return out;
  }
  for (const r of data) {
    const key = `${r.org_id as string}::${r.user_id as string}::${r.cadence as string}`;
    const t = new Date(r.last_sent_at as string).getTime();
    if (!Number.isNaN(t)) out.set(key, t);
  }
  return out;
}

async function fetchUserEmails(
  c: ReturnType<typeof createAdminClient>,
  userIds: string[],
): Promise<Map<string, { to: string | null; name: string | null }>> {
  const out = new Map<string, { to: string | null; name: string | null }>();
  if (userIds.length === 0) return out;
  const { data, error } = await fetchAllRows<Record<string, unknown>>(
    (from, to) =>
      c
        .from("users")
        .select("id, email, full_name")
        .in("id", userIds)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (error) {
    console.error("[notif-prefs] fetchUserEmails failed", error);
    return out;
  }
  for (const r of data) {
    const rawEmail = (r.email as string | null) ?? null;
    const trimmed = rawEmail && rawEmail.trim().length > 0 ? rawEmail.trim() : null;
    out.set(r.id as string, {
      to: trimmed,
      name: (r.full_name as string | null) ?? null,
    });
  }
  return out;
}

/** The canonical category list the settings UI renders a row per. */
export const SETTINGS_CATEGORIES: readonly NotificationCategory[] =
  NOTIFICATION_CATEGORIES;
