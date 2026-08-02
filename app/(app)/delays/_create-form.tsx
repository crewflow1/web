"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  enqueue,
  isWriteQueueSupported,
  type EnqueueError,
} from "@/lib/offline/write-queue";
import { DelayEventFields, hintClass, inputClass, labelClass } from "./_form-fields";

/**
 * The CREATE-only client wrapper for a delay event — extracted from
 * new/page.tsx so it can carry the offline branch, on exactly the proven
 * SnagForm pattern (app/(app)/snags/_form.tsx).
 *
 * It is a CLIENT component ONLY for that branch. With a connection it still
 * posts straight to the `createDelayEvent` server action with no client state,
 * so the online path is unchanged and works with JavaScript disabled.
 *
 * It renders the SHARED `DelayEventFields` block (the one owner of the inputs,
 * used by the draft-EDIT form too). The edit form deliberately gets NO offline
 * branch — replaying an edit hours later would silently revert a change made in
 * the meantime, and there is no conflict UI to ask with (lib/offline/registry.ts).
 * Wrapping here — not converting `_form-fields.tsx` — keeps the edit form a plain
 * server-action form.
 *
 * ── The offline branch (`offline` prop — CREATE only) ─────────────────────────
 * When `offline` is supplied and the device has no connectivity, submit is
 * intercepted and the draft is written to the local outbox
 * (lib/offline/write-queue.ts) instead of posted. The wording is the whole
 * point: "Saved on this device" — never a bare "Saved". The header outbox owns
 * the rest of the story.
 *
 * EVIDENCE LINKS (diary entry / variation) are UNAVAILABLE offline: they are
 * job-scoped lookups the device cannot resolve with no signal, so the pickers
 * are withheld and the form says so honestly — they are added by editing the
 * draft once it has synced. Photos are excluded for the same reason (the queue
 * carries JSON, never binary).
 */

/** Server-trusted identity, from the page's own `requireOrgContext()`. */
export type DelayOfflineConfig = { userId: string; orgId: string };

export type DelayJobOption = { id: string; label: string };

/** Every field the create schema (lib/eot/schema.ts) reads from the form. */
const FIELDS = [
  "jobId",
  "category",
  "startedOn",
  "endedOn",
  "workingDaysLost",
  "description",
  "diaryEntryId",
  "variationQuoteId",
  "weatherDistrict",
] as const;

/** Every message is specific and actionable — never "something went wrong". */
const ENQUEUE_ERROR: Record<EnqueueError, string> = {
  unsupported:
    "This browser can't save delays offline. Reconnect and save again — your text is still here.",
  unknown_kind: "This form can't be saved offline. Reconnect and save again.",
  invalid_payload:
    "Check the fields above (a job and a start date are required), then save again — nothing has been lost.",
  too_large:
    "This delay is too long to hold on the device. Shorten what happened, or reconnect and save.",
  queue_full:
    "This device is already holding the maximum number of unsynced items. Get a signal and let them sync before adding more — your text is still here.",
  store_full:
    "There's no room left on this device for another unsynced item. Get a signal and let them sync — your text is still here.",
  quota_exceeded:
    "The device is out of storage, so this delay was NOT saved. Free some space, or reconnect and save — your text is still here.",
  write_failed:
    "Couldn't save this delay on the device. Don't close this page — reconnect and save again.",
};

type OfflineState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function DelayCreateForm({
  action,
  jobs,
  preselectedJobId,
  diaryOptions,
  variationOptions,
  offline,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: DelayJobOption[];
  preselectedJobId?: string;
  /** Null = no job chosen yet (pickers withheld); otherwise this job's entries. */
  diaryOptions: Array<{ id: string; label: string }> | null;
  variationOptions: Array<{ id: string; label: string }> | null;
  /** Present ⇒ this form may be saved offline. Absent ⇒ online only. */
  offline?: DelayOfflineConfig;
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
        kind: "delay_event.create",
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
  // Evidence pickers can only resolve with a connection. Offline, withhold the
  // live pickers rather than render stale/empty ones, and say so below.
  const evidenceAvailable = online;

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      // Native validation stays ON offline: a missing job or start date must be
      // caught at the field, immediately, not by the registry schema after queuing.
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-delay-create-form
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
              <strong>No signal.</strong> You can still log the delay — it will be
              saved on this device as a <strong>draft</strong> and sent as soon as
              you have a connection.
            </>
          ) : (
            <>
              <strong>No signal.</strong> This browser can&apos;t hold a delay
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
          <strong>Saved on this device.</strong> Not sent yet — it will sync as a
          draft when you get a signal. Don&apos;t sign out until it has, or it will
          be deleted from this device.
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
        <label htmlFor="jobId" className={labelClass}>
          Job<span className="ml-0.5 text-red-500">*</span>
        </label>
        <select
          id="jobId"
          name="jobId"
          required
          defaultValue={preselectedJobId ?? ""}
          className={inputClass}
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

      {/* Shared field block — the one owner of the inputs. Offline, the diary /
          variation pickers are withheld (they need a connection to resolve),
          leaving category, dates, days-lost, what-happened and the postcode
          district — all authorable with no signal. */}
      <DelayEventFields
        diaryOptions={evidenceAvailable ? diaryOptions : null}
        variationOptions={evidenceAvailable ? variationOptions : null}
      />

      {!evidenceAvailable ? (
        <p data-offline-evidence-unavailable className={hintClass}>
          Evidence links (site diary entry, variation) and photos need a connection,
          so they can&apos;t be added now. Open the draft and add them once it has
          synced.
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Link href="/delays" className="text-sm text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
        <button
          type="submit"
          disabled={state.kind === "saving" || (!online && !canQueue)}
          className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {state.kind === "saving"
            ? "Saving…"
            : !online && canQueue
              ? "Save on this device"
              : "Save draft"}
        </button>
      </div>
    </form>
  );
}
