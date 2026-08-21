import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { getNotificationSmsProvider } from "@/lib/comms";
import { getPreferencesForUserKeys } from "@/server/services/notification-preferences-service";
import { resolveSmsDelivery, type NotificationPreference } from "./preferences";
import type { NotificationRow } from "./types";

/**
 * CrewFlow — SMS notification channel (IO half). Twilio-gated, refuse-before-send.
 *
 * The eligibility/preference pipeline (resolveSmsDelivery + the per-category
 * notification_preferences.sms_enabled toggle) existed before this; the transport
 * did not — emit resolved WHO would receive an SMS and then SENT NOTHING
 * (darkReason "no_transport"). This module wires the seam to the real Twilio
 * transport that already lives behind the comms factory (lib/comms getSmsProvider
 * → lib/comms/providers/twilio.ts), mirroring the Web Push channel exactly:
 *
 *   emit ─► enqueueSmsForNotifications (NETWORK-FREE): resolve recipients, filter
 *           by per-member SMS preference + phone presence, write one sms_deliveries
 *           row per (notification, recipient). Idempotent (upsert on the unique
 *           (notification_id, user_id) key).
 *   cron ─► drainSmsQueue: pick queued rows, resolve each recipient's CURRENT
 *           phone, hand the message to the Twilio provider, record the outcome
 *           (sent + provider sid, or a backed-off retry / terminal failure).
 *
 * TWO-SWITCH DARK, refuse-before-send:
 *   * SWITCH 1 (config): getNotificationSmsProvider() — Twilio SID + auth token + TWILIO_SMS_FROM
 *     (COMMS_SMS_PROVIDER not disabled). Null (the CI/dev/prod default) ⇒
 *     `enqueueSmsForNotifications` enqueues NOTHING and `drainSmsQueue` marks any
 *     stray row 'skipped'. No creds, no send. Activation = set the creds.
 *   * SWITCH 2 (opt-in): per-user, per-category sms_enabled (DEFAULT FALSE — opt-in;
 *     critical categories always eligible) resolved via `resolveSmsDelivery`.
 *
 * Fan-out: a user-directed row (user_id set) targets that user; an ORG-WIDE row
 * (user_id null) fans out to every member of the org (public.memberships). A
 * recipient is kept only when (a) their per-category SMS preference resolves ON
 * and (b) they have a usable E.164 phone (public.users.phone). Delivery is settled
 * per (notification, recipient), so re-emit never double-sends. Service role
 * throughout (the queue + send are default-deny to authenticated).
 */

// ---------------------------------------------------------------------
// Config (SWITCH 1)
// ---------------------------------------------------------------------

/**
 * True when the SMS transport is fully configured (SWITCH 1). Delegates to the
 * comms notification-SMS accessor so "configured" here means exactly what the
 * transport means by it — Twilio creds present AND the provider not disabled —
 * never a second, drifting definition. Dark by default (CI sets no creds).
 */
export function isSmsConfigured(): boolean {
  return getNotificationSmsProvider() !== null;
}

// ---------------------------------------------------------------------
// Phone + body helpers (pure)
// ---------------------------------------------------------------------

/**
 * Normalise a stored phone number to an E.164 string the transport can dial, or
 * null when it is not a usable number. Strips spaces/hyphens/parentheses, keeps a
 * leading `+`, and requires the canonical E.164 shape (`+` then 8–15 digits). A
 * number that does not match is rejected rather than handed to Twilio to fail —
 * SMS never attempts an obviously-undeliverable send.
 */
export function normaliseSmsPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[\s\-().]/g, "");
  if (!/^\+\d{8,15}$/.test(cleaned)) return null;
  return cleaned;
}

/** The longest SMS body we will send (kept well within a handful of segments). */
export const SMS_MAX_BODY_LENGTH = 320;

/**
 * Compose the SMS text from a notification row. Pure — no I/O. Title, then body
 * (when present), then an absolute deep link (when the action_url is a safe
 * same-origin relative path), joined compactly and truncated with an ellipsis so
 * the message stays within {@link SMS_MAX_BODY_LENGTH}. Mirrors the push payload's
 * same-origin guard: a poisoned absolute action_url is dropped, never dialled into
 * the link.
 */
