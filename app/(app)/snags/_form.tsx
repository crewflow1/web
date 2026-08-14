"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  enqueue,
  isWriteQueueSupported,
  type EnqueueError,
} from "@/lib/offline/write-queue";
import {
  SNAG_PRIORITIES,
  SNAG_PRIORITY_LABELS,
} from "@/lib/snags/schema";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

/**
 * The "log a snag" form — extracted from the new page so it can carry the
 * offline branch, on exactly the diary form's pattern (app/(app)/diary/_form.tsx).
 *
 * It is a CLIENT component only because of that branch; with a connection it
 * still posts straight to the server action with no client state, so the online
 * path is unchanged and works with JavaScript disabled.
 *
 * ── The offline branch (`offline` prop — CREATE only) ─────────────────────────
 * When `offline` is supplied and the device has no connectivity, submit is
 * intercepted and the snag is written to the local outbox
 * (lib/offline/write-queue.ts) instead of posted. The wording is the entire
 * point: "Saved on this device" — never "Saved". A tick that implies the server
 * has the defect when only IndexedDB does is the failure mode the queue exists
 * to avoid; the outbox strip in the app header owns the rest of the story.
 *
 * Photos are EXCLUDED offline exactly as the diary excludes them (the queue
 * carries JSON, never binary) and the copy under the details field says so.
 *
 * ── The offline branch for EDIT (`mode="update"`) ─────────────────────────────
 * A snag's owned free-text/scalar detail (title, location, trade, priority, the
 * fix note, job/assignee, due date) can now be edited offline: the queued item
 * carries the row version the form was rendered with and the values it was opened
 * with, so the server 3-way-merges the edit against any concurrent office change —
 * a clash on the SAME field is surfaced in the outbox, never silently reverted
 * (lib/offline/merge.ts). The STATUS lifecycle stays online-only: replaying
 * "fixed" hours later carries server-pinned provenance a merge cannot honour, and
 * the update schema has no status field to carry it (lib/offline/registry.ts).
 */

export type SnagJobOption = { id: string; label: string };
export type SnagStaffOption = { id: string; label: string };

export type SnagDefaults = {
  title?: string | null;
  description?: string | null;
  location?: string | null;
  trade?: string | null;
  priority?: string | null;
  job_id?: string | null;
  assigned_to?: string | null;
  due_date?: string | null;
};

/** Server-trusted identity, from the page's own `requireOrgContext()`. */
export type SnagOfflineConfig = { userId: string; orgId: string };

const FIELDS = [
  "title",
  "description",
  "location",
  "trade",
  "priority",
  "job_id",
  "assigned_to",
  "due_date",
] as const;

/** Every message is specific and actionable — never "something went wrong". */
const ENQUEUE_ERROR: Record<EnqueueError, string> = {
  unsupported:
    "This browser can't save snags offline. Reconnect and save again — your text is still here.",
  unknown_kind: "This form can't be saved offline. Reconnect and save again.",
  missing_base:
    "This edit can't be saved offline right now — reconnect and save again. Your text is still here.",
  invalid_payload:
    "Check the fields above, then save again — nothing has been lost.",
  too_large:
    "This snag is too long to hold on the device. Shorten it, or reconnect and save.",
  queue_full:
    "This device is already holding the maximum number of unsynced items. Get a signal and let them sync before adding more — your text is still here.",
  store_full:
    "There's no room left on this device for another unsynced item. Get a signal and let them sync — your text is still here.",
  quota_exceeded:
    "The device is out of storage, so this snag was NOT saved. Free some space, or reconnect and save — your text is still here.",
  write_failed:
    "Couldn't save this snag on the device. Don't close this page — reconnect and save again.",
};

