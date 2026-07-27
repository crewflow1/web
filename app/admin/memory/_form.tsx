import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  IMPORTANCES,
  IMPORTANCE_LABELS,
  MEMORY_STATUSES,
  MEMORY_VISIBILITIES,
  STATUS_LABELS,
  VISIBILITY_HELP,
  VISIBILITY_LABELS,
  departmentLabel,
  type MemoryDetail,
  type MemorySource,
  type MemoryType,
} from "@/lib/memory/model";
import { Field, Section } from "./_components";
import { inputCls, selectCls } from "./_styles";

/**
 * Shared create/edit form for memory records (CEO Directive 002).
 * Server component — relies on native form submission to the passed
 * server action. Used by /admin/memory/new and /admin/memory/[id]/edit.
 *
 * Relationships are entered as one `type | label | id` line each;
 * employee links + department access grants are checkbox groups. The
 * action parses + replaces these wholesale on save.
 */

export function MemoryForm({
  action,
  types,
  sources,
  employees,
  initial,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  types: MemoryType[];
  sources: MemorySource[];
  employees: AiEmployee[];
  initial?: MemoryDetail | null;
  submitLabel: string;
}) {
  const m = initial?.memory;
  const relText = (initial?.relationships ?? [])
    .map(
      (r) =>
        `${r.entity_type} | ${r.entity_label}${r.entity_id ? ` | ${r.entity_id}` : ""}`,
    )
    .join("\n");
  const linkedIds = new Set(
    (initial?.employeeLinks ?? []).map((l) => l.ai_employee_id),
  );
  const grantDepts = new Set(
    (initial?.grants ?? [])
      .filter((g) => g.grantee_type === "department")
      .map((g) => g.grantee_value),
  );

  return (
    <form action={action} className="space-y-5">
      {m ? <input type="hidden" name="id" value={m.id} /> : null}

      <Section title="Content">
        <div className="space-y-4">
          <Field label="Title">
            <input
              name="title"
              type="text"
              required
              maxLength={300}
              defaultValue={m?.title ?? ""}
              placeholder="A clear, specific title"
              className={inputCls}
            />
          </Field>
          <Field label="Summary" hint="one or two sentences — shown in lists">
            <textarea
              name="summary"
              rows={2}
              maxLength={2000}
              defaultValue={m?.summary ?? ""}
              placeholder="The gist, for fast scanning."
              className={inputCls}
            />
          </Field>
          <Field label="Body" hint="the full knowledge — markdown-ish plain text">
            <textarea
              name="body"
              rows={10}
              maxLength={200_000}
              defaultValue={m?.body ?? ""}
              placeholder="Everything worth remembering."
              className={`${inputCls} font-mono text-xs leading-relaxed`}
            />
          </Field>
        </div>
      </Section>

      <Section title="Classification">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Memory type">
            <select
              name="memory_type"
              defaultValue={m?.memory_type ?? types[0]?.slug ?? "company"}
              className={selectCls}
            >
              {types.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Department" hint="optional">
            <select
              name="department"
              defaultValue={m?.department ?? ""}
              className={selectCls}
            >
              <option value="">All HQ (no department)</option>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {DEPARTMENT_LABELS[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Importance">
            <select
              name="importance"
              defaultValue={m?.importance ?? "normal"}
              className={selectCls}
            >
              {IMPORTANCES.map((i) => (
                <option key={i} value={i}>
                  {IMPORTANCE_LABELS[i]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <select
              name="source"
              defaultValue={m?.source ?? "manual"}
              className={selectCls}
            >
              {sources.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue={m?.status ?? "active"}
              className={selectCls}
            >
              {MEMORY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Confidence" hint="0–100">
            <input
              name="confidence"
              type="number"
              min={0}
              max={100}
              defaultValue={m?.confidence ?? 80}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tags" hint="comma separated">
            <input
              name="tags"
              type="text"
              defaultValue={(m?.tags ?? []).join(", ")}
              placeholder="e.g. positioning, brand, q3"
              className={inputCls}
            />
          </Field>
          <Field label="Organisation" hint="optional — link to a customer/org name">
            <input
              name="organisation_name"
              type="text"
              maxLength={200}
              defaultValue={m?.organisation_name ?? ""}
              className={inputCls}
            />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            name="pinned"
            defaultChecked={m?.pinned ?? false}
            className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
          />
          Pin this memory (surfaced first on the dashboard + employee feeds)
        </label>
      </Section>

      <Section
        title="Visibility & permissions"
        subtitle="Controls which AI employees may READ this memory. HQ operators always see everything."
      >
        <Field label="Visibility">
          <select
            name="visibility"
            defaultValue={m?.visibility ?? "public_hq"}
            className={`${selectCls} max-w-sm`}
          >
            {MEMORY_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
        <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
          {MEMORY_VISIBILITIES.map((v) => (
            <li key={v}>
              <span className="font-medium text-slate-400">
                {VISIBILITY_LABELS[v]}:
              </span>{" "}
              {VISIBILITY_HELP[v]}
            </li>
          ))}
        </ul>

        <div className="mt-4">
          <p className="text-[11px] font-medium text-slate-400">
            Grant access to departments
            <span className="ml-1 text-slate-600">
              applies to Department / Private / Restricted visibility
            </span>
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {DEPARTMENTS.map((d) => (
              <label
                key={d}
                className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300"
              >
                <input
                  type="checkbox"
                  name="grant_departments"
                  value={d}
                  defaultChecked={grantDepts.has(d)}
                  className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                />
                {DEPARTMENT_LABELS[d]}
              </label>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Relationships"
        subtitle="One per line: type | label | id (id optional). Types: feature, customer, organisation, github_pr, roadmap_item, decision, employee, bug, release, documentation, memory, other."
      >
        <textarea
          name="relationships"
          rows={4}
          defaultValue={relText}
          placeholder={"github_pr | PR #163 — AI Employee Framework | 163\nroadmap_item | CEO Directive 002 | directive-002"}
          className={`${inputCls} font-mono text-xs leading-relaxed`}
        />
      </Section>

      <Section
        title="Linked AI employees"
        subtitle="Linked employees see this memory in their Relevant feed automatically."
      >
        {employees.length === 0 ? (
          <p className="text-sm text-slate-500">No AI employees found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {employees.map((e) => (
              <label
                key={e.id}
                className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-300"
              >
                <input
                  type="checkbox"
                  name="employee_ids"
                  value={e.id}
                  defaultChecked={linkedIds.has(e.id)}
                  className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-200">
                    {e.name}
                  </span>
                  <span className="block truncate text-[10px] text-slate-500">
                    {departmentLabel(e.department)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          {submitLabel}
        </button>
        <span className="text-[11px] text-slate-500">
          Saved memories are versioned and audit-logged.
        </span>
      </div>
    </form>
  );
}