export function buildSmsText(n: {
  title: string;
  body?: string | null;
  action_url?: string | null;
}): string {
  const title = (n.title ?? "").trim() || "CrewFlow";
  const body = (n.body ?? "").trim();
  let text = body ? `${title} — ${body}` : title;

  const rawUrl = typeof n.action_url === "string" ? n.action_url.trim() : "";
  if (rawUrl.startsWith("/") && !rawUrl.startsWith("//")) {
    const link = `https://crewflow.uk${rawUrl}`;
    // Only append the link if the whole message still fits; a link is optional,
    // the message text is not.
    if (text.length + 1 + link.length <= SMS_MAX_BODY_LENGTH) {
      text = `${text} ${link}`;
    }
  }

  if (text.length > SMS_MAX_BODY_LENGTH) {
    text = `${text.slice(0, SMS_MAX_BODY_LENGTH - 1).trimEnd()}…`;
  }
  return text;
}

// ---------------------------------------------------------------------
// Recipient resolution (pure) — the fan-out + preference + phone decision
// ---------------------------------------------------------------------

export type SmsRecipient = { row: NotificationRow; userId: string };

/**
 * Resolve which (notification, user) pairs should receive an SMS, given the
 * already-loaded membership, phone and preference facts. Pure — no I/O — so the
 * fan-out, per-member preference/opt-out and tenant-isolation rules are unit-
 * testable without a database.
 *
 * For each notification:
 *   * user-directed (user_id set) → that user;
 *   * org-wide (user_id null)     → every member of the SAME org (never another
 *                                   tenant's member — membership is keyed by org).
 * A candidate is kept only when BOTH:
 *   * they have a usable phone (`phonedKeys` holds "org::user"); AND
 *   * `resolveSmsDelivery` returns true for the row's category/priority against
 *     their stored preference (default OFF — opt-in — with the critical floor).
 * Each (notification, user) is emitted at most once.
 */
