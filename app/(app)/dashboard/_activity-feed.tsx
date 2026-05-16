"use client";

import Link from "next/link";
import { useState } from "react";
import {
  actionIcon,
  activityHref,
  describeActivity,
  relativeTime,
  type ActivityRow,
  ACTIVITY_TYPES,
} from "@/lib/activity/render";

/**
 * Dashboard activity feed.
 *
 * Server pre-renders page 1 (25 rows) so first paint shows real content.
 * Client component handles "Load more" via GET /api/activity. State is
 * local — no infinite scroll observer (kept simple; "Load more" works
 * on every input device and screen-reader).
 *
 * Type filter resets the list to a fresh page-1 fetch.
 */

const PAGE_SIZE = 25;

export function ActivityFeed({
  initial,
  initialHasMore,
}: {
  initial: ActivityRow[];
  initialHasMore: boolean;
}) {
  const [items, setItems] = useState<ActivityRow[]>(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [page, setPage] = useState(1);
  const [type, setType] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage(nextPage: number, typeFilter: string, replace: boolean) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ page: String(nextPage) });
      if (typeFilter) qs.set("type", typeFilter);
      const res = await fetch(`/api/activity?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        return;
      }
      const j = (await res.json()) as {
        data: ActivityRow[];
        hasMore: boolean;
      };
      setItems((prev) => (replace ? j.data : [...prev, ...j.data]));
      setHasMore(j.hasMore);
      setPage(nextPage);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  function onTypeChange(next: string) {
    setType(next);
    void fetchPage(1, next, true);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
          <p className="text-xs text-slate-500">
            Audit trail across your org · {PAGE_SIZE * page} most recent
          </p>
        </div>
        <select
          aria-label="Filter activity type"
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
        >
          {ACTIVITY_TYPES.map((t) => (
            <option key={t.value || "all"} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">
          {type ? "Nothing yet for this filter." : "No activity yet."}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {items.map((row) => {
            const href = activityHref(row);
            const body = describeActivity(row);
            return (
              <li key={row.id} className="flex items-start gap-3 py-2.5 text-sm">
                <span aria-hidden className="mt-0.5 text-base leading-none">
                  {actionIcon(row.action)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-slate-900">
                    <span className="font-medium">
                      {row.actor_name ?? "System"}
                    </span>{" "}
                    <span className="text-slate-700">{body}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                    <span>{relativeTime(row.created_at)}</span>
                    {href ? (
                      <Link
                        href={href}
                        className="underline decoration-dotted hover:text-slate-900"
                      >
                        open →
                      </Link>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {items.length} loaded
        </span>
        {hasMore ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => fetchPage(page + 1, type, false)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span className="text-xs text-slate-400">No more activity</span>
        )}
      </div>
    </section>
  );
}
