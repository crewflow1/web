import { requireOrgContext } from "@/server/auth/session";
import {
  getPreferencesForUser,
  SETTINGS_CATEGORIES,
} from "@/server/services/notification-preferences-service";
import {
  indexPreferencesByCategory,
  isCriticalNotification,
} from "@/lib/notifications/preferences";
import { NOTIFICATION_CATEGORY_LABEL } from "@/lib/notifications/types";
import { saveNotificationPreferences } from "./notification-prefs-actions";
import {
  NotificationPrefsForm,
  type PrefRowView,
} from "./_notification-prefs.client";

/**
 * Settings → Notification preferences (P3) — self-contained section.
 *
 * Rendered from settings/page.tsx with a single import + JSX line. Fetches the
 * signed-in user's own preference rows (RLS-gated), fills the canonical category
 * list with defaults where no row exists, marks the critical (always-on)
 * categories, and hands the grid to the client form.
 */
export async function NotificationPreferences() {
  const { user, ctx } = await requireOrgContext();
  const stored = await getPreferencesForUser(ctx.org.id, user.id);
  const byCategory = indexPreferencesByCategory(stored);

  const rows: PrefRowView[] = SETTINGS_CATEGORIES.map((category) => {
    const pref = byCategory.get(category) ?? null;
    const critical = isCriticalNotification(category, "low");
    const emailChoice: PrefRowView["emailChoice"] = pref
      ? pref.email_enabled
        ? pref.email_cadence
        : "off"
      : "immediate"; // default-on
    return {
      category,
      label: NOTIFICATION_CATEGORY_LABEL[category] ?? category,
      critical,
      inApp: pref ? pref.in_app_enabled : true,
      emailChoice,
    };
  });

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">
        Notification preferences
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Choose how you&apos;re notified for each kind of update — in the app, by
        email as it happens, or rolled into a daily or weekly digest.
      </p>
      <NotificationPrefsForm rows={rows} action={saveNotificationPreferences} />
    </section>
  );
}
