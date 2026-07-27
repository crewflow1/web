import {
  ALL_CATEGORIES,
  DEFAULT_CATEGORIES,
  type Category,
} from "@/lib/events/categories";
import {
  SEVERITIES,
  ACTOR_TYPES,
  type Severity,
  type ActorType,
} from "@/lib/events/registry";

/**
 * The Pulse — URL ↔ filter-state codec (Module 1, PR5 / CEO Directive #005).
 *
 * ONE place both the server page (SSR initial fetch) and the client feed (live
 * refetch + history.replaceState) read/write the filter state, so a deep-linked
 * `?cat=&sev=&act=&q=` view always reconstructs identically on both sides.
 *
 * Semantics:
 *  - categories carry a non-empty DEFAULT (everything except System, per #005),
 *    so the param is omitted when it equals that default, "all" for the full set,
 *    "none" for the empty set, else a csv. Decode is the exact inverse.
 *  - severities / actors are "refine" filters: empty = no constraint (all). Param
 *    is omitted when empty, else a csv.
 */

export type PulseFilters = {
  categories: Set<Category>;
  severities: Set<Severity>;
  actors: Set<ActorType>;
  search: string;
};

export const DEFAULT_CATEGORY_SET: ReadonlySet<Category> = new Set(DEFAULT_CATEGORIES);

function csv<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const set = new Set<string>(allowed);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => set.has(s)) as T[];
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// --- categories --------------------------------------------------------------

/** Encode the category selection → param value, or null to omit (= default). */
export function encodeCategories(categories: ReadonlySet<Category>): string | null {
  if (setsEqual(categories, DEFAULT_CATEGORY_SET)) return null;
  if (categories.size === 0) return "none";
  if (categories.size >= ALL_CATEGORIES.length) return "all";
  return ALL_CATEGORIES.filter((c) => categories.has(c)).join(",");
}

export function decodeCategories(raw: string | undefined): Set<Category> {
  if (raw == null || raw === "") return new Set(DEFAULT_CATEGORIES);
  if (raw === "all") return new Set(ALL_CATEGORIES);
  if (raw === "none") return new Set();
  const parsed = csv<Category>(raw, ALL_CATEGORIES);
  return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_CATEGORIES);
}

/**
 * The category constraint to hand the reader:
 *  - "none"     → user deselected everything (render an empty state, don't query)
 *  - undefined  → all categories (NO namespace constraint — important: passing the
 *                 full category list would still drop unmapped-namespace events)
 *  - Category[] → a real subset
 */
export function categoryConstraint(
  categories: ReadonlySet<Category>,
): Category[] | "none" | undefined {
  if (categories.size === 0) return "none";
  if (categories.size >= ALL_CATEGORIES.length) return undefined;
  return ALL_CATEGORIES.filter((c) => categories.has(c));
}

// --- whole filter set --------------------------------------------------------

/** Decode every filter from a param getter (works for both server + client). */
export function decodeFilters(get: (key: string) => string | undefined): PulseFilters {
  return {
    categories: decodeCategories(get("cat")),
    severities: new Set(csv<Severity>(get("sev"), SEVERITIES)),
    actors: new Set(csv<ActorType>(get("act"), ACTOR_TYPES)),
    search: (get("q") ?? "").trim(),
  };
}

/** True when filters differ from the default view (drives the "Reset" affordance). */
export function filtersAreDirty(f: PulseFilters): boolean {
  return (
    !setsEqual(f.categories, DEFAULT_CATEGORY_SET) ||
    f.severities.size > 0 ||
    f.actors.size > 0 ||
    f.search.trim().length > 0
  );
}
