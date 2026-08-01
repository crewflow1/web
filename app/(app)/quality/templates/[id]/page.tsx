import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions } from "../../_data";
import { getTemplate } from "../_data";
import {
  addTemplateItem,
  archiveTemplate,
  createTemplateVersion,
  deleteTemplateItem,
  instantiateTemplate,
  publishTemplate,
} from "../actions";
import { CONTROL_POINTS, CONTROL_POINT_META, type ControlPoint } from "@/lib/quality/itp";
import {
  TEMPLATE_STATUS_META,
  canInstantiate,
  canPublish,
  isTemplateEditable,
  type TemplateStatus,
} from "@/lib/quality/templates";

/**
 * /quality/templates/[id] — one template version.
 *
 * Draft: add/remove items, publish. Published: instantiate into a draft plan,
 * start the next version, archive. Items render as cards (the M1 375px
 * ergonomics decision — acceptance criteria are prose, and a table would push
 * them off a phone). ACTIVE-org pinned via getTemplate.
 */

const ERROR_MAP: Record<string, string> = {
  bad_id: "That template reference was invalid.",
  not_found: "That record no longer exists.",
  no_items: "A template needs at least one inspection item before it can be published.",
  not_published: "Only a published template version can be used to create a plan.",
  duplicate_item_number: "That item number is already used in this template.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Template draft created. Add the checks, then publish it.",
  version_created: "New draft version created from the previous one.",
  published: "Template published. It is now the current version for this name.",
  archived: "Template archived.",
  item_added: "Template item added.",
  item_removed: "Template item removed.",
};

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

type SP = Promise<{ saved?: string; error?: string }>;

