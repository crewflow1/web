import Link from "next/link";
import { getLatestNotificationsForHq } from "@/server/services/notifications-service";
import { getEmailQueueStats } from "@/server/services/notification-email-queue-stats";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_PRIORITY_LABEL,
  NOTIFICATION_PRIORITY_PILL,
  type NotificationCategory,
  type NotificationPriority,
  type NotificationRow,
} from "@/lib/notifications/types";
import {
  prioritySort,
  filterNotifications,
} from "@/lib/notifications/sort";
import {
  markReadHq,
  markAllReadHq,
  dismissHq,
  requeueFailedEmail,
} from "./actions";

/**
 * HQ Notifications centre — /admin/notifications (HQ-8).
 *
 * Cross-tenant. Service-role read. Shows every notification with
 * audience IN ('hq', 'both') across every org. Filters on org +
 * category + priority + unread.
 */

type SP = Promise<{
  q?: string;
  category?: string;
  priority?: string;
  state?: string;
  org_id?: string;
  saved?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

type Row = NotificationRow & { org_name?: string | null };

export default async function HqNotificationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const category =
    (sp.category as NotificationCategory | "all" | undefined) ?? "all";
  const priority =
    (sp.priority as NotificationPriority | "all" | undefined) ?? "all";
  const state =
    (sp.state as "unread" | "all" | "dismissed" | undefined) ?? "unread";
  const orgId = sp.org_id ?? null;

  const all = (await getLatestNotificationsForHq()) as Row[];
  const filtered = filterNotifications<Row>(all, {
    q,
    category,
    priority,
    state,
    org_id: orgId,
  });
  const sorted = prioritySort(filtered);

  // Distinct orgs for the org filter dropdown.
  const orgOptions = Array.from(
    new Map(all.map((n) => [n.org_id, n.org_name ?? n.org_id])).entries(),
  ).sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? ""));

  // KPI tiles
  const unread = all.filter(
    (n) => n.read_at === null && n.dismissed_at === null,
  );
  const urgent = unread.filter((n) => n.priority === "urgent").length;
  const high = unread.filter((n) => n.priority === "high").length;
  const today24h = all.filter((n) => {
    const ms = Date.now() - new Date(n.created_at).getTime();
    return ms <= 24 * 3600_000;
  }).length;

  // Phase-2: email queue health.
  const emailStats = await getEmailQueueStats().catch(() => null);

  const banner = (() => {
    if (sp.saved === "all_read")
      return { tone: "ok" as const, msg: "All HQ notifications marked read." };
    if (sp.saved === "dismissed")
      return { tone: "ok" as const, msg: "Dismissed." };
    if (sp.saved === "requeued")
      return {
        tone: "ok" as const,
        msg: "Email requeued — the next drain pass (≤15 min) will re-attempt it.",
      };
    if (sp.error === "not_failed_or_missing")
      return {
        tone: "err" as const,
        msg: "Couldn't requeue — that email is no longer in the failed state.",
      };
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            HQ · Notifications
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            All notifications
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Cross-tenant operations feed. Urgent first by default. Every
            row links to the source record (customer, ticket, billing
            row, etc.).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/overview"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← HQ overview
          </Link>
          {unread.length > 0 ? (
            <form action={markAllReadHq}>
              <button
                type="submit"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Mark all read
              </button>
            </form>
          ) : null}
        </div>
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

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Unread" value={String(unread.length)} tone="blue" />
        <Kpi label="Urgent" value={String(urgent)} tone="red" />
        <Kpi label="High" value={String(high)} tone="amber" />
        <Kpi label="Last 24h" value={String(today24h)} tone="slate" />
      </section>

      {/* Email queue health (Phase-2) */}
      {emailStats ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              Email queue
            </h2>
            <p className="text-[11px] text-slate-500">
              Drained every 15 min via cron · provider: Resend
            </p>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
            <div>
              <dt className="text-slate-500">Queued</dt>
              <dd className="text-base font-semibold text-slate-900">
                {emailStats.queued}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Sent (24h)</dt>
              <dd className="text-base font-semibold text-emerald-700">
                {emailStats.sent_24h}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Failed (24h)</dt>
              <dd
                className={`text-base font-semibold ${emailStats.failed_24h > 0 ? "text-red-700" : "text-slate-900"}`}
              >
                {emailStats.failed_24h}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Skipped</dt>
              <dd className="text-base font-semibold text-slate-700">
                {emailStats.skipped}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Permanent fail</dt>
              <dd
                className={`text-base font-semibold ${emailStats.permanent_failures > 0 ? "text-red-700" : "text-slate-900"}`}
              >
                {emailStats.permanent_failures}
              </dd>
            </div>
          </dl>
          {emailStats.recent_failures.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-700 hover:text-slate-900">
                Recent failures ({emailStats.recent_failures.length})
              </summary>
              <ul className="mt-2 space-y-1 text-[11px]">
                {emailStats.recent_failures.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-red-900">
                          {f.to_email} · retry {f.retry_count}
                        </p>
                        <p className="text-slate-700">{f.subject}</p>
                        {f.last_error ? (
                          <p className="mt-0.5 text-red-700">{f.last_error}</p>
                        ) : null}
                      </div>
                      <form action={requeueFailedEmail}>
                        <input type="hidden" name="id" value={f.id} />
                        <button
                          type="submit"
                          title="Reset this email to queued so the next drain pass re-attempts delivery"
                          className="shrink-0 rounded-md border border-red-300 bg-white px-2 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100"
                        >
                          Requeue
                        </button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <form
        method="get"
        action="/admin/notifications"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Search
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="title or body"
            className="mt-1 w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm"
          />
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          State
          <select
            name="state"
            defaultValue={state}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="unread">Unread (default)</option>
            <option value="all">All</option>
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
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Org
          <select
            name="org_id"
            defaultValue={orgId ?? ""}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {orgOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name ?? id.slice(0, 8)}
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
          href="/admin/notifications"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      {sorted.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No notifications match these filters.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-sm">
          {sorted.map((n) => {
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
                      <span className="text-[11px] font-medium text-slate-700">
                        {n.org_name ?? n.org_id.slice(0, 8)}
                      </span>
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
                        <Link href={n.action_url} className="hover:underline">
                          {n.title}
                        </Link>
                      ) : (
                        n.title
                      )}
                    </p>
                    {n.body ? (
                      <p className="mt-1 text-xs text-slate-600">{n.body}</p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-slate-500">
                      {n.created_at.slice(0, 16).replace("T", " ")} UTC
                      {n.source_module ? ` · ${n.source_module}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {n.action_url ? (
                      <Link
                        href={n.action_url}
                        className="rounded-md border border-indigo-300 bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-900 hover:bg-indigo-100"
                      >
                        Open source
                      </Link>
                    ) : null}
                    {isUnread ? (
                      <form action={markReadHq}>
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
                      <form action={dismissHq}>
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
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "red" | "amber" | "blue" | "slate";
}) {
  const t: Record<typeof tone, string> = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    blue: "bg-blue-50 border-blue-200 text-blue-900",
    slate: "bg-white border-slate-200 text-slate-900",
  };
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${t[tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-75">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
