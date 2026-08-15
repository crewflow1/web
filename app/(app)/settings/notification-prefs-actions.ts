"use server";

import { requireOrgContext } from "@/server/auth/session";
import {
  formError,
  formSuccess,
  type FormState,
} from "@/lib/forms/state";
import {
  upsertPreferencesForUser,
  type PreferenceInput,
} from "@/server/services/notification-preferences-service";
import {
  NOTIFICATION_CADENCES,
  isCriticalNotification,
  type NotificationCadence,
} from "@/lib/notifications/preferences";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@/lib/notifications/types";

/**
 * Settings → Notification preferences — save action (P3).
 *
 * The form submits the WHOLE grid at once: per non-critical category an in-app
 * checkbox (`inapp_<category>`) and an email cadence select (`email_<category>`
 * ∈ off | immediate | daily | weekly). Critical categories (money / security /
 * urgent — see isCriticalNotification) are rendered locked and NEVER written:
 * their delivery is forced immediate by policy regardless of any stored row, so
 * persisting a preference for them would only be misleading.
 *
 * AUTHORISATION. org_id + user_id come from requireOrgContext (the session),
 * never from client input; the upsert runs on the user JWT so the own-row RLS
 * policy is the real boundary. Route depth is 2 (/settings), so returning a
 * FormState (no redirect) is safe — not the deep-swap navigation trap.
 */

function parseCadence(raw: FormDataEntryValue | null): NotificationCadence | "off" {
  const v = typeof raw === "string" ? raw : "";
  if (v === "off") return "off";
  return (NOTIFICATION_CADENCES as readonly string[]).includes(v)
    ? (v as NotificationCadence)
    : "immediate";
}

export async function saveNotificationPreferences(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();

  const inputs: PreferenceInput[] = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    // A category that is ALWAYS critical is not user-editable — skip it entirely
    // so we never write a preference the policy will ignore.
    if (isCriticalNotification(category, "low")) continue;

    const cadenceValue = parseCadence(formData.get(`email_${category}`));
    const emailEnabled = cadenceValue !== "off";
    const inAppEnabled = formData.get(`inapp_${category}`) === "on";

    inputs.push({
      category: category as NotificationCategory,
      in_app_enabled: inAppEnabled,
      email_enabled: emailEnabled,
      email_cadence: emailEnabled
        ? (cadenceValue as NotificationCadence)
        : "immediate",
    });
  }

  const ok = await upsertPreferencesForUser(ctx.org.id, user.id, inputs);
  if (!ok) {
    return formError(
      "Couldn't save your notification preferences. Please try again.",
    );
  }
  return formSuccess({ successMessage: "Notification preferences saved." });
}
