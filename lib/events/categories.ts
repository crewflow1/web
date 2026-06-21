/**
 * Event categories — the SINGLE source for the Pulse filter chips (CEO Directive
 * #005, PR5). A "category" is the human grouping the timeline shows (Sales,
 * Finance, …); a "namespace" is the mechanical verb prefix the projection stores
 * (`quote`, `invoice`, …, from `verb`'s text before the first dot). This module
 * is the one place that maps between them, so adding a category — or re-homing a
 * namespace — is a single edit here and needs NO migration (the projection's
 * `namespace` column is generated mechanically; the meaning lives in TS).
 *
 * Like registry.ts this is pure data + types with no `server-only` and no I/O, so
 * both the server reader and the client filter UI import it. The ordering of
 * CATEGORIES is the chip order the CEO specified.
 */
import { type Verb, verbNamespace } from "./registry";

export const CATEGORIES = [
  { id: "sales", label: "Sales" },
  { id: "customers", label: "Customers" },
  { id: "projects", label: "Projects" },
  { id: "finance", label: "Finance" },
  { id: "payroll", label: "Payroll" },
  { id: "staff", label: "Staff" },
  { id: "ai", label: "AI" },
  { id: "documents", label: "Documents" },
  { id: "portal", label: "Portal" },
  { id: "communication", label: "Communication" },
  { id: "system", label: "System" },
] as const;

export type Category = (typeof CATEGORIES)[number]["id"];

/**
 * category → the verb-namespaces it groups. EVERY namespace produced today
 * (org, invoice, billing, customer, job, quote, support, ai, approval, memory,
 * permission, system, notification) is covered exactly once — a drift test in
 * the unit tier asserts no registered verb falls through. Forward namespaces with
 * no verbs yet (payroll, document, portal, lead, staff, member) are defined now
 * so the chip exists the moment those producers ship.
 */
export const CATEGORY_NAMESPACES: Record<Category, readonly string[]> = {
  sales: ["quote", "lead"],
  customers: ["customer", "org"],
  projects: ["job"],
  finance: ["invoice", "billing"],
  payroll: ["payroll"],
  staff: ["permission", "staff", "member"],
  ai: ["ai", "approval", "memory"],
  documents: ["document"],
  portal: ["portal"],
  communication: ["support", "notification"],
  system: ["system"],
};

// Reverse index, derived once so there is exactly one source of the mapping.
const NAMESPACE_TO_CATEGORY: ReadonlyMap<string, Category> = new Map(
  (Object.entries(CATEGORY_NAMESPACES) as [Category, readonly string[]][]).flatMap(
    ([cat, namespaces]) => namespaces.map((ns) => [ns, cat] as const),
  ),
);

/** Every namespace that is EXPLICITLY mapped to a category (drift-test anchor). */
export const MAPPED_NAMESPACES: ReadonlySet<string> = new Set(
  NAMESPACE_TO_CATEGORY.keys(),
);

/**
 * The category a namespace belongs to. An unmapped namespace falls back to
 * "system" so a brand-new producer can never orphan an event off every chip —
 * the drift test is what keeps that fallback from silently masking real drift.
 */
export function categoryForNamespace(namespace: string): Category {
  return NAMESPACE_TO_CATEGORY.get(namespace) ?? "system";
}

/** The category a verb belongs to (via its namespace). */
export function categoryForVerb(verb: Verb): Category {
  return categoryForNamespace(verbNamespace(verb));
}

/**
 * Flatten a chip selection into the namespace filter the reader applies (deduped).
 * An empty selection yields [] — the caller decides whether that means "no events"
 * or "no filter" (the Pulse treats an all/empty selection as no filter).
 */
export function namespacesForCategories(categories: readonly Category[]): string[] {
  const out = new Set<string>();
  for (const c of categories) {
    for (const ns of CATEGORY_NAMESPACES[c]) out.add(ns);
  }
  return [...out];
}

/** All category ids, in chip order. */
export const ALL_CATEGORIES: readonly Category[] = CATEGORIES.map((c) => c.id);

/**
 * Default chip selection — everything EXCEPT System. CEO #005: "hide low-value
 * system events by default but keep them searchable/filterable." System is one
 * click away (and critical-severity events still surface via the severity filter).
 */
export const DEFAULT_CATEGORIES: readonly Category[] = ALL_CATEGORIES.filter(
  (c) => c !== "system",
);
