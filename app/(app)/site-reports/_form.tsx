"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  enqueue,
  isWriteQueueSupported,
  type EnqueueError,
} from "@/lib/offline/write-queue";

/**
 * The "new site report" form — extracted from new/page.tsx so it can carry the
 * offline branch, on exactly the proven SnagForm pattern
 * (app/(app)/snags/_form.tsx).
 *
 * It is a CLIENT component ONLY because of that branch. With a connection it
 * still posts straight to the `createSiteReport` server action with no client
 * state, so the online path is unchanged and works with JavaScript disabled.
 *
 * ── The offline branch (`offline` prop — DRAFT only) ──────────────────────────
 * When `offline` is supplied and the device has no connectivity, submit is
 * intercepted and the report header is written to the local outbox
 * (lib/offline/write-queue.ts) instead of posted. The wording is the whole
 * point: "Saved on this device" — never a bare "Saved".
 *
 * Two honest differences from the online path, both stated in the UI:
 *   · it syncs as a DRAFT — the lifecycle (ready_for_review → approved →
 *     issued, with a customer-visible snapshot frozen at issue) stays online
 *     only (lib/offline/registry.ts);
 *   · SOURCE GATHERING happens at the server. Online, CrewFlow gathers the
 *     period's diary entries, snags and toolbox talks into the draft as you
 *     create it; offline it cannot read them, so nothing is gathered until the
 *     draft reaches the server. Photos are edited on the draft online too.
 */

/** Server-trusted identity, from the page's own `requireOrgContext()`. */
export type SiteReportOfflineConfig = { userId: string; orgId: string };

export type SiteReportJobOption = { id: string; label: string };

/** Every field the create schema (lib/site-reports/schema.ts) reads from the form. */
const FIELDS = ["job_id", "title", "period_start", "period_end"] as const;

/** Every message is specific and actionable — never "something went wrong". */
const ENQUEUE_ERROR: Record<EnqueueError, string> = {
  unsupported:
    "This browser can't save reports offline. Reconnect and create again — your text is still here.",
  unknown_kind: "This form can't be saved offline. Reconnect and create again.",
  invalid_payload:
    "Check the job and dates above (the end date can't be before the start), then save again — nothing has been lost.",
  too_large:
    "This report is too large to hold on the device. Reconnect and create it.",
  queue_full:
    "This device is already holding the maximum number of unsynced items. Get a signal and let them sync before adding more — your text is still here.",
  store_full:
    "There's no room left on this device for another unsynced item. Get a signal and let them sync — your text is still here.",
  quota_exceeded:
    "The device is out of storage, so this report was NOT saved. Free some space, or reconnect and create — your text is still here.",
  write_failed:
    "Couldn't save this report on the device. Don't close this page — reconnect and create again.",
};

type OfflineState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

const input =
  "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const label = "block text-sm font-medium text-slate-800";

export function SiteReportForm({
  action,
  jobs,
  presetJob,
  defaultPeriodStart,
  defaultPeriodEnd,
  offline,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: SiteReportJobOption[];
  presetJob?: string;
  defaultPeriodStart: string;
  defaultPeriodEnd: string;
  /** Present ⇒ this form may be saved offline (as a draft). Absent ⇒ online only. */
  offline?: SiteReportOfflineConfig;
}) {
  const [online, setOnline] = useState(true);
  const [state, setState] = useState<OfflineState>({ kind: "idle" });

  // `navigator.onLine` is read ONLY to choose a path, never as proof of
  // anything — the diary form documents the known one-bar-of-signal limitation
  // and it applies here unchanged (app/(app)/diary/_form.tsx).
  useEffect(() => {
    const set = () =>
      setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    set();
    window.addEventListener("online", set);
    window.addEventListener("offline", set);
    return () => {
      window.removeEventListener("online", set);
      window.removeEventListener("offline", set);
    };
  }, []);

  const queueFrom = useCallback(
    async (form: HTMLFormElement): Promise<boolean> => {
      if (!offline) return false;
      setState({ kind: "saving" });
      const fd = new FormData(form);
      const payload: Record<string, string> = {};
      for (const f of FIELDS) payload[f] = String(fd.get(f) ?? "");
      const res = await enqueue({
        userId: offline.userId,
        orgId: offline.orgId,
        kind: "site_report.create",
        payload,
      });
      if (!res.ok) {
        // LOUD failure. The form is deliberately NOT reset, so the words are
        // still on screen to copy or retry with.
        setState({ kind: "error", message: ENQUEUE_ERROR[res.error] });
        return false;
      }
      setState({ kind: "queued" });
      // Tell the header outbox immediately — it must not wait for a reload to
      // start reporting work it is now responsible for.
      window.dispatchEvent(new Event("crewflow:outbox-changed"));
      form.reset();
      return true;
    },
    [offline],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      if (!offline || !isWriteQueueSupported()) return; // online-only form
      if (online) return; // let the server action handle it
      e.preventDefault();
      void queueFrom(e.currentTarget);
    },
    [offline, online, queueFrom],
  );

  const canQueue = Boolean(offline) && isWriteQueueSupported();

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      // Native validation stays ON offline: a missing job or date must be caught
      // at the field, immediately, not by the registry schema after queuing.
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-site-report-form
    >
      {/* Honest, persistent connectivity state — shown BEFORE the user types. */}
      {!online ? (
        <div
          role="status"
          data-offline-notice
          className={`rounded-md border px-3 py-2 text-sm ${
            canQueue
              ? "border-amber-300 bg-amber-50 text-amber-900"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {canQueue ? (
            <>
              <strong>No signal.</strong> You can still start the report — it will
              be saved on this device as a <strong>draft</strong>. This
              period&apos;s diary entries, snags and toolbox talks are gathered
              when it reaches the server, so nothing is gathered until it syncs.
            </>
          ) : (
            <>
              <strong>No signal.</strong> This browser can&apos;t hold a report
              offline, so creating one needs a connection.
            </>
          )}
        </div>
      ) : null}

      {state.kind === "queued" ? (
        <div
          role="status"
          data-offline-queued
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <strong>Saved on this device.</strong> Not sent yet — when you get a
          signal it will be saved as a draft in Site reports (gathering this
          period&apos;s records then), for you to review and issue. Don&apos;t sign
          out until it has, or it will be deleted from this device.
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          role="alert"
          data-offline-error
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <strong>Not saved.</strong> {state.message}
        </div>
      ) : null}

      <div>
        <label htmlFor="title" className={label}>
          Report title<span className="ml-0.5 text-red-500">*</span>
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          autoFocus
          placeholder="Weekly progress report — week 12"
          className={input}
        />
      </div>

      <div>
        <label htmlFor="job_id" className={label}>
          Job / site<span className="ml-0.5 text-red-500">*</span>
        </label>
        <select
          id="job_id"
          name="job_id"
          required
          defaultValue={presetJob ?? ""}
          className={input}
        >
          <option value="" disabled>
            Choose a job…
          </option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="period_start" className={label}>
            Period start<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="period_start"
            name="period_start"
            type="date"
            required
            defaultValue={defaultPeriodStart}
            className={input}
          />
        </div>
        <div>
          <label htmlFor="period_end" className={label}>
            Period end<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="period_end"
            name="period_end"
            type="date"
            required
            defaultValue={defaultPeriodEnd}
            className={input}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={state.kind === "saving" || (!online && !canQueue)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {state.kind === "saving"
            ? "Saving…"
            : !online && canQueue
              ? "Save on this device"
              : "Gather & create draft"}
        </button>
        <Link
          href="/site-reports"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
