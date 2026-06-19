import Link from "next/link";
import { getLatestNotificationsForHq } from "@/server/services/notifications-service";
import { getEmailQueueStats } from "@/server/services/notification-email-queue-stats";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABEL,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_PRIORITY_LABEL,
  type NotificationCategory,
  type NotificationPriority,
  type NotificationRow,
} from "@/lib/notifications/types";
import {
  prioritySort,
  filterNotifications,
} from "@/lib/notifications/sort";
import { markReadHq, markAllReadHq, dismissHq } from "./actions";
import {
  Alert,
  AnimatedNumber,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  GlowHeader,
  Input,
  Panel,
  Select,
  StatTile,
  Surface,
  type Accent,
} from "@/components/ui";

/** Dark-surface accent per priority (mirrors the legacy light pill map). */
const PRIORITY_ACCENT: Record<NotificationPriority, Accent> = {
  low: "slate",
  medium: "sky",
  high: "amber",
  urgent: "rose",
};

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

  const all = (await getLatestNotificationsForHq(500)) as Row[];
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
    if (sp.error)
      return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="All notifications"
        subtitle="Cross-tenant operations feed. Urgent first by default. Every row links to the source record (customer, ticket, billing row, etc.)."
        actions={
          <>
            <ButtonLink href="/admin/overview" variant="glass" size="sm">
              ← HQ overview
            </ButtonLink>
            {unread.length > 0 ? (
              <form action={markAllReadHq}>
                <Button type="submit" variant="glass" size="sm">
                  Mark all read
                </Button>
              </form>
            ) : null}
          </>
        }
      />

      <div className="space-y-5 p-5 sm:p-7">
        {banner ? (
          <Alert tone={banner.tone === "ok" ? "success" : "danger"}>
            {banner.msg}
          </Alert>
        ) : null}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="Unread"
            value={<AnimatedNumber value={unread.length} />}
            accent="indigo"
          />
          <StatTile
            label="Urgent"
            value={<AnimatedNumber value={urgent} />}
            accent={urgent > 0 ? "rose" : "slate"}
          />
          <StatTile
            label="High"
            value={<AnimatedNumber value={high} />}
            accent={high > 0 ? "amber" : "slate"}
          />
          <StatTile
            label="Last 24h"
            value={<AnimatedNumber value={today24h} />}
          />
        </section>

        {/* Email queue health (Phase-2) */}
        {emailStats ? (
          <Panel
            title="Email queue"
            action={
              <p className="text-[11px] text-slate-500">
                Drained every 15 min via cron · provider: Resend
              </p>
            }
          >
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
              <div>
                <dt className="text-slate-500">Queued</dt>
                <dd className="text-base font-semibold text-white">
                  {emailStats.queued}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Sent (24h)</dt>
                <dd className="text-base font-semibold text-emerald-300">
                  {emailStats.sent_24h}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Failed (24h)</dt>
                <dd
                  className={`text-base font-semibold ${emailStats.failed_24h > 0 ? "text-rose-300" : "text-white"}`}
                >
                  {emailStats.failed_24h}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Skipped</dt>
                <dd className="text-base font-semibold text-slate-300">
                  {emailStats.skipped}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Permanent fail</dt>
                <dd
                  className={`text-base font-semibold ${emailStats.permanent_failures > 0 ? "text-rose-300" : "text-white"}`}
                >
                  {emailStats.permanent_failures}
                </dd>
              </div>
            </dl>
            {emailStats.recent_failures.length > 0 ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-slate-300 transition-colors hover:text-white">
                  Recent failures ({emailStats.recent_failures.length})
                </summary>
                <ul className="mt-2 space-y-1 text-[11px]">
                  {emailStats.recent_failures.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1.5"
                    >
                      <p className="font-medium text-rose-200">
                        {f.to_email} · retry {f.retry_count}
                      </p>
                      <p className="text-slate-300">{f.subject}</p>
                      {f.last_error ? (
                        <p className="mt-0.5 text-rose-300">{f.last_error}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Panel>
        ) : null}

        <form
          method="get"
          action="/admin/notifications"
          className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-3"
        >
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Search
            <Input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="title or body"
              className="mt-1 w-56"
            />
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            State
            <Select name="state" defaultValue={state} className="mt-1">
              <option value="unread">Unread (default)</option>
              <option value="all">All</option>
              <option value="dismissed">Dismissed</option>
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Category
            <Select name="category" defaultValue={category} className="mt-1">
              <option value="all">All</option>
              {NOTIFICATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {NOTIFICATION_CATEGORY_LABEL[c]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Priority
            <Select name="priority" defaultValue={priority} className="mt-1">
              <option value="all">All</option>
              {NOTIFICATION_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {NOTIFICATION_PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Org
            <Select name="org_id" defaultValue={orgId ?? ""} className="mt-1">
              <option value="">All</option>
              {orgOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name ?? id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="accent" size="sm">
            Apply
          </Button>
          <ButtonLink href="/admin/notifications" variant="glass" size="sm">
            Reset
          </ButtonLink>
        </form>

        {sorted.length === 0 ? (
          <EmptyState
            title="No notifications match these filters."
          />
        ) : (
          <ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/40">
            {sorted.map((n) => {
              const isUnread = n.read_at === null && n.dismissed_at === null;
              return (
                <li
                  key={n.id}
                  className={`px-4 py-3 ${isUnread ? "bg-indigo-500/5" : "opacity-70"}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        {isUnread ? (
                          <span className="text-xs text-indigo-300">•</span>
                        ) : null}
                        <span className="text-[11px] font-medium text-slate-300">
                          {n.org_name ?? n.org_id.slice(0, 8)}
                        </span>
                        <Badge accent={PRIORITY_ACCENT[n.priority]}>
                          {NOTIFICATION_PRIORITY_LABEL[n.priority]}
                        </Badge>
                        <span className="text-[11px] text-slate-500">
                          {NOTIFICATION_CATEGORY_LABEL[n.category] ?? n.category}
                        </span>
                      </p>
                      <p className="mt-1 text-sm font-semibold text-white">
                        {n.action_url ? (
                          <Link
                            href={n.action_url}
                            className="text-indigo-300 transition-colors hover:text-indigo-200"
                          >
                            {n.title}
                          </Link>
                        ) : (
                          n.title
                        )}
                      </p>
                      {n.body ? (
                        <p className="mt-1 text-xs text-slate-400">{n.body}</p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-slate-500">
                        {n.created_at.slice(0, 16).replace("T", " ")} UTC
                        {n.source_module ? ` · ${n.source_module}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {n.action_url ? (
                        <ButtonLink
                          href={n.action_url}
                          variant="glass"
                          size="sm"
                        >
                          Open source
                        </ButtonLink>
                      ) : null}
                      {isUnread ? (
                        <form action={markReadHq}>
                          <input type="hidden" name="id" value={n.id} />
                          <button
                            type="submit"
                            className="text-[11px] font-medium text-slate-400 transition-colors hover:text-white hover:underline"
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
                            className="text-[11px] font-medium text-slate-400 transition-colors hover:text-white hover:underline"
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
    </Surface>
  );
}
