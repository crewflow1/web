"use client";

import Link from "next/link";
import { StateForm } from "@/components/forms/StateForm";
import type { FormState } from "@/lib/forms/state";
import {
  TEMPLATE_MILESTONE_ROWS,
  TEMPLATE_CHECKLIST_ROWS,
} from "@/lib/jobs/templates";

/**
 * Job template editor (create + edit share this form).
 *
 * Milestones are OFFSET-dated (whole days from the job's start), because a
 * template is dateless — clone_job_template turns offsets into real dates
 * against the new job's scheduled_date. Rows with a blank title/label are
 * ignored by the action (an unused row, not an error).
 */

export type TemplateDefaults = {
  name: string;
  job_type: string;
  description: string;
  default_status: string;
  milestones: {
    title: string;
    offset_start_days: number | null;
    offset_end_days: number | null;
    weight: number | null;
    customer_visible: boolean;
  }[];
  checklist: { label: string; requires_photo: boolean }[];
};

const EMPTY: TemplateDefaults = {
  name: "",
  job_type: "",
  description: "",
  default_status: "",
  milestones: [],
  checklist: [],
};

export function TemplateForm({
  action,
  submitLabel,
  defaults = EMPTY,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  defaults?: TemplateDefaults;
}) {
  return (
    <StateForm
      action={action}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Template name <span className="text-red-500">*</span>
          </span>
          <input
            name="name"
            type="text"
            required
            maxLength={200}
            defaultValue={defaults.name}
            placeholder="e.g. Loft conversion"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Job type</span>
          <input
            name="job_type"
            type="text"
            maxLength={120}
            defaultValue={defaults.job_type}
            placeholder="e.g. Extension"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Default status for new jobs
          </span>
          <select
            name="default_status"
            defaultValue={defaults.default_status}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">— Job&apos;s own default —</option>
            <option value="new">New</option>
            <option value="in-progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Description</span>
        <textarea
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.description}
          placeholder="What this template is for"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      {/* Milestones */}
      <fieldset className="space-y-2 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-700">
          Milestones
        </legend>
        <p className="text-[11px] text-slate-500">
          Day offsets from the job&apos;s start (0 = start day). Rows with no
          title are ignored. Weights are optional — to earn a planned line they
          must all be set and sum to 100.
        </p>
        {Array.from({ length: TEMPLATE_MILESTONE_ROWS }, (_, idx) => {
          const i = idx + 1;
          const m = defaults.milestones[idx];
          return (
            <div
              key={i}
              className="grid gap-2 sm:grid-cols-[1fr_6rem_6rem_5rem_auto] sm:items-center"
            >
              <input
                name={`milestone_title_${i}`}
                type="text"
                maxLength={200}
                defaultValue={m?.title ?? ""}
                placeholder={`Milestone ${i} title`}
                aria-label={`Milestone ${i} title`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                name={`milestone_offset_start_${i}`}
                type="number"
                min={0}
                step={1}
                defaultValue={m?.offset_start_days ?? ""}
                placeholder="start d"
                aria-label={`Milestone ${i} start offset days (optional)`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
              <input
                name={`milestone_offset_end_${i}`}
                type="number"
                min={0}
                step={1}
                defaultValue={m?.offset_end_days ?? ""}
                placeholder="end d"
                aria-label={`Milestone ${i} end offset days`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
              <input
                name={`milestone_weight_${i}`}
                type="number"
                min={0.01}
                max={100}
                step={0.01}
                defaultValue={m?.weight ?? ""}
                placeholder="%"
                aria-label={`Milestone ${i} weight percent (optional)`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  name={`milestone_visible_${i}`}
                  type="checkbox"
                  defaultChecked={m?.customer_visible ?? false}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Customer
              </label>
            </div>
          );
        })}
      </fieldset>

      {/* Checklist */}
      <fieldset className="space-y-2 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-700">
          Checklist
        </legend>
        <p className="text-[11px] text-slate-500">
          Steps cloned onto every job started from this template. Rows with no
          label are ignored.
        </p>
        {Array.from({ length: TEMPLATE_CHECKLIST_ROWS }, (_, idx) => {
          const i = idx + 1;
          const c = defaults.checklist[idx];
          return (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
              <input
                name={`checklist_label_${i}`}
                type="text"
                maxLength={300}
                defaultValue={c?.label ?? ""}
                placeholder={`Checklist step ${i}`}
                aria-label={`Checklist step ${i}`}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  name={`checklist_photo_${i}`}
                  type="checkbox"
                  defaultChecked={c?.requires_photo ?? false}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Wants photo
              </label>
            </div>
          );
        })}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          {submitLabel}
        </button>
        <Link
          href="/jobs/templates"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </StateForm>
  );
}
