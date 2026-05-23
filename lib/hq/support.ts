/**
 * CrewFlow — Support OS pure compute (HQ-7).
 *
 * Server/client-safe. Used by both the customer workspace
 * (`/support/*`) and the HQ admin (`/admin/support`). Keeping
 * status/priority/category vocab in one place means a future
 * rename can't drift between sides.
 */

// =====================================================================
// Statuses
// =====================================================================

export const SUPPORT_STATUSES = [
  "open",
  "in_progress",
  "waiting_on_customer",
  "resolved",
  "closed",
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};

export const SUPPORT_STATUS_PILL: Record<SupportStatus, string> = {
  open: "bg-amber-100 text-amber-900 border-amber-200",
  in_progress: "bg-blue-100 text-blue-900 border-blue-200",
  waiting_on_customer: "bg-indigo-100 text-indigo-900 border-indigo-200",
  resolved: "bg-emerald-100 text-emerald-900 border-emerald-200",
  closed: "bg-slate-200 text-slate-700 border-slate-300",
};

/** Statuses that count as "still active" — drives badge counts. */
export const SUPPORT_ACTIVE_STATUSES: ReadonlyArray<SupportStatus> = [
  "open",
  "in_progress",
  "waiting_on_customer",
];

export function isActiveStatus(s: string): s is SupportStatus {
  return SUPPORT_ACTIVE_STATUSES.includes(s as SupportStatus);
}

// =====================================================================
// Priorities
// =====================================================================

export const SUPPORT_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_PRIORITY_LABEL: Record<SupportPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const SUPPORT_PRIORITY_PILL: Record<SupportPriority, string> = {
  low: "bg-slate-100 text-slate-700 border-slate-200",
  normal: "bg-blue-100 text-blue-900 border-blue-200",
  high: "bg-amber-100 text-amber-900 border-amber-200",
  urgent: "bg-red-100 text-red-800 border-red-200",
};

export const SUPPORT_PRIORITY_RANK: Record<SupportPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// =====================================================================
// Categories
// =====================================================================

export const SUPPORT_CATEGORIES = [
  "billing",
  "onboarding",
  "migration",
  "bug",
  "feature_request",
  "account",
  "other",
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_CATEGORY_LABEL: Record<SupportCategory, string> = {
  billing: "Billing",
  onboarding: "Onboarding",
  migration: "Migration",
  bug: "Bug",
  feature_request: "Feature request",
  account: "Account",
  other: "Other",
};

// =====================================================================
// Sort / filter
// =====================================================================

export const SUPPORT_SORTS = [
  "needs_attention",
  "priority",
  "newest",
  "oldest",
  "customer",
  "status",
] as const;
export type SupportSort = (typeof SUPPORT_SORTS)[number];

export const SUPPORT_SORT_LABELS: Record<SupportSort, string> = {
  needs_attention: "Needs attention (default)",
  priority: "Priority (urgent first)",
  newest: "Newest",
  oldest: "Oldest",
  customer: "Customer (A→Z)",
  status: "Status",
};

/**
 * Common ticket row shape used by both sides. The DB schema has more
 * columns; this is what the sort/filter helpers need.
 */
export type SupportTicketRow = {
  id: string;
  org_id: string;
  org_name: string | null;
  ticket_number: number;
  subject: string;
  status: SupportStatus | string;
  priority: SupportPriority | string;
  category: SupportCategory | string;
  created_at: string;
  last_reply_at: string | null;
  last_reply_kind: "customer" | "hq" | null;
};

export function sortTickets<T extends SupportTicketRow>(
  rows: ReadonlyArray<T>,
  sort: SupportSort,
): T[] {
  const out = rows.slice();
  if (sort === "needs_attention") {
    out.sort((a, b) => {
      // 1. Active before resolved/closed.
      const aActive = isActiveStatus(a.status) ? 0 : 1;
      const bActive = isActiveStatus(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      // 2. Customer-last-replied before HQ-last-replied (we owe them).
      const aOwe = a.last_reply_kind === "customer" ? 0 : 1;
      const bOwe = b.last_reply_kind === "customer" ? 0 : 1;
      if (aOwe !== bOwe) return aOwe - bOwe;
      // 3. Higher priority first.
      const pa = SUPPORT_PRIORITY_RANK[a.priority as SupportPriority] ?? 9;
      const pb = SUPPORT_PRIORITY_RANK[b.priority as SupportPriority] ?? 9;
      if (pa !== pb) return pa - pb;
      // 4. Oldest first — ageing tickets get attention.
      return (
        new Date(a.last_reply_at ?? a.created_at).getTime() -
        new Date(b.last_reply_at ?? b.created_at).getTime()
      );
    });
  } else if (sort === "priority") {
    out.sort((a, b) => {
      const pa = SUPPORT_PRIORITY_RANK[a.priority as SupportPriority] ?? 9;
      const pb = SUPPORT_PRIORITY_RANK[b.priority as SupportPriority] ?? 9;
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
  } else if (sort === "customer") {
    out.sort((a, b) =>
      (a.org_name ?? "").localeCompare(b.org_name ?? ""),
    );
  } else if (sort === "status") {
    const statusOrder: Record<string, number> = {
      open: 0,
      in_progress: 1,
      waiting_on_customer: 2,
      resolved: 3,
      closed: 4,
    };
    out.sort(
      (a, b) =>
        (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9),
    );
  }
  return out;
}

export function filterTickets<T extends SupportTicketRow>(
  rows: ReadonlyArray<T>,
  f: {
    q?: string | null;
    status?: SupportStatus | "all" | "active" | null;
    priority?: SupportPriority | "all" | null;
    category?: SupportCategory | "all" | null;
  },
): T[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((t) => {
    if (q) {
      const blob = `${t.subject} ${t.org_name ?? ""} #${t.ticket_number}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    if (f.status && f.status !== "all") {
      if (f.status === "active") {
        if (!isActiveStatus(t.status)) return false;
      } else if (t.status !== f.status) return false;
    }
    if (f.priority && f.priority !== "all" && t.priority !== f.priority) {
      return false;
    }
    if (f.category && f.category !== "all" && t.category !== f.category) {
      return false;
    }
    return true;
  });
}

// =====================================================================
// Display helpers
// =====================================================================

export function isValidStatus(s: string): s is SupportStatus {
  return (SUPPORT_STATUSES as ReadonlyArray<string>).includes(s);
}

export function isValidPriority(s: string): s is SupportPriority {
  return (SUPPORT_PRIORITIES as ReadonlyArray<string>).includes(s);
}

export function isValidCategory(s: string): s is SupportCategory {
  return (SUPPORT_CATEGORIES as ReadonlyArray<string>).includes(s);
}

/**
 * Returns the human "X needs attention" badge text for a count.
 * 0 → null (UI hides the badge).
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}
