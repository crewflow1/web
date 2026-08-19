"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from "@/lib/retention/policy";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export type RetentionTableView = {
  table: string;
  label: string;
  description: string;
  timestampColumn: string;
};

export type RetentionPolicyView = {
  retentionDays: number;
  enabled: boolean;
};

const inputClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

/**
 * One editable retention policy for one table. The form's default submit SAVES;
 * the "Preview" button submits the SAME fields to the dry-run action instead
 * (React 19 per-button formAction). Disabled wholesale for non-admins — the DB
 * and the action enforce admin-write regardless.
 */
export function RetentionTableRow({
  meta,
  policy,
  isAdmin,
  saveAction,
  previewAction,
}: {
  meta: RetentionTableView;
  policy: RetentionPolicyView | null;
  isAdmin: boolean;
  saveAction: Action;
  previewAction: Action;
}) {
  const [saveState, saveFormAction, saving] = useActionState(
    saveAction,
    INITIAL_FORM_STATE,
  );
  const [previewState, previewFormAction, previewing] = useActionState(
    previewAction,
    INITIAL_FORM_STATE,
  );
  const router = useRouter();
  useEffect(() => {
    if (saveState.ok) router.refresh();
  }, [saveState.ok, saveState.submittedAt, router]);

  const fe = { ...saveState.fieldErrors, ...previewState.fieldErrors };
  const defaultDays = policy?.retentionDays ?? 365;
  const defaultEnabled = policy?.enabled ?? false;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">{meta.label}</h3>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
              {meta.table}
            </code>
          </div>
          <p className="mt-1 text-xs text-slate-500">{meta.description}</p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            defaultEnabled
              ? "bg-emerald-100 text-emerald-800"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {defaultEnabled ? "Enabled" : "Off"}
        </span>
      </div>

      <form action={saveFormAction} noValidate className="mt-3 space-y-3">
        <input type="hidden" name="target_table" value={meta.table} />
        <FormErrorBanner error={saveState.error ?? previewState.error} />
        <FormSuccessBanner
          message={
            saveState.ok
              ? saveState.successMessage
              : previewState.ok
                ? previewState.successMessage
                : null
          }
        />

        <fieldset disabled={!isAdmin} className="space-y-3 disabled:opacity-60">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-40">
              <label
                htmlFor={`retention_days_${meta.table}`}
                className="block text-sm font-medium text-slate-800"
              >
                Keep for (days)
              </label>
              <input
                id={`retention_days_${meta.table}`}
                name="retention_days"
                type="number"
                min={MIN_RETENTION_DAYS}
                max={MAX_RETENTION_DAYS}
                inputMode="numeric"
                defaultValue={String(defaultDays)}
                aria-invalid={fe.retention_days ? true : undefined}
                className={inputClass}
              />
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-slate-800">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={defaultEnabled}
                className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
              />
              Enable automatic purge
            </label>
          </div>
          {fe.retention_days ? (
            <p role="alert" className="text-xs text-red-700">
              {fe.retention_days}
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Rows whose <code>{meta.timestampColumn}</code> is older than this
              window are purged. Between {MIN_RETENTION_DAYS} and{" "}
              {MAX_RETENTION_DAYS} days.
            </p>
          )}
        </fieldset>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pending={saving}>Save</SubmitButton>
            <button
              type="submit"
              formAction={previewFormAction}
              disabled={previewing || saving}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {previewing ? "Previewing…" : "Preview (dry run)"}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
