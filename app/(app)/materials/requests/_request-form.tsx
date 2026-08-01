"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";
import {
  MATERIAL_REQUEST_PRIORITIES,
  MATERIAL_REQUEST_PRIORITY_LABEL,
  type MaterialRequestFormInput,
} from "@/lib/material-requests/schema";
import {
  enqueue,
  isWriteQueueSupported,
  type EnqueueError,
} from "@/lib/offline/write-queue";

/**
 * The worker's "I need this on site" form.
 *
 * MOBILE-FIRST, AND MEANT IT. This is used one-handed, outdoors, in gloves, on
 * a 375px phone. Every decision below follows from that:
 *   · Lines stack as CARDS, never a table — a 5-column table at 375px gives
 *     each cell about 60px and turns every description into four lines.
 *   · Description is the first and biggest field, because free text is the
 *     PRIMARY path (20261066 note 1): you must be able to ask for the odd-size
 *     lintel without anyone creating a catalogue item first.
 *   · `inputMode="decimal"` on quantity brings up the number pad — a plain
 *     text keyboard here is the difference between a 2-second entry and a
 *     10-second one.
 *   · Controls are ≥44px tall (the iOS touch-target floor).
 *   · ONE primary button. "Send request" creates AND submits: 'draft' is the
 *     database's born-draft rule, not a step anyone on site should think about.
 *     "Save as draft" is present but secondary, for the half-written list.
 *
 * Lines ride as JSON in a hidden field — the established house pattern
 * (_builder.tsx for purchase orders), so the action parses one shape.
 *
 * ── The offline branch (`offline` prop — DRAFT only) ──────────────────────────
 * When `offline` is supplied and the device has no connectivity, submit is
 * intercepted and the ask is written to the local outbox
 * (lib/offline/write-queue.ts) instead of posted — diary-form pattern, diary
 * wording: "Saved on this device", never "Sent". Two honest differences from
 * the online path, both said out loud in the UI:
 *   · it syncs as a DRAFT — submission is a lifecycle transition with
 *     server-pinned provenance and notification fan-out, deliberately not
 *     offline-writable (lib/offline/registry.ts) — so after it syncs the
 *     worker opens Materials and taps Send;
 *   · the request number is allocated when it syncs, never on the device, so
 *     the per-org sequence cannot fork.
 */

type Row = { description: string; qty: string; unit: string };

const blankRow = (): Row => ({ description: "", qty: "1", unit: "ea" });

/** Units a UK site actually asks in, in rough frequency order. */
const UNITS = ["ea", "bag", "m", "m2", "m3", "box", "pack", "roll", "sheet", "t", "L"];

/** Server-trusted identity, from the page's own `requireOrgContext()`. */
export type MaterialRequestOfflineConfig = { userId: string; orgId: string };

/** Every message is specific and actionable — never "something went wrong". */
const ENQUEUE_ERROR: Record<EnqueueError, string> = {
  unsupported:
    "This browser can't save requests offline. Reconnect and send again — your list is still here.",
  unknown_kind: "This form can't be saved offline. Reconnect and send again.",
  invalid_payload:
    "Check the materials and quantities above, then save again — nothing has been lost.",
  too_large:
    "This request is too long to hold on the device. Shorten it, or reconnect and send.",
  queue_full:
    "This device is already holding the maximum number of unsynced items. Get a signal and let them sync before adding more — your list is still here.",
  store_full:
    "There's no room left on this device for another unsynced item. Get a signal and let them sync — your list is still here.",
  quota_exceeded:
    "The device is out of storage, so this request was NOT saved. Free some space, or reconnect and send — your list is still here.",
  write_failed:
    "Couldn't save this request on the device. Don't close this page — reconnect and send again.",
};

type OfflineState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

