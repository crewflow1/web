"use client";

import { useActionState } from "react";
import {
  createReportSubscription,
  deleteReportSubscription,
  type SubscribeState,
} from "./subscribe/actions";
import {
  REPORTS,
  REPORT_KEYS,
  REPORT_CADENCES,
  REPORT_CADENCE_LABEL,
} from "@/lib/reports/registry";
import type { ReportSubscription } from "@/lib/reports/subscriptions";

/**
 * Scheduled report delivery — the subscribe UI. Admin-only (the page renders it
 * only for owners/admins; the actions + RLS enforce it regardless). Route depth
 * is 1, so `useActionState` here is not the deep-swap navigation trap.
 *
 * Delivery itself runs DARK until email is configured: the report-delivery cron
 * skips cleanly when RESEND_API_KEY is unset (no send, cursor still advances),
 * so a subscription created here is honoured the moment email goes live — no
 * code change.
 */
export function ReportSubscriptionsPanel({
  subscriptions,
}: {
  subscriptions: ReportSubscription[];
}) {
  const [createState, createAction, creating] = useActionState<
    SubscribeState | null,
    FormData
  >(createReportSubscription, null);
  const [deleteState, deleteAction, deleting] = useActionState<
    SubscribeState | null,
    FormData
  >(deleteReportSubscription, null);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header>
        <h2 className="text-sm font-semibold text-slate-900">
          Scheduled delivery
        </h2>
        <p className="text-xs text-slate-500">
          Email a report to your team on a cadence. PDF or CSV, generated fresh
          each time from live figures.
        </p>
      </header>

      {/* Existing subscriptions */}
      {subscriptions.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {subscriptions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium text-slate-900">
                  {REPORTS[s.report_key]?.title ?? s.report_key}
                </span>
                <span className="ml-2 text-xs text-slate-500">
                  {s.format.toUpperCase()} · {REPORT_CADENCE_LABEL[s.cadence]} ·{" "}
                  {s.recipients.length} recipient
                  {s.recipients.length === 1 ? "" : "s"}
                </span>
                <div className="truncate text-xs text-slate-400">
                  {s.recipients.join(", ")}
                </div>
              </div>
              <form action={deleteAction}>
                <input type="hidden" name="id" value={s.id} />
                <button
                  type="submit"
                  disabled={deleting}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                >
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-500">
          No scheduled reports yet. Add one below.
        </p>
      )}

      {deleteState ? (
        <p
          role="status"
          className={`mt-2 text-xs ${deleteState.ok ? "text-emerald-700" : "text-red-600"}`}
        >
          {deleteState.message}
        </p>
      ) : null}

      {/* Add a subscription */}
      <form action={createAction} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-xs font-medium text-slate-600">
            Report
            <select
              name="report_key"
              defaultValue="overview"
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {REPORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {REPORTS[k].title}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Format
            <select
              name="format"
              defaultValue="pdf"
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="pdf">PDF</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">
            Cadence
            <select
              name="cadence"
              defaultValue="weekly"
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {REPORT_CADENCES.map((c) => (
                <option key={c} value={c}>
                  {REPORT_CADENCE_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-xs font-medium text-slate-600">
          Recipients
          <textarea
            name="recipients"
            rows={2}
            placeholder="name@company.com, another@company.com"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
          <span className="mt-1 block text-[11px] font-normal text-slate-400">
            Comma- or newline-separated email addresses (up to 20).
          </span>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-60"
          >
            {creating ? "Scheduling…" : "Schedule delivery"}
          </button>
          {createState ? (
            <span
              role="status"
              className={`text-xs ${createState.ok ? "text-emerald-700" : "text-red-600"}`}
            >
              {createState.message}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
