import "server-only";
import { env } from "@/lib/env";
import { resolveSmsDelivery } from "./preferences";
import { getPreferencesForUserKeys } from "@/server/services/notification-preferences-service";
import type { NotificationRow } from "./types";

/**
 * CrewFlow — SMS notification channel SEAM (DARK).
 *
 * SMS delivery is Twilio-gated and deliberately not wired to a transport yet:
 * this module is the refuse-before-send seam so the preference toggle
 * (notification_preferences.sms_enabled) and the sender wiring exist, and
 * activation is a config flip (Twilio creds) + a transport implementation, not a
 * schema or wiring change.
 *
 * TWO-SWITCH DARK:
 *   * SWITCH 1 (config): TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_SMS_FROM.
 *     Unset ⇒ `isSmsConfigured()` false ⇒ this seam sends NOTHING.
 *   * SWITCH 2 (opt-in): per-user, per-category sms_enabled (default off; critical
 *     always eligible) — resolved via `resolveSmsDelivery`.
 *
 * Even when SWITCH 1 is later satisfied, no transport POST exists here yet, so
 * this remains a no-op that only COUNTS what it WOULD have sent — the eligibility
 * pipeline is exercised and testable without ever contacting Twilio.
 */

/** True when Twilio SMS is fully configured (SWITCH 1). Dark by default. */
export function isSmsConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM,
  );
}

export type SmsSeamResult = {
  /** Recipients whose preference made them eligible for an SMS. */
  eligible: number;
  /** Always 0 while the transport is dark — refuse-before-send. */
  sent: number;
  /** Why nothing was sent, when eligible > 0 but sent === 0. */
  darkReason: "no_transport" | "not_configured" | null;
};

/**
 * Resolve which of a batch of just-persisted, user-directed notifications WOULD
 * receive an SMS, honouring the per-category preference + critical floor. Sends
 * nothing (dark). Org-wide rows (user_id null) are ignored here — SMS targets a
 * specific person's phone, and there is no per-member phone fan-out yet.
 */
export async function deliverSmsForNotifications(
  rows: ReadonlyArray<NotificationRow>,
): Promise<SmsSeamResult> {
  const targeted = rows.filter((r) => r.user_id != null);
  if (targeted.length === 0) {
    return { eligible: 0, sent: 0, darkReason: null };
  }

  const prefKeys = Array.from(
    new Map(
      targeted.map((r) => [
        `${r.org_id}::${r.user_id}`,
        { org_id: r.org_id, user_id: r.user_id as string },
      ]),
    ).values(),
  );
  const prefIndex = await getPreferencesForUserKeys(prefKeys);

  const eligible = targeted.filter((r) => {
    const pref =
      prefIndex.get(`${r.org_id}::${r.user_id}::${r.category}`) ?? null;
    return resolveSmsDelivery({
      category: r.category,
      priority: r.priority,
      preference: pref,
    });
  }).length;

  if (eligible === 0) return { eligible: 0, sent: 0, darkReason: null };

  // Refuse-before-send: the transport does not exist yet. We never contact Twilio
  // even when SWITCH 1 is set — a later PR wires the actual POST here.
  return {
    eligible,
    sent: 0,
    darkReason: isSmsConfigured() ? "no_transport" : "not_configured",
  };
}
