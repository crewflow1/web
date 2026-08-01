"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { EXPOSABLE_WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from "@/lib/webhooks/events";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  pauseWebhookEndpoint,
  repingWebhookEndpoint,
  resumeWebhookEndpoint,
  type WebhookFormValues,
} from "./actions";

/**
 * /settings/webhooks client forms.
 *
 * THE ONE-TIME SECRET REVEAL: the create action returns the signing secret exactly
 * once, in the FormState of the response that created it. It lives only in this
 * component's ephemeral state — never written to storage, a cookie, a log, or a
 * URL, and a refresh loses it forever (that is the design).
 */

function SubmitButton({ label, pendingLabel, danger }: { label: string; pendingLabel: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        danger
          ? "inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
          : "inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
      }
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function OneTimeSecretReveal({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">
        Copy your signing secret now — you won&apos;t see it again.
      </p>
      <p className="mt-1 text-xs text-amber-800">
        Use it to verify the <code className="font-mono">X-CrewFlow-Signature</code> header on every
        delivery. We store it encrypted at rest and never show it again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="max-w-full overflow-x-auto rounded-md border border-amber-200 bg-white px-3 py-2 font-mono text-xs text-slate-900">
          {secret}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              /* clipboard unavailable — secret is still on screen */
            }
          }}
          className="inline-flex items-center rounded-md border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-900 transition hover:bg-amber-100"
        >
          {copied ? "Copied" : "Copy secret"}
        </button>
      </div>
    </div>
  );
}

export function CreateWebhookForm() {
  const [state, action] = useActionState<FormState<WebhookFormValues>, FormData>(
    createWebhookEndpoint,
    INITIAL_FORM_STATE as FormState<WebhookFormValues>,
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
          <label htmlFor="wh-url" className="block text-sm font-medium text-slate-700">
            Endpoint URL
          </label>
          <input
            id="wh-url"
            name="url"
            type="url"
            required
            placeholder="https://example.com/hooks/crewflow"
            defaultValue={typeof state.values.url === "string" ? state.values.url : ""}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-slate-500">Must be HTTPS and publicly reachable.</p>
        </div>

        <div>
          <label htmlFor="wh-desc" className="block text-sm font-medium text-slate-700">
            Description <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="wh-desc"
            name="description"
            type="text"
            maxLength={200}
            defaultValue={typeof state.values.description === "string" ? state.values.description : ""}
            placeholder="e.g. Ops Slack relay"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Events to send</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EXPOSABLE_WEBHOOK_EVENTS.map((verb) => (
              <label key={verb} className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" name="events" value={verb} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                <span>
                  <span className="font-medium">{WEBHOOK_EVENT_LABELS[verb]}</span>{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-600">{verb}</code>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
        >
          Create webhook
        </button>
      </form>

      {state.ok && typeof state.values.secret === "string" ? (
        <>
          <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {state.successMessage}
          </p>
          <OneTimeSecretReveal secret={state.values.secret} />
        </>
      ) : null}
    </div>
  );
}

function EndpointActionForm({
  endpointId,
  action,
  label,
  pendingLabel,
  confirm,
  danger,
}: {
  endpointId: string;
  action: (prev: FormState<WebhookFormValues>, fd: FormData) => Promise<FormState<WebhookFormValues>>;
  label: string;
  pendingLabel: string;
  confirm?: string;
  danger?: boolean;
}) {
  const [state, formAction] = useActionState<FormState<WebhookFormValues>, FormData>(
    action,
    INITIAL_FORM_STATE as FormState<WebhookFormValues>,
  );
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="inline"
    >
      <input type="hidden" name="endpoint_id" value={endpointId} />
      <SubmitButton label={label} pendingLabel={pendingLabel} danger={danger} />
      {state.error ? <span className="ml-2 text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}

export function EndpointActions({ endpointId, status }: { endpointId: string; status: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "active" ? (
        <EndpointActionForm endpointId={endpointId} action={pauseWebhookEndpoint} label="Pause" pendingLabel="Pausing…" />
      ) : (
        <EndpointActionForm endpointId={endpointId} action={resumeWebhookEndpoint} label="Resume" pendingLabel="Resuming…" />
      )}
      <EndpointActionForm endpointId={endpointId} action={repingWebhookEndpoint} label="Send test ping" pendingLabel="Sending…" />
      <EndpointActionForm
        endpointId={endpointId}
        action={deleteWebhookEndpoint}
        label="Delete"
        pendingLabel="Deleting…"
        danger
        confirm="Delete this webhook and its delivery history? This cannot be undone."
      />
    </div>
  );
}
