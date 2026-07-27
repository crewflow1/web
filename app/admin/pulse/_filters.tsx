"use client";

import { Search, X, SlidersHorizontal } from "lucide-react";
import {
  CATEGORIES,
  CATEGORY_NAMESPACES,
  type Category,
} from "@/lib/events/categories";
import { SEVERITIES, ACTOR_TYPES, type Severity, type ActorType } from "@/lib/events/registry";
import { severityToken } from "@/lib/events/render";
import type { TimelineFacets } from "@/server/services/spine-timeline";
import { CountUp } from "./_primitives";

/**
 * The Pulse — filter bar (Module 1, PR5 / CEO Directive #005, STEP 5).
 *
 * Presentational only: the feed owns the selection state + the URL sync, this
 * paints search + the category chips (with live facet counts) + the secondary
 * severity / actor pills, and calls back. Category chips are the directive's
 * exact list (All, Sales … System). Counts animate when the facets refresh.
 */

const ACTOR_LABEL: Record<ActorType, string> = {
  human: "Human",
  ai_employee: "AI",
  system: "System",
  tenant: "Customer",
};

function categoryCount(facets: TimelineFacets | null, category: Category): number {
  if (!facets) return 0;
  let n = 0;
  for (const ns of CATEGORY_NAMESPACES[category]) n += facets.namespaces[ns] ?? 0;
  return n;
}

export function PulseFilters({
  facets,
  search,
  selectedCategories,
  selectedSeverities,
  selectedActors,
  allCategoriesActive,
  filtersDirty,
  onSearch,
  onToggleCategory,
  onSelectAllCategories,
  onToggleSeverity,
  onToggleActor,
  onReset,
}: {
  facets: TimelineFacets | null;
  search: string;
  selectedCategories: ReadonlySet<Category>;
  selectedSeverities: ReadonlySet<Severity>;
  selectedActors: ReadonlySet<ActorType>;
  allCategoriesActive: boolean;
  filtersDirty: boolean;
  onSearch: (value: string) => void;
  onToggleCategory: (category: Category) => void;
  onSelectAllCategories: () => void;
  onToggleSeverity: (severity: Severity) => void;
  onToggleActor: (actor: ActorType) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search the company's entire history…"
          aria-label="Search the timeline"
          className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-9 pr-9 text-[13px] text-slate-100 placeholder:text-slate-500 transition focus:border-indigo-400/50 focus:outline-none focus:ring-1 focus:ring-indigo-400/40"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearch("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-1.5">
        <Chip active={allCategoriesActive} onClick={onSelectAllCategories} label="All" />
        {CATEGORIES.map((c) => (
          <Chip
            key={c.id}
            active={selectedCategories.has(c.id)}
            onClick={() => onToggleCategory(c.id)}
            label={c.label}
            count={categoryCount(facets, c.id)}
          />
        ))}
      </div>

      {/* Secondary: severity + actor + reset */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
            <SlidersHorizontal className="h-3 w-3" /> Severity
          </span>
          {SEVERITIES.map((s) => {
            const tok = severityToken(s);
            const on = selectedSeverities.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => onToggleSeverity(s)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                  on ? tok.badge : "text-slate-500 ring-1 ring-inset ring-slate-800 hover:text-slate-300"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${tok.dot}`} />
                {tok.label}
                {facets ? (
                  <span className="text-slate-500">{facets.severities[s] ?? 0}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
            Actor
          </span>
          {ACTOR_TYPES.map((a) => {
            const on = selectedActors.has(a);
            return (
              <button
                key={a}
                type="button"
                onClick={() => onToggleActor(a)}
                aria-pressed={on}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                  on
                    ? "bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/40"
                    : "text-slate-500 ring-1 ring-inset ring-slate-800 hover:text-slate-300"
                }`}
              >
                {ACTOR_LABEL[a]}
              </button>
            );
          })}
        </div>

        {filtersDirty ? (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto text-[11px] font-medium text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
          >
            Reset filters
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${
        active
          ? "border-indigo-400/40 bg-indigo-500/15 text-indigo-100"
          : "border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-700 hover:text-slate-200"
      }`}
    >
      {label}
      {typeof count === "number" ? (
        <span
          className={`rounded-full px-1 text-[10px] tabular-nums ${
            active ? "bg-indigo-400/20 text-indigo-200" : "bg-slate-800 text-slate-500"
          }`}
        >
          <CountUp value={count} duration={0.4} />
        </span>
      ) : null}
    </button>
  );
}
