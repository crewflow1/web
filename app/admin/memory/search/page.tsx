import Link from "next/link";
import { Search as SearchIcon, SlidersHorizontal } from "lucide-react";
import {
  listMemorySources,
  listMemoryTypes,
  searchMemories,
  type MemorySort,
} from "@/server/services/hq-memory";
import {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  IMPORTANCES,
  IMPORTANCE_LABELS,
  MEMORY_STATUSES,
  MEMORY_VISIBILITIES,
  STATUS_LABELS,
  VISIBILITY_LABELS,
} from "@/lib/memory/model";
import { EmptyState, MemoryCard, buildTypeMap } from "../_components";
import { inputCls, selectCls } from "../_styles";

/**
 * Shared Memory Engine — search (CEO Directive 002, Phase 2).
 *
 * Full-text keyword search (Postgres tsvector + GIN) plus every
 * structured filter — type, department, importance, status, source,
 * visibility, tag, pinned — and sort. URL params drive everything so
 * refresh + shared links keep state. Pagination is server-side.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{
  q?: string;
  type?: string;
  dept?: string;
  importance?: string;
  status?: string;
  source?: string;
  visibility?: string;
  tag?: string;
  sort?: string;
  pinned?: string;
  page?: string;
}>;

const SORTS: { value: MemorySort; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "accessed", label: "Recently accessed" },
];

export default async function MemorySearchPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const [types, sources] = await Promise.all([
    listMemoryTypes(true),
    listMemorySources(true),
  ]);
  const typeMap = buildTypeMap(types);

  const sort = (SORTS.find((s) => s.value === sp.sort)?.value ??
    "recent") as MemorySort;
  const pinnedOnly = sp.pinned === "1";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const result = await searchMemories({
    q: sp.q,
    type: sp.type,
    department: sp.dept,
    importance: sp.importance,
    status: sp.status,
    source: sp.source,
    visibility: sp.visibility,
    tag: sp.tag,
    pinnedOnly,
    sort,
    page,
    pageSize: 24,
  });

  const hasFilters = Boolean(
    sp.q ||
      sp.type ||
      sp.dept ||
      sp.importance ||
      sp.status ||
      sp.source ||
      sp.visibility ||
      sp.tag ||
      pinnedOnly,
  );

  const buildPageHref = (target: number) => {
    const qs = new URLSearchParams();
    if (sp.q) qs.set("q", sp.q);
    if (sp.type) qs.set("type", sp.type);
    if (sp.dept) qs.set("dept", sp.dept);
    if (sp.importance) qs.set("importance", sp.importance);
    if (sp.status) qs.set("status", sp.status);
    if (sp.source) qs.set("source", sp.source);
    if (sp.visibility) qs.set("visibility", sp.visibility);
    if (sp.tag) qs.set("tag", sp.tag);
    if (pinnedOnly) qs.set("pinned", "1");
    if (sort !== "recent") qs.set("sort", sort);
    if (target > 1) qs.set("page", String(target));
    const s = qs.toString();
    return s ? `/admin/memory/search?${s}` : "/admin/memory/search";
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/memory" className="transition-colors hover:text-slate-300">
            Shared Memory
          </Link>{" "}
          / <span className="text-slate-300">Search</span>
        </p>

        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <SearchIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Search memory
            </h1>
            <p className="text-xs text-slate-400">
              Keyword + filters across the whole knowledge engine.
            </p>
          </div>
        </div>

        {/* Filter form */}
        <form
          method="GET"
          action="/admin/memory/search"
          className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"
        >
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Search titles, summaries, and bodies…"
              className="block w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <label className="text-[11px] font-medium text-slate-400">
              Type
              <select name="type" defaultValue={sp.type ?? ""} className={selectCls}>
                <option value="">All types</option>
                {types.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Department
              <select name="dept" defaultValue={sp.dept ?? ""} className={selectCls}>
                <option value="">All departments</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {DEPARTMENT_LABELS[d]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Importance
              <select
                name="importance"
                defaultValue={sp.importance ?? ""}
                className={selectCls}
              >
                <option value="">Any importance</option>
                {IMPORTANCES.map((i) => (
                  <option key={i} value={i}>
                    {IMPORTANCE_LABELS[i]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Status
              <select
                name="status"
                defaultValue={sp.status ?? ""}
                className={selectCls}
              >
                <option value="">Any status</option>
                {MEMORY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Source
              <select
                name="source"
                defaultValue={sp.source ?? ""}
                className={selectCls}
              >
                <option value="">Any source</option>
                {sources.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Visibility
              <select
                name="visibility"
                defaultValue={sp.visibility ?? ""}
                className={selectCls}
              >
                <option value="">Any visibility</option>
                {MEMORY_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Tag
              <input
                type="text"
                name="tag"
                defaultValue={sp.tag ?? ""}
                placeholder="exact tag"
                className={inputCls}
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Sort
              <select name="sort" defaultValue={sort} className={selectCls}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                name="pinned"
                value="1"
                defaultChecked={pinnedOnly}
                className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-indigo-500 focus:ring-indigo-500"
              />
              Pinned only
            </label>
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              Apply
            </button>
            {hasFilters ? (
              <Link
                href="/admin/memory/search"
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                Reset
              </Link>
            ) : null}
            <p className="ml-auto text-[11px] text-slate-500">
              {result.total.toLocaleString()}{" "}
              {result.total === 1 ? "memory" : "memories"}
            </p>
          </div>
        </form>

        {/* Results */}
        {result.memories.length === 0 ? (
          <EmptyState
            message="No memories match these filters."
            cta={
              hasFilters ? (
                <Link
                  href="/admin/memory/search"
                  className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Clear filters
                </Link>
              ) : (
                <Link
                  href="/admin/memory/new"
                  className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Create the first memory →
                </Link>
              )
            }
          />
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {result.memories.map((m) => (
                <li key={m.id}>
                  <MemoryCard memory={m} typeMap={typeMap} />
                </li>
              ))}
            </ul>

            {result.pageCount > 1 ? (
              <div className="flex items-center justify-between border-t border-slate-800 pt-4">
                <PageLink
                  href={buildPageHref(page - 1)}
                  disabled={page <= 1}
                  label="← Previous"
                />
                <span className="text-xs text-slate-500">
                  Page {page} of {result.pageCount}
                </span>
                <PageLink
                  href={buildPageHref(page + 1)}
                  disabled={page >= result.pageCount}
                  label="Next →"
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PageLink({
  href,
  disabled,
  label,
}: {
  href: string;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="cursor-not-allowed rounded-md border border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-600">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
    >
      {label}
    </Link>
  );
}
