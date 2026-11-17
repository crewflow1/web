"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/modal";
import { buttonClass } from "@/components/ui/button";
import {
  cancelSubscriptionAction,
  resumeSubscriptionAction,
  type CancelFormState,
  type ResumeFormState,
} from "@/app/account/billing/actions";
import { CANCELLATION_COPY } from "@/lib/billing/cancellation";

/**
 * What cancelling would do, computed on the server just before render
 * (previewCancellation). `accessEndsAt` is posted back so the server refuses if
 * the subscription renewed in between — the owner is only ever committed to the
 * date they were shown.
 */
export type CancelPreviewView =
  | { kind: "end_of_period"; accessEndsAt: number; dateLabel: string }
  | { kind: "immediate" };

/**
 * The confirm button. A solid red fill, spelled out rather than layered onto
 * buttonClass("primary"): that variant brings its own `bg-slate-900`, and two
 * background utilities on one element resolve by stylesheet order, not by the
 * order they are written in. White on red-700 is 6.5:1 (AA).
 */
const CONFIRM_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-md bg-red-700 px-4 py-2 text-sm " +
  "font-semibold text-white shadow-sm transition hover:bg-red-800 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Cancel subscription — the control and its ONE confirmation step.
 *
 * Deliberately plain. The trigger says what it does. The dialog states, before
 * anything happens, exactly what stops, when, what happens to money already
 * paid or still owed, and what happens to the data — the same sentences the
 * confirmation email repeats (lib/billing/cancellation.ts CANCELLATION_COPY).
 * There is no retention offer, no countdown, no second "are you really sure",
 * and no survey: the reason box is optional and says so. Focus opens on "Keep
 * subscription" so Enter on a mis-click does not cancel.
 *
 * On success the action returns `redirectTo` and we do a FULL navigation: the
 * workspace has just lost access, so the (app) shell this may be rendered in is
 * no longer valid for this user.
 */
export function CancelSubscription({
  orgId,
  orgName,
  /** False when the workspace has no card subscription (nothing to bill). */
  hasSubscription,
  preview,
  triggerLabel = "Cancel subscription",
  dataExportHref,
}: {
  orgId: string;
  orgName: string;
  hasSubscription: boolean;
  preview: CancelPreviewView;
  triggerLabel?: string;
  /** Where the owner can download their data right now, if reachable. */
  dataExportHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [state, formAction, pending] = useActionState<CancelFormState, FormData>(
    cancelSubscriptionAction,
    { status: "idle" },
  );

  useEffect(() => {
    if (state.status === "done") window.location.assign(state.redirectTo);
  }, [state]);

  const done = state.status === "done";
  const busy = pending || done;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass("destructive", "md")}
      >
        {triggerLabel}
      </button>

      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        labelledBy="cancel-subscription-title"
        size="lg"
        showClose={!busy}
        initialFocus={keepRef}
      >
        <form action={formAction} className="px-6 py-6 sm:px-8 sm:py-8">
          <input type="hidden" name="expected_org_id" value={orgId} />
          {preview.kind === "end_of_period" ? (
            <input type="hidden" name="expected_access_ends_at" value={preview.accessEndsAt} />
          ) : null}

          <h2 id="cancel-subscription-title" className="text-lg font-semibold text-slate-900">
            Cancel CrewFlow for {orgName}?
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {preview.kind === "end_of_period" ? (
              <>
                Your access ends on{" "}
                <strong className="font-semibold text-slate-900" data-testid="access-end-date">
                  {preview.dateLabel}
                </strong>
                , the end of your current paid period. Here is exactly what happens.
              </>
            ) : (
              "This takes effect as soon as you confirm. Here is exactly what happens."
            )}
          </p>

          <dl className="mt-5 space-y-4 text-sm">
            <div>
              <dt className="font-semibold text-slate-900">Access</dt>
              <dd className="mt-0.5 text-slate-700">
                {preview.kind === "end_of_period"
                  ? CANCELLATION_COPY.scheduledAccess(preview.dateLabel)
                  : CANCELLATION_COPY.immediateAccess}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-900">Payments</dt>
              <dd className="mt-0.5 text-slate-700">
                {hasSubscription
                  ? CANCELLATION_COPY.charges
                  : "There's no card subscription on this account, so there is nothing further to charge."}
              </dd>
            </div>
            {hasSubscription ? (
              <>
                <div>
                  <dt className="font-semibold text-slate-900">Unpaid invoices</dt>
                  <dd className="mt-0.5 text-slate-700">{CANCELLATION_COPY.unpaid}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">Refunds</dt>
                  <dd className="mt-0.5 text-slate-700">
                    {CANCELLATION_COPY.refund}{" "}
                    <Link href="/terms" className="font-medium text-slate-900 underline">
                      Terms
                    </Link>
                  </dd>
                </div>
              </>
            ) : null}
            <div>
              <dt className="font-semibold text-slate-900">Your data</dt>
              <dd className="mt-0.5 text-slate-700">
                {CANCELLATION_COPY.data}
                {preview.kind === "end_of_period" ? ` ${CANCELLATION_COPY.undo(preview.dateLabel)}` : ""}
                {dataExportHref ? (
                  <>
                    {" "}
                    <a href={dataExportHref} className="font-medium text-slate-900 underline">
                      Download an export now
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          </dl>

          <div className="mt-5">
            <label htmlFor="cancel-reason" className="block text-sm font-medium text-slate-900">
              Why are you cancelling?{" "}
              <span className="font-normal text-slate-600">Optional</span>
            </label>
            <textarea
              id="cancel-reason"
              name="reason"
              rows={2}
              maxLength={1000}
              disabled={busy}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:bg-slate-50"
            />
          </div>

          {state.status === "error" ? (
            <p
              role="alert"
              className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {state.message}
            </p>
          ) : null}
          {done ? (
            <p role="status" className="mt-4 text-sm text-slate-700">
              {preview.kind === "end_of_period" ? "Cancellation scheduled. Updating your billing page…" : "Cancelled. Taking you to your billing page…"}
            </p>
          ) : null}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              ref={keepRef}
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className={buttonClass("secondary", "md")}
            >
              Keep subscription
            </button>
            <button
              type="submit"
              disabled={busy}
              className={CONFIRM_CLASS}
            >
              {pending
                ? "Cancelling…"
                : preview.kind === "end_of_period"
                  ? `Cancel at end of period (${preview.dateLabel})`
                  : "Cancel subscription now"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/**
 * Undo a SCHEDULED cancellation before it takes effect. One click, no dialog:
 * keeping the subscription is the safe direction.
 */
export function KeepSubscription({ orgId, dateLabel }: { orgId: string; dateLabel: string }) {
  const [state, formAction, pending] = useActionState<ResumeFormState, FormData>(
    resumeSubscriptionAction,
    { status: "idle" },
  );
  useEffect(() => {
    if (state.status === "done") window.location.assign(state.redirectTo);
  }, [state]);
  const busy = pending || state.status === "done";
  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="expected_org_id" value={orgId} />
      <button type="submit" disabled={busy} className={buttonClass("primary", "md")}>
        {busy ? "Keeping your subscription…" : `Keep my subscription (undo cancellation before ${dateLabel})`}
      </button>
      {state.status === "error" ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