export function MaterialRequestForm({
  action,
  jobId,
  jobLabel,
  backHref,
  offline,
}: {
  action: (
    prev: FormState<MaterialRequestFormInput>,
    formData: FormData,
  ) => Promise<FormState<MaterialRequestFormInput>>;
  jobId?: string | null;
  jobLabel?: string | null;
  backHref: string;
  /** Present ⇒ this form may be saved offline (as a draft). Absent ⇒ online only. */
  offline?: MaterialRequestOfflineConfig;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [intent, setIntent] = useState<"submit" | "draft">("submit");
  const [online, setOnline] = useState(true);
  const [offlineState, setOfflineState] = useState<OfflineState>({ kind: "idle" });

  // FULL DOCUMENT LOAD, never router.push. Next 15.5 silently drops a
  // navigation at route-swap depth ≥4 — the server work lands and the URL
  // simply doesn't move (the deep-swap commit race). StateForm does the same.
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  // `navigator.onLine` is read ONLY to choose a path, never as proof of
  // anything — the diary form documents the known one-bar-of-signal
  // limitation (app/(app)/diary/_form.tsx) and it applies here unchanged.
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

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, blankRow()]);
  const removeRow = (i: number) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const lines = rows
    .filter((r) => r.description.trim() !== "")
    .map((r) => ({
      description: r.description.trim(),
      qty: Number(r.qty) || 0,
      unit: r.unit.trim() || "ea",
    }));
  const payload = JSON.stringify(lines);

  const nothingToSend = rows.every((r) => r.description.trim() === "");
  const canQueue = Boolean(offline) && isWriteQueueSupported();

  const queueFrom = useCallback(
    async (form: HTMLFormElement): Promise<void> => {
      if (!offline) return;
      setOfflineState({ kind: "saving" });
      const fd = new FormData(form);
      const res = await enqueue({
        userId: offline.userId,
        orgId: offline.orgId,
        kind: "material_request.create",
        payload: {
          job_id: String(fd.get("job_id") ?? ""),
          needed_by: String(fd.get("needed_by") ?? ""),
          priority: String(fd.get("priority") ?? "normal"),
          notes: String(fd.get("notes") ?? ""),
          lines,
        },
      });
      if (!res.ok) {
        // LOUD failure. The rows are deliberately NOT reset, so the list the
        // worker built is still on screen to copy or retry with.
        setOfflineState({ kind: "error", message: ENQUEUE_ERROR[res.error] });
        return;
      }
      setOfflineState({ kind: "queued" });
      // Tell the header outbox immediately — it must not wait for a reload to
      // start reporting work it is now responsible for.
      window.dispatchEvent(new Event("crewflow:outbox-changed"));
      form.reset();
      setRows([blankRow()]);
    },
    [offline, lines],
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

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-5">
      {state.error ? <FormErrorBanner error={state.error} /> : null}

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
              <strong>No signal.</strong> You can still write the request — it
              will be saved on this device, and when you get a connection it
              will appear in Materials as a <strong>draft</strong> for you to
              send.
            </>
          ) : (
            <>
              <strong>No signal.</strong> This browser can&apos;t hold a request
              offline, so sending needs a connection.
            </>
          )}
        </div>
      ) : null}

      {offlineState.kind === "queued" ? (
        <div
          role="status"
          data-offline-queued
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <strong>Saved on this device.</strong> Not sent yet — when you get a
          signal it will be saved as a draft in Materials; open it and tap Send.
          Don&apos;t sign out until then, or it will be deleted from this device.
        </div>
      ) : null}
      {offlineState.kind === "error" ? (
        <div
          role="alert"
          data-offline-error
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <strong>Not saved.</strong> {offlineState.message}
        </div>
      ) : null}

      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="intent" value={intent} />
      {jobId ? <input type="hidden" name="job_id" value={jobId} /> : null}

      {jobLabel ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          For <span className="font-semibold text-slate-900">{jobLabel}</span>
        </p>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-900">What do you need?</legend>

        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
          >
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Material</span>
              <input
                value={row.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="e.g. Cement 25kg"
                maxLength={500}
                autoComplete="off"
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </label>

            <div className="mt-2 flex gap-2">
              <label className="w-24 shrink-0">
                <span className="text-xs font-medium text-slate-600">Qty</span>
                <input
                  value={row.qty}
                  onChange={(e) => update(i, { qty: e.target.value })}
                  // The number pad, not the alphabet keyboard.
                  inputMode="decimal"
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </label>
              <label className="flex-1">
                <span className="text-xs font-medium text-slate-600">Unit</span>
                <input
                  value={row.unit}
                  onChange={(e) => update(i, { unit: e.target.value })}
                  list="material-units"
                  maxLength={20}
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </label>
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                aria-label={`Remove ${row.description || `line ${i + 1}`}`}
                className="mt-5 min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-sm text-slate-600 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        ))}

        <datalist id="material-units">
          {UNITS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>

        <button
          type="button"
          onClick={addRow}
          className="min-h-11 w-full rounded-lg border border-dashed border-slate-400 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          + Add another material
        </button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Needed by</span>
          <input
            type="date"
            name="needed_by"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Priority</span>
          <select
            name="priority"
            defaultValue="normal"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          >
            {MATERIAL_REQUEST_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {MATERIAL_REQUEST_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Anything the office should know? <span className="text-slate-400">(optional)</span>
        </span>
        <textarea
          name="notes"
          rows={3}
          maxLength={5000}
          placeholder="e.g. deliver to the rear gate before 10am"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
        />
      </label>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        {!online && canQueue ? (
          // Offline there is ONE honest button. "Send request" would be a lie
          // (nothing is sent), and the queued item is a draft either way.
          <button
            type="submit"
            disabled={offlineState.kind === "saving" || nothingToSend}
            className="min-h-12 flex-1 rounded-lg bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {offlineState.kind === "saving" ? "Saving…" : "Save on this device"}
          </button>
        ) : (
          <>
            <button
              type="submit"
              onClick={() => setIntent("submit")}
              disabled={pending || nothingToSend || (!online && !canQueue)}
              className="min-h-12 flex-1 rounded-lg bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send request"}
            </button>
            <button
              type="submit"
              onClick={() => setIntent("draft")}
              disabled={pending || nothingToSend || (!online && !canQueue)}
              className="min-h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:flex-none"
            >
              Save as draft
            </button>
          </>
        )}
        <a
          href={backHref}
          className="flex min-h-12 items-center justify-center rounded-lg px-4 text-sm text-slate-500 hover:text-slate-800"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
