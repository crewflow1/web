import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import { listTemplates, type TemplateListItem } from "./_data";
import { createTemplate } from "./actions";
import { TEMPLATE_STATUS_META, type TemplateStatus } from "@/lib/quality/templates";

/**
 * /quality/templates — the ITP template library (M2).
 *
 * Versioned, relational checklists. One PUBLISHED version per name (a DB
 * fact); a published version instantiates into a real draft plan with real
 * items. Reads are ACTIVE-org pinned and loud on failure.
 */

const ERROR_MAP: Record<string, string> = {
  bad_id: "That template reference was invalid.",
  not_found: "That template no longer exists.",
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

export default async function TemplateLibraryPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const rows = await listTemplates(ctx.org.id);

  // Group versions under their family name, newest version first (the list
  // arrives name-asc, version-desc).
  const families = new Map<string, TemplateListItem[]>();
  for (const r of rows) {
    const arr = families.get(r.name) ?? [];
    arr.push(r);
    families.set(r.name, arr);
  }

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">Templates</span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Inspection plan templates</h1>
        <p className="mt-1 text-sm text-slate-600">
          The checks you run on every drainage run, every slab, every steel
          frame — written once, versioned, and turned into a draft plan in one
          step. Published versions are frozen; changing one means publishing
          the next version.
        </p>
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

      {/* ── The library ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState
            icon="📐"
            title="No templates yet"
            body="Create one for the work you inspect repeatedly. Add the checks in order, flag the hold points, publish it — and every new plan starts from it."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {[...families.entries()].map(([name, versions]) => (
              <li key={name} className="px-4 py-4 sm:px-5">
                <p className="text-sm font-semibold text-slate-900">{name}</p>
                <ul className="mt-2 space-y-1.5">
                  {versions.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/quality/templates/${t.id}`}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-slate-200 px-3 py-2.5 text-sm transition hover:bg-slate-50"
                      >
                        <span className="font-mono text-xs font-medium text-slate-600">
                          v{t.version}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${TEMPLATE_STATUS_META[t.status as TemplateStatus].tone}`}
                        >
                          {TEMPLATE_STATUS_META[t.status as TemplateStatus].label}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-slate-600">
                          {t.itemCount} check{t.itemCount === 1 ? "" : "s"}
                          {t.description ? ` · ${t.description}` : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Create a template ────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Create a template</h2>
        <p className="mt-1 text-xs text-slate-500">
          Using an existing name starts that template&rsquo;s next version instead.
        </p>
        <form action={createTemplate} className="mt-3 space-y-4">
          <div>
            <label htmlFor="template-name" className={labelClass}>
              Name<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="template-name"
              name="name"
              type="text"
              required
              maxLength={200}
              placeholder="Below-ground drainage ITP"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="template-description" className={labelClass}>
              Description
            </label>
            <textarea
              id="template-description"
              name="description"
              rows={2}
              maxLength={2000}
              placeholder="Standard checks for foul and surface water runs."
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 sm:w-auto"
          >
            Create draft template
          </button>
        </form>
      </section>
    </div>
  );
}
