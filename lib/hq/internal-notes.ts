/**
 * CrewFlow — Internal Notes OS pure compute (HQ-9).
 *
 * Server/client-safe. Constants + sort/filter for the HQ notes view
 * and the customer-detail panel.
 */

export const INTERNAL_NOTE_CATEGORIES = [
  "general",
  "sales",
  "onboarding",
  "billing",
  "support",
  "risk",
  "technical",
  "success",
] as const;
export type InternalNoteCategory = (typeof INTERNAL_NOTE_CATEGORIES)[number];

export const INTERNAL_NOTE_CATEGORY_LABEL: Record<
  InternalNoteCategory,
  string
> = {
  general: "General",
  sales: "Sales",
  onboarding: "Onboarding",
  billing: "Billing",
  support: "Support",
  risk: "Risk",
  technical: "Technical",
  success: "Success",
};

export const INTERNAL_NOTE_CATEGORY_PILL: Record<
  InternalNoteCategory,
  string
> = {
  general: "bg-slate-100 text-slate-700 border-slate-200",
  sales: "bg-emerald-100 text-emerald-900 border-emerald-200",
  onboarding: "bg-indigo-100 text-indigo-900 border-indigo-200",
  billing: "bg-amber-100 text-amber-900 border-amber-200",
  support: "bg-blue-100 text-blue-900 border-blue-200",
  risk: "bg-red-100 text-red-800 border-red-200",
  technical: "bg-slate-200 text-slate-700 border-slate-300",
  success: "bg-emerald-100 text-emerald-900 border-emerald-200",
};

export const INTERNAL_NOTE_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
export type InternalNotePriority = (typeof INTERNAL_NOTE_PRIORITIES)[number];

export const INTERNAL_NOTE_PRIORITY_LABEL: Record<
  InternalNotePriority,
  string
> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const INTERNAL_NOTE_PRIORITY_PILL: Record<
  InternalNotePriority,
  string
> = {
  low: "bg-slate-100 text-slate-700 border-slate-200",
  normal: "bg-blue-100 text-blue-900 border-blue-200",
  high: "bg-amber-100 text-amber-900 border-amber-200",
  urgent: "bg-red-100 text-red-800 border-red-200",
};

export const INTERNAL_NOTE_PRIORITY_RANK: Record<
  InternalNotePriority,
  number
> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ---------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------

export const INTERNAL_NOTE_SORTS = [
  "default",
  "priority",
  "newest",
  "oldest",
  "category",
] as const;
export type InternalNoteSort = (typeof INTERNAL_NOTE_SORTS)[number];

export const INTERNAL_NOTE_SORT_LABEL: Record<InternalNoteSort, string> = {
  default: "Pinned, then newest",
  priority: "Priority (urgent first)",
  newest: "Newest",
  oldest: "Oldest",
  category: "Category (A→Z)",
};

export type InternalNoteRow = {
  id: string;
  org_id: string;
  org_name?: string | null;
  author_user_id: string | null;
  author_email: string;
  title: string | null;
  body: string;
  category: InternalNoteCategory | string;
  priority: InternalNotePriority | string;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export function sortNotes<T extends InternalNoteRow>(
  rows: ReadonlyArray<T>,
  sort: InternalNoteSort,
): T[] {
  const out = rows.slice();
  if (sort === "default") {
    out.sort((a, b) => {
      // 1. Pinned first
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // 2. Newest within each pinned group
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  } else if (sort === "priority") {
    out.sort((a, b) => {
      const pa = INTERNAL_NOTE_PRIORITY_RANK[a.priority as InternalNotePriority] ?? 9;
      const pb = INTERNAL_NOTE_PRIORITY_RANK[b.priority as InternalNotePriority] ?? 9;
      if (pa !== pb) return pa - pb;
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    });
  } else if (sort === "newest") {
    out.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } else if (sort === "oldest") {
    out.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  } else if (sort === "category") {
    out.sort((a, b) => a.category.localeCompare(b.category));
  }
  return out;
}

export function filterNotes<T extends InternalNoteRow>(
  rows: ReadonlyArray<T>,
  f: {
    q?: string | null;
    category?: InternalNoteCategory | "all" | null;
    priority?: InternalNotePriority | "all" | null;
    org_id?: string | null;
    show_archived?: boolean;
    pinned_only?: boolean;
  },
): T[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((n) => {
    if (!f.show_archived && n.archived_at !== null) return false;
    if (f.pinned_only && !n.pinned) return false;
    if (q) {
      const blob = `${n.title ?? ""} ${n.body} ${n.author_email} ${n.org_name ?? ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    if (f.category && f.category !== "all" && n.category !== f.category) {
      return false;
    }
    if (f.priority && f.priority !== "all" && n.priority !== f.priority) {
      return false;
    }
    if (f.org_id && n.org_id !== f.org_id) return false;
    return true;
  });
}

export function isValidCategory(s: string): s is InternalNoteCategory {
  return (INTERNAL_NOTE_CATEGORIES as ReadonlyArray<string>).includes(s);
}

export function isValidPriority(s: string): s is InternalNotePriority {
  return (INTERNAL_NOTE_PRIORITIES as ReadonlyArray<string>).includes(s);
}
