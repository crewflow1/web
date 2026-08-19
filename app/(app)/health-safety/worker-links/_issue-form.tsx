"use client";

import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";
import type { JobOption } from "./_data";

/**
 * Issue-link form. On success the server action returns the freshly-minted link
 * in `state.values.issuedUrl` and does NOT navigate — the link is a one-time
 * secret (only its hash is stored), so it is rendered inline with a copy button
 * and never placed in the URL or persisted client-side. "Create another" resets
 * the form; "Done" reloads the list so the new row appears.
 */
export function IssueWorkerLinkForm({
  action,
  jobs,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  jobs: JobOption[];
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const issuedUrl = typeof state.values?.issuedUrl === "string" ? state.values.issuedUrl : null;
  const [copied, setCopied] = useState(false);

  if (state.ok && issuedUrl) {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-sm font-medium text-emerald-900">{state.successMessage}</p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={issuedUrl}
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-800"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issuedUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                /* clipboard blocked — the field is selectable as a fallback */
              }
            }}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-emerald-800">
          Send this link to {String(state.values?.workerName ?? "the worker")}. It won&apos;t be shown
          again — if you lose it, revoke it and issue a new one.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <FormErrorBanner error={state.error} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Job</span>
          <select
            name="jobId"
            required
            defaultValue=""
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Select a job…
            </option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
          {state.fieldErrors?.jobId ? (
            <span className="mt-1 block text-xs text-red-600">{state.fieldErrors.jobId}</span>
          ) : null}
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Expires in (days)</span>
          <input
            type="number"
            name="expiresInDays"
            min={1}
            max={365}
            defaultValue={14}
            required
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {state.fieldErrors?.expiresInDays ? (
            <span className="mt-1 block text-xs text-red-600">{state.fieldErrors.expiresInDays}</span>
          ) : null}
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Worker name</span>
          <input
            type="text"
            name="workerName"
            required
            maxLength={160}
            placeholder="e.g. Alex Smith"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {state.fieldErrors?.workerName ? (
            <span className="mt-1 block text-xs text-red-600">{state.fieldErrors.workerName}</span>
          ) : null}
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Company (optional)</span>
          <input
            type="text"
            name="workerCompany"
            maxLength={160}
            placeholder="e.g. Smith Electrical Ltd"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={jobs.length === 0}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
      >
        Create link
      </button>
      {jobs.length === 0 ? (
        <p className="text-xs text-slate-500">Create a job first — a worker link is scoped to one job.</p>
      ) : null}
    </form>
  );
}
