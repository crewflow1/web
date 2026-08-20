"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { SCOPE_LABELS, type Scope } from "@/lib/api-auth/scopes";
import { installApp, uninstallApp, type InstallFormValues } from "./actions";

/**
 * /marketplace tenant client forms — the CONSENT install + one-time key reveal.
 *
 * The install form shows the EXACT scopes the app requests as a consent
 * checklist the tenant must acknowledge (a single explicit consent tick). On
 * success the install-bound API key is revealed ONCE — it lives only in this
 * component's ephemeral state (never storage, cookie, log or URL); a refresh
 * loses it, by design.
 */

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function OneTimeKeyReveal({ plaintext }: { plaintext: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">
        Copy the app&apos;s API key now — you will not see it again.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        The app authenticates with this key on the CrewFlow API. CrewFlow stores
        only a fingerprint — if it is lost, remove the app and reinstall it.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="max-w-full overflow-x-auto rounded-md border border-amber-200 bg-white px-3 py-2 font-mono text-xs text-slate-900">
          {plaintext}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(plaintext);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard can be unavailable — the key is on screen to copy.
            }
          }}
          className="inline-flex items-center rounded-md border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900 transition hover:bg-amber-100"
        >
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>
    </div>
  );
}

export function InstallForm({
  listingId,
  listingName,
  scopes,
  hasWebhook,
}: {
  listingId: string;
  listingName: string;
  scopes: readonly string[];
  hasWebhook: boolean;
}) {
  const [state, action] = useActionState<FormState<InstallFormValues>, FormData>(
    installApp,
    INITIAL_FORM_STATE as FormState<InstallFormValues>,
  );

  return (
    <div>
      <form action={action} className="space-y-3">
        <input type="hidden" name="listing_id" value={listingId} />

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            This app is requesting access to
          </p>
          <ul className="mt-2 space-y-1">
            {scopes.length === 0 ? (
              <li className="text-sm text-slate-500">No data access.</li>
            ) : (
              scopes.map((s) => (
                <li key={s} className="flex items-center gap-2 text-sm text-slate-700">
                  <span aria-hidden className="text-slate-400">
                    •
                  </span>
                  <span className="font-medium">
                    {SCOPE_LABELS[s as Scope] ?? s}
                  </span>
                  <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px] text-slate-500">
                    {s}
                  </code>
                </li>
              ))
            )}
            {hasWebhook ? (
              <li className="flex items-center gap-2 text-sm text-slate-700">
                <span aria-hidden className="text-slate-400">
                  •
                </span>
                <span className="font-medium">Receive event webhooks</span>
              </li>
            ) : null}
          </ul>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" name="consent" className="mt-0.5 h-4 w-4 rounded border-slate-300" required />
          <span>
            I authorise <span className="font-medium">{listingName}</span> to
            access my organisation&apos;s data with exactly the access listed
            above, using a dedicated API key.
          </span>
        </label>
        {state.fieldErrors.consent ? (
          <p className="text-xs text-red-600">{state.fieldErrors.consent}</p>
        ) : null}
        {state.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}

        <SubmitButton label="Install app" pendingLabel="Installing…" />
      </form>

      {state.ok && typeof state.values.plaintext === "string" ? (
        <OneTimeKeyReveal plaintext={state.values.plaintext} />
      ) : null}
    </div>
  );
}

export function UninstallButton({
  installId,
  listingName,
}: {
  installId: string;
  listingName: string;
}) {
  const [state, action] = useActionState<FormState<Record<string, never>>, FormData>(
    uninstallApp,
    INITIAL_FORM_STATE as FormState<Record<string, never>>,
  );

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Remove "${listingName}"? Its API key is revoked immediately and its access ends. This cannot be undone.`,
          )
        ) {
          e.preventDefault();
        }
      }}
      className="inline"
    >
      <input type="hidden" name="install_id" value={installId} />
      <button
        type="submit"
        className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50"
      >
        Remove
      </button>
      {state.error ? <p className="mt-1 text-xs text-red-600">{state.error}</p> : null}
    </form>
  );
}