type OfflineState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function SnagForm({
  action,
  jobs,
  staff,
  presetJob,
  offline,
  defaults,
  hiddenId,
  mode = "create",
  baseVersion,
  submitLabel,
  cancelHref = "/snags",
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: SnagJobOption[];
  staff: SnagStaffOption[];
  presetJob?: string;
  /** Present ⇒ this form may be saved offline. Absent ⇒ online only. */
  offline?: SnagOfflineConfig;
  /** Edit mode: pre-fill from the existing snag. */
  defaults?: SnagDefaults;
  hiddenId?: string;
  /** "update" ⇒ an offline save queues a conflict-resolved edit, not a create. */
  mode?: "create" | "update";
  /** UPDATE only: the row version (updated_at) this form was rendered with. */
  baseVersion?: string;
  submitLabel?: string;
  cancelHref?: string;
}) {
  const d = defaults ?? {};
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
      const res =
        mode === "update" && hiddenId && baseVersion
          ? await enqueue({
              userId: offline.userId,
              orgId: offline.orgId,
              kind: "snag.update",
              payload: { id: hiddenId, ...payload },
              baseVersion,
              baseValues: {
                title: d.title ?? "",
                description: d.description ?? "",
                location: d.location ?? "",
                trade: d.trade ?? "",
                priority: d.priority ?? "medium",
                job_id: d.job_id ?? "",
                assigned_to: d.assigned_to ?? "",
                due_date: d.due_date ?? "",
              },
            })
          : await enqueue({
              userId: offline.userId,
              orgId: offline.orgId,
              kind: "snag.create",
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
    [offline, mode, hiddenId, baseVersion, d],
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

  // PICKER-COMPLETION (F-1). job is OPTIONAL here (a snag need not belong to a
  // job), so this <select> cannot lean on `required` the way the delay/report
  // job pickers do. The page pages the complete job set, but preserve the
  // deep-linked `?job=` preset regardless so an out-of-list id is ALWAYS a
  // selectable <option>: without it the browser falls to the leading
  // "No job (general)" empty option and an untouched submit silently NULLs the
  // job (optionalUuid coerces "" → undefined). A preset that isn't a real job in
  // this org is rejected LOUDLY by createSnagRecord's job guard, not mis-filed.
  const selectedJob = d.job_id ?? presetJob ?? "";
  const jobOptions = withPreservedOption(jobs, selectedJob || null, (id) => ({
    id,
    label: "Selected job",
  }));

  // PICKER-COMPLETION (F-1) for the assignee too, now this form edits: a saved
  // assignee who has dropped out of the recent-staff list must stay a selectable
  // <option>, or an untouched save would submit '' and silently unassign them.
  const selectedAssignee = d.assigned_to ?? "";
  const staffOptions = withPreservedOption(
    staff,
    selectedAssignee || null,
    (id) => ({ id, label: "Current assignee" }),
  );

  const input =
    "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
  const label = "block text-sm font-medium text-slate-800";

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      // Native validation stays ON offline: an empty title must be caught at
      // the field, immediately, not by the registry schema after queuing.
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-snag-form
    >
      {hiddenId ? <input type="hidden" name="id" value={hiddenId} /> : null}

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
              <strong>No signal.</strong> You can still log the snag — it will be
              saved on this device and sent as soon as you have a connection.
            </>
          ) : (
            <>
              <strong>No signal.</strong> This browser can&apos;t hold a snag
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
          automatically when you get a signal. Don&apos;t sign out until it has,
          or it will be deleted from this device.
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
          What&rsquo;s the defect?<span className="ml-0.5 text-red-500">*</span>
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          autoFocus
          defaultValue={d.title ?? ""}
          placeholder="Cracked tile in the ensuite"
          className={input}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="priority" className={label}>
            Priority
          </label>
          <select
            id="priority"
            name="priority"
            defaultValue={d.priority ?? "medium"}
            className={input}
          >
            {SNAG_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {SNAG_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="due_date" className={label}>
            Target fix date
          </label>
          <input
            id="due_date"
            name="due_date"
            type="date"
            defaultValue={d.due_date ?? ""}
            className={input}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="job_id" className={label}>
            Job / site
          </label>
          <select
            id="job_id"
            name="job_id"
            defaultValue={selectedJob}
            className={input}
          >
            <option value="">No job (general)</option>
            {jobOptions.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="assigned_to" className={label}>
            Assign to
          </label>
          <select
            id="assigned_to"
            name="assigned_to"
            defaultValue={selectedAssignee}
            className={input}
          >
            <option value="">Unassigned</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="location" className={label}>
            Location on site
          </label>
          <input
            id="location"
            name="location"
            type="text"
            defaultValue={d.location ?? ""}
            placeholder="Kitchen, north wall"
            className={input}
          />
        </div>
        <div>
          <label htmlFor="trade" className={label}>
            Trade responsible
          </label>
          <input
            id="trade"
            name="trade"
            type="text"
            defaultValue={d.trade ?? ""}
            placeholder="Plumbing"
            className={input}
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className={label}>
          Details
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={d.description ?? ""}
          placeholder="Anything the trade needs to know to put it right."
          className={input}
        />
        <p className="mt-1 text-xs text-slate-500">
          {canQueue && !online
            ? "Photos need a connection — add them once this snag has synced."
            : "You can add photos once the snag is saved."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={state.kind === "saving" || (!online && !canQueue)}
          className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {state.kind === "saving"
            ? "Saving…"
            : !online && canQueue
              ? "Save on this device"
              : (submitLabel ?? (mode === "update" ? "Save changes" : "Log snag"))}
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
