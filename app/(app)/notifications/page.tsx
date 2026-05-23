import Link from "next/link";
import { getLatestNotificationsForCustomer } from "@/server/services/notifications-service";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_PRIORITY_LABEL,
  NOTIFICATION_PRIORITY_PILL,
  type NotificationCategory,
  type NotificationPriority,
} from "@/lib/notifications/types";
import {
  prioritySort,
  filterNotifications,
  groupByDate,
} from "@/lib/notifications/sort";
import { markRead, markAllRead, dismiss } from "./actions";

/**
 * Customer notifications centre (HQ-8).
 *
 * RLS-scoped via getLatestNotificationsForCustomer. The user only
 * sees notifications targeted at their org / themselves and with
 * audience IN ('customer', 'both').
 */

type SP = Promise<{
  category?: string;
  priority?: string;
  state?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function CustomerNotificationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const category =
    (sp.category as NotificationCategory | "all" | undefined) ?? "all";
  const priority =
    (sp.priority as NotificationPriority | "all" | undefined) ?? "all";
  const state =
    (sp.state as "unread" | "all" | "dismissed" | undefined) ?? "all";

  const all = await getLatestNotificationsForCustomer(200);
  const filtered = filterNotifications(all, { category, priority, state });
  const sorted = prioritySort(filtered);
  const groups = groupByDate(sorted);

  const unreadCount = all.filter(
    (n) => n.read_at === null && n.dismissed_at === null,
  ).length;

  const banner = (() => {
    if (sp.saved === "all_read")
      return { tone: "ok" as const, msg: "All caught up." };
    if (sp.saved === "dismissed")
      return { tone: "ok" as const, msg: "Notification dismissed." };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Workspace · Notifications
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            Notifications
            {unreadCount > 0 ? (
              <span className="ml-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                {unreadCount}
              </span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Everything that needs your attention — payments, support replies,
            onboarding progress.
          </p>
        </div>
        {unreadCount > 0 ? (
          <form action={markAllRead}>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Mark all read
            </button>
          </form>
        ) : null}
      </header>

      {banner ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.msg}
        </div>
      ) : null}

      <form
        method="get"
        action="/notifications"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          State
          <select
            name="state"
            defaultValue={state}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Category
          <select
            name="category"
            defaultValue={category}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            {NOTIFICATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {NOTIFICATION_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Priority
          <select
            name="priority"
            defaultValue={priority}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">All</option>
            {NOTIFICATION_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {NOTIFICATION_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
        >
          Apply
        </button>
        <Link
          href="/notifications"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
          You&apos;re all caught up.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.label}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {g.label}
              </p>
              <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
                {g.rows.map((n) => {
                  const isUnread = n.read_at === null && n.dismissed_at === null;
                  return (
                    <li
                      key={n.id}
                      className={`px-4 py-3 ${isUnread ? "" : "opacity-70"}`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2">
                            {isUnread ? (
                              <span className="text-xs text-blue-700">•</span>
                            ) : null}
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${NOTIFICATION_PRIORITY_PILL[n.priority]}`}
                            >
                              {NOTIFICATION_PRIORITY_LABEL[n.priority]}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {NOTIFICATION_CATEGORY_LABEL[n.category] ?? n.category}
                            </span>
                          </p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">
                            {n.action_url ? (
                              <Link
                                href={n.action_url}
                                className="hover:underline"
                              >
                                {n.title}
                              </Link>
                            ) : (
                              n.title
                            )}
                          </p>
                          {n.body ? (
                            <p className="mt-1 text-xs text-slate-600">
                              {n.body}
                            </p>
                          ) : null}
                          <p className="mt-1 text-[11px] text-slate-400">
                            {n.created_at.slice(0, 16).replace("T", " ")} UTC
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {isUnread ? (
                            <form action={markRead}>
                              <input type="hidden" name="id" value={n.id} />
                              <button
                                type="submit"
                                className="text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:underline"
                              >
                                Mark read
                              </button>
                            </form>
                          ) : null}
                          {n.dismissed_at === null ? (
                            <form action={dismiss}>
                              <input type="hidden" name="id" value={n.id} />
                              <button
                                type="submit"
                                className="text-[11px] font-medium text-slate-500 hover:text-slate-900 hover:underline"
                              >
                                Dismiss
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