export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const loaded = await getTemplate(ctx.org.id, id);
  if (!loaded) notFound();
  const { template, items } = loaded;

  const status = template.status as TemplateStatus;
  const editable = isTemplateEditable(status);
  const gate = canPublish({ status, itemCount: items.length });
  const jobs = canInstantiate(status) ? await listJobOptions(ctx.org.id) : [];

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const nextItemNumber = items.reduce((n, i) => Math.max(n, i.item_number), 0) + 1;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <Link href="/quality/templates" className="hover:text-slate-900">
          Templates
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">
          {template.name} v{template.version}
        </span>
      </nav>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-slate-600">v{template.version}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${TEMPLATE_STATUS_META[status].tone}`}
          >
            {TEMPLATE_STATUS_META[status].label}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">{template.name}</h1>
        {template.description ? (
          <p className="text-sm text-slate-600">{template.description}</p>
        ) : null}
      </header>

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {/* ── The checks ────────────────────────────────────────────────────── */}
      <section aria-labelledby="template-items-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="template-items-heading" className="text-base font-semibold text-slate-900">
            Inspection items
          </h2>
          <span className="text-xs text-slate-500">
            {items.length} check{items.length === 1 ? "" : "s"} in order
          </span>
        </div>

        {items.length === 0 ? (
          <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            No checks yet. Add each check in the order it happens on site.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {items.map((item) => {
              const cp = CONTROL_POINT_META[item.control_point as ControlPoint];
              return (
                <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-slate-900 px-1.5 text-xs font-semibold text-white">
                      {item.item_number}
                    </span>
                    <h3 className="min-w-0 flex-1 text-base font-semibold text-slate-900">
                      {item.title}
                    </h3>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cp.tone}`}>
                      {cp.label}
                    </span>
                    {item.is_hold_point ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
                        Hold point
                      </span>
                    ) : null}
                    {!item.required ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        Optional
                      </span>
                    ) : null}
                  </div>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        Acceptance criteria
                      </dt>
                      <dd className="mt-0.5 whitespace-pre-wrap text-slate-700">
                        {item.acceptance_criteria}
                      </dd>
                    </div>
                    {item.inspection_method ? (
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          Method
                        </dt>
                        <dd className="mt-0.5 text-slate-700">{item.inspection_method}</dd>
                      </div>
                    ) : null}
                    {item.specification_ref ? (
                      <div>
                        <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          Specification
                        </dt>
                        <dd className="mt-0.5 text-slate-700">{item.specification_ref}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {editable ? (
                    <form action={deleteTemplateItem} className="mt-3">
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="templateId" value={template.id} />
                      <button
                        type="submit"
                        className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 sm:w-auto"
                      >
                        Remove item<span className="sr-only">: {item.title}</span>
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Add a check (drafts only — the DB freezes published versions) ──── */}
      {editable ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Add an inspection item</h2>
          <form action={addTemplateItem} className="mt-4 space-y-4">
            <input type="hidden" name="templateId" value={template.id} />
            <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
              <div>
                <label htmlFor="itemNumber" className={labelClass}>
                  Item no.<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="itemNumber"
                  name="itemNumber"
                  type="number"
                  min={1}
                  max={9999}
                  required
                  defaultValue={nextItemNumber}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="itemTitle" className={labelClass}>
                  What is checked<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="itemTitle"
                  name="title"
                  type="text"
                  required
                  maxLength={300}
                  placeholder="Bedding laid and compacted"
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label htmlFor="acceptanceCriteria" className={labelClass}>
                Acceptance criteria<span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                id="acceptanceCriteria"
                name="acceptanceCriteria"
                required
                rows={3}
                maxLength={4000}
                placeholder="10mm pea gravel, 100mm min depth, to spec clause…"
                className={inputClass}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="inspectionMethod" className={labelClass}>
                  Method
                </label>
                <input
                  id="inspectionMethod"
                  name="inspectionMethod"
                  type="text"
                  maxLength={300}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="itemSpecRef" className={labelClass}>
                  Specification clause
                </label>
                <input
                  id="itemSpecRef"
                  name="specificationRef"
                  type="text"
                  maxLength={200}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label htmlFor="controlPoint" className={labelClass}>
                Control point<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select id="controlPoint" name="controlPoint" defaultValue="inspect" className={inputClass}>
                {CONTROL_POINTS.map((c) => (
                  <option key={c} value={c}>
                    {CONTROL_POINT_META[c].label} — {CONTROL_POINT_META[c].help}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-slate-300 bg-white px-3 text-sm">
              <input id="isHoldPoint" name="isHoldPoint" type="checkbox" className="h-5 w-5" />
              <span className="font-medium text-slate-800">
                Hold point — work must not proceed past this check until it is
                signed off
              </span>
            </label>
            {/* The hidden-"off" idiom: an unchecked checkbox sends nothing, so
                the form always sends "off" and adds "on" only when ticked. */}
            <input type="hidden" name="required" value="off" />
            <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-slate-300 bg-white px-3 text-sm">
              <input
                id="required"
                name="required"
                type="checkbox"
                defaultChecked
                value="on"
                className="h-5 w-5"
              />
              <span className="font-medium text-slate-800">Required check</span>
            </label>
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
            >
              Add item
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Use it: instantiate a plan from the published version ──────────── */}
      {canInstantiate(status) ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Create a plan from this template</h2>
          <p className="mt-1 text-sm text-slate-600">
            Copies every check — hold points included — into a new DRAFT plan
            for the job you pick. You can adjust the draft before issuing it.
          </p>
          <form action={instantiateTemplate} className="mt-3 space-y-4">
            <input type="hidden" name="templateId" value={template.id} />
            <div>
              <label htmlFor="inst-jobId" className={labelClass}>
                Job<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select id="inst-jobId" name="jobId" required defaultValue="" className={inputClass}>
                <option value="">Select a job…</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="inst-workPackage" className={labelClass}>
                  Work package<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="inst-workPackage"
                  name="workPackage"
                  type="text"
                  required
                  maxLength={200}
                  placeholder="Below-ground drainage, Plots 1–4"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="inst-title" className={labelClass}>
                  Plan title
                </label>
                <input
                  id="inst-title"
                  name="title"
                  type="text"
                  maxLength={200}
                  placeholder={template.name}
                  className={inputClass}
                />
              </div>
            </div>
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
            >
              Create draft plan
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Document control ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Version control</h2>
        {status === "draft" ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              Publishing freezes this version and archives any currently
              published version of &ldquo;{template.name}&rdquo; in the same step.
            </p>
            {!gate.ok ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {gate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={publishTemplate}>
                <input type="hidden" name="id" value={template.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Publish template
                </button>
              </form>
              <form action={archiveTemplate}>
                <input type="hidden" name="id" value={template.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Archive draft
                </button>
              </form>
            </div>
          </>
        ) : status === "published" ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              This version is frozen. To change the checks, start the next
              version — publishing it archives this one automatically.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={createTemplateVersion}>
                <input type="hidden" name="id" value={template.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Start version {template.version + 1}
                </button>
              </form>
              <form action={archiveTemplate}>
                <input type="hidden" name="id" value={template.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Archive template
                </button>
              </form>
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-slate-600">
            This version is archived and kept unchanged as a record. Plans
            created from it are unaffected.
          </p>
        )}
      </section>
    </div>
  );
}
