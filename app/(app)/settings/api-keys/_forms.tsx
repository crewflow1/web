"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { SCOPES, SCOPE_LABELS } from "@/lib/api-auth/scopes";
import { createApiKey, revokeApiKey, type ApiKeyFormValues } from "./actions";

/**
 * /settings/api-keys client forms.
 *
 * THE ONE-TIME REVEAL: the create action returns the plaintext key exactly
 * once, inside the FormState of the response that created it. It is rendered
 * below with a copy affordance and an explicit "you will not see this again".
 * It lives only in this component's ephemeral state — nothing here writes it
 * to storage, a cookie, a log, or a URL, and a refresh loses it forever
 * (that is the design, not a bug).
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
        Copy your API key now — you will not see it again.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        We store only a fingerprint of this key. If you lose it, revoke it and
        create a new one.
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
              // Clipboard can be unavailable (permissions/http) — the key is
              // still on screen to copy manually.
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

export function CreateApiKeyForm() {
  const [state, action] = useActionState<FormState<ApiKeyFormValues>, FormData>(
    createApiKey,
    INITIAL_FORM_STATE as FormState<ApiKeyFormValues>,
  );

  return (
    <div>
      <form action={action} className="space-y-4">
        {state.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}

        <div>
          <label htmlFor="api-key-name" className="block text-sm font-medium text-slate-700">
            Key name
          </label>
          <input
            id="api-key-name"
            name="name"
            type="text"
            required
            maxLength={100}
            defaultValue={typeof state.values.name === "string" ? state.values.name : ""}
            placeholder="e.g. Reporting integration"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
          />
          {state.fieldErrors.name ? (
            <p className="mt-1 text-xs text-red-600">{state.fieldErrors.name}</p>
          ) : null}
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Scopes</legend>
          <div className="mt-2 space-y-2">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={(SCOPES as readonly string[]).length === 1}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium">{SCOPE_LABELS[scope]}</span>{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-600">
                    {scope}
                  </code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="api-key-expiry" className="block text-sm font-medium text-slate-700">
            Expires
          </label>
          <select
            id="api-key-expiry"
            name="expires_in_days"
            defaultValue="never"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none sm:w-60"
          >
            <option value="never">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In 1 year</option>
          </select>
        </div>

        <SubmitButton label="Create API key" pendingLabel="Creating…" />
      </form>

      {state.ok && typeof state.values.plaintext === "string" ? (
        <OneTimeKeyReveal plaintext={state.values.plaintext} />
      ) : null}
    </div>
  );
}

export function RevokeApiKeyButton({
  keyId,
  keyName,
}: {
  keyId: string;
  keyName: string;
}) {
  const [state, action] = useActionState<FormState<ApiKeyFormValues>, FormData>(
    revokeApiKey,
    INITIAL_FORM_STATE as FormState<ApiKeyFormValues>,
  );

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `Revoke "${keyName}"? Anything still using this key stops working immediately. Revocation cannot be undone.`,
          )
        ) {
          e.preventDefault();
        }
      }}
      className="inline"
    >
      <input type="hidden" name="key_id" value={keyId} />
      <button
        type="submit"
        className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50"
      >
        Revoke
      </button>
      {state.error ? (
        <p className="mt-1 text-xs text-red-600">{state.error}</p>
      ) : null}
    </form>
  );
}