export function resolveSmsRecipients(args: {
  rows: ReadonlyArray<NotificationRow>;
  membersByOrg: ReadonlyMap<string, ReadonlySet<string>>;
  phonedKeys: ReadonlySet<string>;
  prefIndex: ReadonlyMap<string, NotificationPreference>;
}): SmsRecipient[] {
  const { rows, membersByOrg, phonedKeys, prefIndex } = args;
  const out: SmsRecipient[] = [];
  const seen = new Set<string>();

  const keep = (row: NotificationRow, userId: string): void => {
    const dedupeKey = `${row.id}::${userId}`;
    if (seen.has(dedupeKey)) return;
    if (!phonedKeys.has(`${row.org_id}::${userId}`)) return;
    const pref = prefIndex.get(`${row.org_id}::${userId}::${row.category}`) ?? null;
    if (
      !resolveSmsDelivery({
        category: row.category,
        priority: row.priority,
        preference: pref,
      })
    ) {
      return;
    }
    seen.add(dedupeKey);
    out.push({ row, userId });
  };

  for (const row of rows) {
    if (row.user_id != null) {
      keep(row, row.user_id);
    } else {
      const members = membersByOrg.get(row.org_id);
      if (!members) continue;
      for (const userId of members) keep(row, userId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// ENQUEUE (service role, network-free) — called from emitNotifications
// ---------------------------------------------------------------------

/**
 * Fan a batch of just-persisted notifications out to sms_deliveries, network-free.
 * Called from `emitNotifications` after the rows persist. DARK short-circuit first
 * (no Twilio ⇒ nothing enqueued). Then resolve the candidate set — org members for
 * org-wide rows, the directed user otherwise — read their phones + preferences in
 * two bulk paged reads, and upsert one row per eligible (notification, recipient).
 * Idempotent: the upsert ignores collisions on (notification_id, user_id). Returns
 * the number of new rows enqueued.
 */
export async function enqueueSmsForNotifications(
  rows: ReadonlyArray<NotificationRow>,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!isSmsConfigured()) return 0; // SWITCH 1: dark ⇒ enqueue nothing.

  const c = createAdminClient();
  const orgIds = Array.from(new Set(rows.map((r) => r.org_id)));

  // Which orgs need their full membership enumerated (they carry an org-wide row).
  const orgsNeedingMembers = new Set(
    rows.filter((r) => r.user_id == null).map((r) => r.org_id),
  );

  // (1) Membership for org-wide fan-out. Paged (memberships is a high-value,
  // cross-tenant table). A read failure degrades to no org-wide fan-out for that
  // batch — never a wrong-tenant send.
  const membersByOrg = new Map<string, Set<string>>();
  if (orgsNeedingMembers.size > 0) {
    const memberOrgIds = Array.from(orgsNeedingMembers);
    const { data: memberRows, error: memberErr } = await fetchAllRows<
      Record<string, unknown>
    >(
      (from, to) =>
        c
          .from("memberships" as never)
          .select("org_id, user_id" as never)
          .in("org_id" as never, memberOrgIds as never)
          .order("org_id" as never, { ascending: true })
          .order("user_id" as never, { ascending: true })
          .range(from, to) as unknown as PromiseLike<
          PageResult<Record<string, unknown>>
        >,
    );
    if (memberErr) {
      console.error("[sms] enqueue: membership read failed", memberErr);
      return 0;
    }
    for (const m of memberRows ?? []) {
      const org = m.org_id as string;
      const user = m.user_id as string;
      if (!membersByOrg.has(org)) membersByOrg.set(org, new Set());
      membersByOrg.get(org)!.add(user);
    }
  }

  // The full candidate user set (directed users + every enumerated member) — the
  // universe we must fetch phones + preferences for.
  const candidateUserIds = new Set<string>();
  for (const r of rows) {
    if (r.user_id != null) candidateUserIds.add(r.user_id);
  }
  for (const members of membersByOrg.values()) {
    for (const u of members) candidateUserIds.add(u);
  }
  if (candidateUserIds.size === 0) return 0;

  // (2) Phones for the candidate users. public.users is the canonical per-member
  // phone. Paged + bound to the candidate id set. A user without a usable E.164
  // number is not a recipient.
  const userIdList = Array.from(candidateUserIds);
  const { data: userRows, error: userErr } = await fetchAllRows<
    Record<string, unknown>
  >(
    (from, to) =>
      c
        .from("users" as never)
        .select("id, phone" as never)
        .in("id" as never, userIdList as never)
        .order("id" as never, { ascending: true })
        .range(from, to) as unknown as PromiseLike<
        PageResult<Record<string, unknown>>
      >,
  );
  if (userErr) {
    console.error("[sms] enqueue: phone read failed", userErr);
    return 0;
  }
  const phoneByUser = new Map<string, string>();
  for (const u of userRows ?? []) {
    const phone = normaliseSmsPhone(u.phone as string | null);
    if (phone) phoneByUser.set(u.id as string, phone);
  }
  // "org::user" keys for users with a usable phone (used by the pure resolver).
  const phonedKeys = new Set<string>();
  for (const r of rows) {
    if (r.user_id != null && phoneByUser.has(r.user_id)) {
      phonedKeys.add(`${r.org_id}::${r.user_id}`);
    }
  }
  for (const [org, members] of membersByOrg) {
    for (const u of members) {
      if (phoneByUser.has(u)) phonedKeys.add(`${org}::${u}`);
    }
  }
  if (phonedKeys.size === 0) return 0; // nobody reachable by SMS in this batch.

  // (3) Preferences for every distinct (org,user) recipient — one bulk read.
  const prefKeySet = new Map<string, { org_id: string; user_id: string }>();
  for (const r of rows) {
    if (r.user_id != null && phoneByUser.has(r.user_id)) {
      prefKeySet.set(`${r.org_id}::${r.user_id}`, {
        org_id: r.org_id,
        user_id: r.user_id,
      });
    }
  }
  for (const [org, members] of membersByOrg) {
    for (const u of members) {
      if (phoneByUser.has(u)) prefKeySet.set(`${org}::${u}`, { org_id: org, user_id: u });
    }
  }
  const prefIndex = await getPreferencesForUserKeys(Array.from(prefKeySet.values()));

  // (4) Pure decision: fan-out × preference × phone.
  const recipients = resolveSmsRecipients({
    rows,
    membersByOrg,
    phonedKeys,
    prefIndex,
  });
  if (recipients.length === 0) return 0;

  const payload = recipients.map(({ row, userId }) => ({
    notification_id: row.id,
    org_id: row.org_id,
    user_id: userId,
    category: row.category,
    status: "queued" as const,
    retry_count: 0,
    scheduled_for: new Date().toISOString(),
  }));

  const { error: insErr, count } = await c
    .from("sms_deliveries" as never)
    .upsert(payload as never, {
      onConflict: "notification_id,user_id",
      ignoreDuplicates: true,
      count: "exact",
    } as never);
  if (insErr) {
    console.error("[sms] enqueue: delivery insert failed", insErr);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// DRAIN (cron entry point, service role)
// ---------------------------------------------------------------------

export type SmsDrainResult = {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
  durationMs: number;
};

const SMS_DRAIN_BATCH_SIZE = 50;
const SMS_MAX_RETRIES = 6;

/**
 * Drain up to a batch of queued sms_deliveries whose scheduled_for is in the past.
 * DARK double-check first: no Twilio provider ⇒ mark the batch 'skipped'
 * (refuse-before-send — a config that was set then cleared can never dispatch a
 * stale row). For each delivery we resolve the recipient's CURRENT phone, hand the
 * message to the transport, record the provider sid on success, and settle the row
 * (sent / skipped / failed-with-backoff). Best-effort: a per-row failure is
 * absorbed into the result, never thrown.
 */
export async function drainSmsQueue(): Promise<SmsDrainResult> {
  const startedAt = Date.now();
  const c = createAdminClient();

  const { data, error } = await c
    .from("sms_deliveries" as never)
    .select("id, notification_id, org_id, user_id, category, retry_count" as never)
    .eq("status" as never, "queued")
    .lte("scheduled_for" as never, new Date().toISOString())
    .order("scheduled_for" as never, { ascending: true })
    .limit(SMS_DRAIN_BATCH_SIZE);
  if (error) {
    return {
      picked: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: [(error as { message?: string }).message ?? String(error)],
      durationMs: Date.now() - startedAt,
    };
  }
  const deliveries = (data ?? []) as Array<{
    id: string;
    notification_id: string;
    org_id: string;
    user_id: string;
    category: string;
    retry_count: number;
  }>;

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  const provider = getNotificationSmsProvider();
  if (!provider) {
    // SWITCH 1 lost between enqueue and drain — refuse to send, mark skipped.
    for (const d of deliveries) {
      await settle(c, d.id, "skipped", d.retry_count, "no_provider", null, null);
      skipped++;
    }
    return {
      picked: deliveries.length,
      sent: 0,
      failed: 0,
      skipped,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  // Fetch the source notifications once for body composition, and the recipients'
  // current phones once for this batch.
  const notifIds = Array.from(new Set(deliveries.map((d) => d.notification_id)));
  const notifById = await fetchNotificationsForSms(c, notifIds);
  const userIds = Array.from(new Set(deliveries.map((d) => d.user_id)));
  const phoneByUser = await fetchPhonesForUsers(c, userIds);

  for (const d of deliveries) {
    try {
      const n = notifById.get(d.notification_id);
      if (!n) {
        // Notification vanished (cascade delete) — nothing to send.
        await settle(c, d.id, "skipped", d.retry_count, "notification_missing", null, null);
        skipped++;
        continue;
      }

      const phone = phoneByUser.get(d.user_id) ?? null;
      if (!phone) {
        await settle(c, d.id, "skipped", d.retry_count, "no_phone", null, null);
        skipped++;
        continue;
      }

      const body = buildSmsText(n);
      try {
        const acceptance = await provider.send({ to: phone, body });
        await settle(
          c,
          d.id,
          "sent",
          d.retry_count,
          null,
          phone,
          acceptance.providerMessageId,
        );
        sent++;
      } catch (sendErr) {
        // Transport threw (misconfig / vendor error) — schedule a backed-off retry
        // (or give up after max). Mirrors the push backoff.
        const message =
          sendErr instanceof Error ? sendErr.message : String(sendErr);
        const retry = d.retry_count + 1;
        if (retry < SMS_MAX_RETRIES) {
          await c
            .from("sms_deliveries" as never)
            .update({
              status: "queued",
              retry_count: retry,
              last_error: message.slice(0, 1000),
              failed_at: new Date().toISOString(),
              to_phone: phone,
              scheduled_for: nextRetryStamp(retry),
            } as never)
            .eq("id" as never, d.id);
        } else {
          await settle(c, d.id, "failed", retry, message, phone, null);
        }
        failed++;
        errors.push(`${d.id}: ${message}`);
      }
    } catch (e) {
      failed++;
      errors.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    picked: deliveries.length,
    sent,
    failed,
    skipped,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Nightly housekeeping — prune ancient settled rows so the queue doesn't grow
 * forever. Mirrors cleanupOldPushDeliveries. Returns count of rows pruned.
 */
export async function cleanupOldSmsDeliveries(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const c = createAdminClient();
  const { error, count } = await c
    .from("sms_deliveries" as never)
    .delete({ count: "exact" })
    .in("status" as never, ["sent", "skipped", "failed"])
    .lt("created_at" as never, cutoff);
  if (error) {
    console.error("[sms] cleanup failed", (error as { message?: string }).message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

type SmsNotif = {
  id: string;
  title: string;
  body: string | null;
  action_url: string | null;
};

async function fetchNotificationsForSms(
  c: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, SmsNotif>> {
  const out = new Map<string, SmsNotif>();
  if (ids.length === 0) return out;
  const { data, error } = await c
    .from("notifications" as never)
    .select("id, title, body, action_url" as never)
    .in("id" as never, ids as never);
  if (error) {
    console.error("[sms] notification read failed", error);
    return out;
  }
  for (const raw of (data as unknown as Array<Record<string, unknown>>) ?? []) {
    out.set(raw.id as string, {
      id: raw.id as string,
      title: (raw.title as string) ?? "",
      body: (raw.body as string | null) ?? null,
      action_url: (raw.action_url as string | null) ?? null,
    });
  }
  return out;
}

async function fetchPhonesForUsers(
  c: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await c
    .from("users" as never)
    .select("id, phone" as never)
    .in("id" as never, ids as never);
  if (error) {
    console.error("[sms] phone read failed", error);
    return out;
  }
  for (const raw of (data as unknown as Array<Record<string, unknown>>) ?? []) {
    const phone = normaliseSmsPhone(raw.phone as string | null);
    if (phone) out.set(raw.id as string, phone);
  }
  return out;
}

async function settle(
  c: ReturnType<typeof createAdminClient>,
  id: string,
  status: "sent" | "skipped" | "failed",
  retryCount: number,
  lastError: string | null,
  toPhone: string | null,
  providerMessageId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await c
    .from("sms_deliveries" as never)
    .update({
      status,
      retry_count: retryCount,
      last_error: lastError ? lastError.slice(0, 1000) : null,
      ...(toPhone ? { to_phone: toPhone } : {}),
      ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
      ...(status === "sent" ? { sent_at: now } : {}),
      ...(status === "failed" ? { failed_at: now } : {}),
    } as never)
    .eq("id" as never, id);
}

/** 1:1min, 2:5min, 3:15min, 4:1h, 5:4h, 6+:24h — mirrors the push/email backoff. */
function nextRetryStamp(retryCount: number): string {
  const minutes =
    retryCount === 1
      ? 1
      : retryCount === 2
        ? 5
        : retryCount === 3
          ? 15
          : retryCount === 4
            ? 60
            : retryCount === 5
              ? 240
              : 1440;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
