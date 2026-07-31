"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { JobOption } from "./_data";
import {
  enqueue,
  isWriteQueueSupported,
  type EnqueueError,
} from "@/lib/offline/write-queue";

/**
 * Shared diary entry form — used by both the new and edit pages so the field set
 * can never drift between them.
 *
 * It is a CLIENT component only because of the offline branch below; with a
 * connection it still posts straight to the server action with no client state, so
 * the online path is unchanged and works with JavaScript disabled.
 *
 * ── The offline branch (`offline` prop — CREATE only) ─────────────────────────
 * When `offline` is supplied and the device has no connectivity, submit is
 * intercepted and the entry is written to the local outbox
 * (lib/offline/write-queue.ts) instead of posted. The wording is the entire point
 * of this component:
 *
 *     "Saved on this device"  — not "Saved".
 *
 * A tick that implies the server has the entry when only IndexedDB does is the
 * failure mode this milestone exists to avoid. The outbox strip in the app header
 * then owns the rest of the story ("waiting to sync" → "synced" / "not accepted"),
 * so the user is never left guessing which half happened.
 *
 * EDIT has no offline branch and does not get one: replaying an update would
 * silently revert an admin's change made while the tablet had no signal, and there
 * is no conflict UI in this milestone to ask with (lib/offline/registry.ts).
 */

export type DiaryDefaults = {
  entry_date?: string;
  job_id?: string | null;
  weather?: string | null;
  labour_count?: number | null;
  work_summary?: string | null;
  delays?: string | null;
  notes?: string | null;
};

/** Server-trusted identity, from the page's own `requireOrgContext()`. */
export type DiaryOfflineConfig = { userId: string; orgId: string };

const FIELDS = [
  "entry_date",
  "job_id",
  "weather",
  "labour_count",
  "work_summary",
  "delays",
  "notes",
] as const;

/** Every message is specific and actionable — never "something went wrong". */
const ENQUEUE_ERROR: Record<EnqueueError, string> = {
  unsupported:
    "This browser can't save entries offline. Reconnect and save again — your text is still here.",
  unknown_kind: "This form can't be saved offline. Reconnect and save again.",
  invalid_payload:
    "Check the date and the fields above, then save again — nothing has been lost.",
  too_large:
    "This entry is too long to hold on the device. Shorten it, or reconnect and save.",
  queue_full:
    "This device is already holding the maximum number of unsynced entries. Get a signal and let them sync before adding more — your text is still here.",
  store_full:
    "There's no room left on this device for another unsynced entry. Get a signal and let them sync — your text is still here.",
  quota_exceeded:
    "The device is out of storage, so this entry was NOT saved. Free some space, or reconnect and save — your text is still here.",
  write_failed:
    "Couldn't save this entry on the device. Don't close this page — reconnect and save again.",
};

type OfflineState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function DiaryForm({
  action,
  jobs,
  defaults,
  submitLabel,
  cancelHref,
  hiddenId,
  offline,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: JobOption[];
  defaults?: DiaryDefaults;
  submitLabel: string;
  cancelHref: string;
  hiddenId?: string;
  /** Present ⇒ this form may be saved offline. Absent ⇒ online only. */
  offline?: DiaryOfflineConfig;
}) {
  const d = defaults ?? {};
  const [online, setOnline] = useState(true);
  const [state, setState] = useState<OfflineState>({ kind: "idle" });

  /**
   * `navigator.onLine` is read ONLY to choose a path, never as proof of anything.
   *
   * KNOWN LIMITATION, stated rather than papered over: it lies in one direction
   * that matters on site. One bar of signal, or a site wifi with no route out,
   * reports ONLINE — so the form posts to the server action and the post fails,
   * which is the same behaviour this page had before the queue existed (the entry
   * is not queued and the user sees an error). Catching that case means routing
   * the ONLINE save through client-driven submission too, which changes how every
   * successful diary save navigates; that is a bigger change than this milestone
   * should make to a working path, so it is deliberately not done here. The clean
   * no-signal case — the basement, the steel frame, aeroplane mode — is what is
   * covered. See docs/offline-write-queue.md.
   */
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
        kind: "site_diary.create",
        payload,
      });
      if (!res.ok) {
        // LOUD failure. The form is deliberately NOT reset, so the words the
        // foreman typed are still on screen to copy or retry with.
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
  const input =
    "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm";
  const label = "block text-sm font-medium text-slate-800";

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      // Native validation stays ON offline: an empty date must be caught at the
      // field, immediately, not by the registry schema after it has been queued.
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-diary-form
    >
      {hiddenId ? <input type="hidden" name="id" value={hiddenId} /> : null}

      {/* Honest, persistent connectivity state — shown BEFORE the user types, so
          nobody discovers there was no signal only after tapping Save. */}
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
              <strong>No signal.</strong> You can still write today&apos;s entry —
              it will be saved on this device and sent as soon as you have a
              connection.
            </>
          ) : (
            <>
              <strong>No signal.</strong> This browser can&apos;t hold an entry
              offline, so saving needs a connection.
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
          <strong>Saved on this device.</strong> Not sent yet — it will sync
          automatically when you get a signal. Don&apos;t sign out until it has, or
          it will be deleted from this device.
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="entry_date" className={label}>
            Date<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="entry_date"
            name="entry_date"
            type="date"
            required
            defaultValue={d.entry_date ?? ""}
            className={input}
          />
        </div>
        <div>
          <label htmlFor="job_id" className={label}>
            Job / site
          </label>
          <select
            id="job_id"
            name="job_id"
            defaultValue={d.job_id ?? ""}
            className={input}
          >
            <option value="">No job (general)</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="weather" className={label}>
            Weather
          </label>
          <input
            id="weather"
            name="weather"
            type="text"
            defaultValue={d.weather ?? ""}
            placeholder="Dry am, heavy rain pm"
            className={input}
          />
        </div>
        <div>
          <label htmlFor="labour_count" className={label}>
            People on site
          </label>
          <input
            id="labour_count"
            name="labour_count"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={d.labour_count ?? ""}
            placeholder="4"
            className={input}
          />
        </div>
      </div>

      <div>
        <label htmlFor="work_summary" className={label}>
          Work done today
        </label>
        <textarea
          id="work_summary"
          name="work_summary"
          rows={4}
          defaultValue={d.work_summary ?? ""}
          placeholder="First fix plumbing complete on plots 3-5; kitchen units delivered."
          className={input}
        />
      </div>

      <div>
        <label htmlFor="delays" className={label}>
          Delays / issues
        </label>
        <textarea
          id="delays"
          name="delays"
          rows={2}
          defaultValue={d.delays ?? ""}
          placeholder="Concrete pour delayed by rain — rescheduled to Thursday."
          className={input}
        />
      </div>

      <div>
        <label htmlFor="notes" className={label}>
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          defaultValue={d.notes ?? ""}
          placeholder="Deliveries, visitors, inspections booked…"
          className={input}
        />
        <p className="mt-1 text-xs text-slate-500">
          {canQueue && !online
            ? "Photos need a connection — add them once this entry has synced."
            : "You can add site photos once the entry is saved."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        {/* 44px minimum, full-width on a 375px phone: this is tapped with gloves on. */}
        <button
          type="submit"
          disabled={state.kind === "saving" || (!online && !canQueue)}
          className="min-h-[44px] w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 sm:w-auto"
        >
          {state.kind === "saving"
            ? "Saving…"
            : !online && canQueue
              ? "Save on this device"
              : submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
