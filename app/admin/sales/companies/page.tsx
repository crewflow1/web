import Link from "next/link";
import { Plus, Search as SearchIcon, SlidersHorizontal } from "lucide-react";
import {
  listSalesSources,
  searchCompanies,
  type CompanySearchParams,
  type CompanySort,
} from "@/server/services/hq-sales";
import {
  EMPLOYEE_BANDS,
  PIPELINE_STATUSES,
  STATUS_LABELS,
} from "@/lib/sales/model";
import { CompanyCard, EmptyState } from "../_components";
import { inputCls, selectCls } from "../_styles";

/**
 * Sales AI — Company Intelligence search (CEO Directive 003, Phase 1).
 *
 * The directive's "Search" deliverable: fast full-text keyword search
 * (Postgres tsvector + GIN) plus every structured facet — status,
 * industry, county, region, source, salesperson, tag, technology, size
 * band, minimum AI score — and sort. URL params drive everything so a
 * refresh or shared link restores the exact view. Pagination is
 * server-side and indexed.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{
  q?: string;
  status?: string;
  industry?: string;
  county?: string;
  region?: string;
  source?: string;
  assigned?: string;
  tag?: string;
  tech?: string;
  size?: string;
  score?: string;
  sort?: string;
  page?: string;
}>;

const SORTS: { value: CompanySort; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "score", label: "AI score (high→low)" },
  { value: "researched", label: "Recently researched" },
];

const SCORE_FLOORS = [
  { value: "40", label: "Cool 40+" },
  { value: "60", label: "Warm 60+" },
  { value: "80", label: "Hot 80+" },
];

export default async function CompaniesSearchPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const sources = await listSalesSources(true);

  const sort = (SORTS.find((s) => s.value === sp.sort)?.value ??
    "recent") as CompanySort;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const minScore = sp.score ? Number.parseInt(sp.score, 10) : undefined;

  const params: CompanySearchParams = {
    q: sp.q,
    status: sp.status,
    industry: sp.industry,
    county: sp.county,
    region: sp.region,
    source: sp.source,
    assignedTo: sp.assigned,
    tag: sp.tag,
    tech: sp.tech,
    sizeBand: sp.size,
    minScore: Number.isFinite(minScore) ? minScore : undefined,
    sort,
    page,
    pageSize: 24,
  };
  const result = await searchCompanies(params);

  const hasFilters = Boolean(
    sp.q ||
      sp.status ||
      sp.industry ||
      sp.county ||
      sp.region ||
      sp.source ||
      sp.assigned ||
      sp.tag ||
      sp.tech ||
      sp.size ||
      sp.score,
  );

  const buildPageHref = (target: number) => {
    const qs = new URLSearchParams();
    const set = (k: string, v?: string) => {
      if (v) qs.set(k, v);
    };
    set("q", sp.q);
    set("status", sp.status);
    set("industry", sp.industry);
    set("county", sp.county);
    set("region", sp.region);
    set("source", sp.source);
    set("assigned", sp.assigned);
    set("tag", sp.tag);
    set("tech", sp.tech);
    set("size", sp.size);
    set("score", sp.score);
    if (sort !== "recent") qs.set("sort", sort);
    if (target > 1) qs.set("page", String(target));
    const s = qs.toString();
    return s ? `/admin/sales/companies?${s}` : "/admin/sales/companies";
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb + header */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          / <span className="text-slate-300">Companies</span>
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <SearchIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">
                Company intelligence
              </h1>
              <p className="text-xs text-slate-400">
                Keyword + every facet across the master database.
              </p>
            </div>
          </div>
          <Link
            href="/admin/sales/companies/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New company
          </Link>
        </div>

        {/* Filter form */}
        <form
          method="GET"
          action="/admin/sales/companies"
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
              placeholder="Search company names, industry, geography, summary…"
              className="block w-full rounded-md border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <label className="text-[11px] font-medium text-slate-400">
              Status
              <select name="status" defaultValue={sp.status ?? ""} className={selectCls}>
                <option value="">Any status</option>
                {PIPELINE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Industry
              <input
                type="text"
                name="industry"
                defaultValue={sp.industry ?? ""}
                placeholder="exact match"
                className={inputCls}
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              County
              <input
                type="text"
                name="county"
                defaultValue={sp.county ?? ""}
                placeholder="exact match"
                className={inputCls}
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Region
              <input
                type="text"
                name="region"
                defaultValue={sp.region ?? ""}
                placeholder="exact match"
                className={inputCls}
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Source
              <select name="source" defaultValue={sp.source ?? ""} className={selectCls}>
                <option value="">Any source</option>
                {sources.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Size
              <select name="size" defaultValue={sp.size ?? ""} className={selectCls}>
                <option value="">Any size</option>
                {EMPLOYEE_BANDS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label} staff
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Min AI score
              <select name="score" defaultValue={sp.score ?? ""} className={selectCls}>
                <option value="">Any score</option>
                {SCORE_FLOORS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
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
              Technology
              <input
                type="text"
                name="tech"
                defaultValue={sp.tech ?? ""}
                placeholder="e.g. shopify"
                className={inputCls}
              />
            </label>
            <label className="text-[11px] font-medium text-slate-400">
              Salesperson
              <input
                type="text"
                name="assigned"
                defaultValue={sp.assigned ?? ""}
                placeholder="rep@crewflow.uk"
                className={inputCls}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
              Apply
            </button>
            {hasFilters ? (
              <Link
                href="/admin/sales/companies"
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                Reset
              </Link>
            ) : null}
            <p className="ml-auto text-[11px] text-slate-500">
              {result.total.toLocaleString()}{" "}
              {result.total === 1 ? "company" : "companies"}
            </p>
          </div>
        </form>

        {/* Results */}
        {result.companies.length === 0 ? (
          <EmptyState
            message="No companies match these filters."
            cta={
              hasFilters ? (
                <Link
                  href="/admin/sales/companies"
                  className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Clear filters
                </Link>
              ) : (
                <Link
                  href="/admin/sales/companies/new"
                  className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Add the first company →
                </Link>
              )
            }
          />
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {result.companies.map((c) => (
                <li key={c.id}>
                  <CompanyCard company={c} />
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
