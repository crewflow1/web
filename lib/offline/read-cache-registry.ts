/**
 * OFFLINE READ CACHE REGISTRY — the one place that decides what CrewFlow will
 * cache for OFFLINE VIEWING, and exactly which columns of it.
 *
 * This is the read-side sibling of lib/offline/registry.ts (the WRITE registry).
 * The two answer opposite questions and must not be confused:
 *
 *   write registry   "what may a foreman AUTHOR with no signal?"  (product risk:
 *                     money, sequencing, other people's concurrent edits)
 *   read registry    "what already-fetched, server-authored data may be KEPT on
 *                     the device so a page still renders with no signal?"
 *
 * A cached read is a COPY of something the server still holds and RLS still
 * governs whenever online — so losing it costs only a re-download, never data
 * (the exact property that makes lib/blueprints/offline-store.ts safe to clear).
 * That is why the read cache is a defence-in-depth convenience, not an authority:
 * the server, under the caller's JWT and RLS, remains the only authority for what
 * a user may see whenever there IS a signal.
 *
 * ── The three properties every cached read must have ──────────────────────────
 *
 * 1. ORG-PINNED. Every snapshot is stored under `userId::orgId::kind` and the
 *    server query that fills it is pinned to the ACTIVE org (`.eq("org_id", …)`),
 *    never left to RLS to widen for a multi-org member. A snapshot authored while
 *    Company A was active is never served while Company B is active.
 *
 * 2. PAGED + BOUNDED. Each kind caches at most `pageLimit` rows (the most recent
 *    page a field user realistically needs on site), and the store as a whole is
 *    byte-capped. A cache that grew without bound would evict a foreman's queued
 *    WRITES out of the shared origin quota — the one thing that must never be lost
 *    — so the read cache always leaves that headroom (see read-cache.ts).
 *
 * 3. SAFE COLUMNS ONLY. Each kind projects an explicit column allowlist. This is
 *    not cosmetic: it keeps commercially- or personally-sensitive fields off the
 *    device where they are not needed to render the offline view, and it means a
 *    later column addition is NEVER cached by accident (it must be added here,
 *    deliberately, the same three-gate discipline the write registry uses).
 *
 * ── Why invoices are cached "header only" ─────────────────────────────────────
 * Invoices are numbered commercial documents. The offline view is a READ — a
 * foreman on site checking "is plot 4 invoiced, and is it paid?" — so the cache
 * carries the header facts that answer that (number, status, total, due/paid
 * dates) and nothing that would let anything be RE-DERIVED or edited offline.
 * Invoices remain firmly NON-writable offline (the write registry's exclusion is
 * unchanged); caching their headers for viewing does not touch that.
 */

/** Every entity kind the read cache understands. */
export const OFFLINE_READ_KINDS = [
  "jobs",
  "customers",
  "invoices",
  "site_diary",
  "snags",
] as const;
export type OfflineReadKind = (typeof OFFLINE_READ_KINDS)[number];

export type OfflineReadEntity = {
  /** The physical table the snapshot is read from. */
  readonly table: string;
  /** Human label for any offline UI ("12 jobs available offline"). */
  readonly label: string;
  readonly labelPlural: string;
  /** Where the user goes to see the live version when back online. */
  readonly viewHref: string;
  /**
   * The EXACT columns projected into the cache. An allowlist, so a future column
   * is never cached by accident — it has to be added here on purpose.
   */
  readonly columns: readonly string[];
  /**
   * The column the paged read orders by (descending) — the "most recent page"
   * a field user needs on site. Must be one of `columns`.
   */
  readonly orderBy: string;
  /** Most rows to keep for this kind. Paged + bounded (property 2). */
  readonly pageLimit: number;
};

export const OFFLINE_READ_REGISTRY: Readonly<
  Record<OfflineReadKind, OfflineReadEntity>
> = {
  jobs: {
    table: "jobs",
    label: "job",
    labelPlural: "jobs",
    viewHref: "/jobs",
    // No `notes`/`ai_summary` free-text or `photos` paths — the list view needs
    // identity + status + schedule, not the whole record.
    columns: [
      "id",
      "customer_id",
      "assigned_to",
      "status",
      "scheduled_date",
      "updated_at",
    ],
    orderBy: "updated_at",
    pageLimit: 200,
  },
  customers: {
    table: "customers",
    label: "customer",
    labelPlural: "customers",
    viewHref: "/customers",
    // Contact identity for the on-site "who do I call?" — name + phone + email.
    // `notes` (free text) stays off the device.
    columns: ["id", "name", "email", "phone", "updated_at"],
    orderBy: "updated_at",
    pageLimit: 200,
  },
  invoices: {
    table: "invoices",
    label: "invoice",
    labelPlural: "invoices",
    viewHref: "/invoices",
    // Header only (see file header): number, money, status, key dates. No line
    // items, no notes — nothing that could be re-derived or edited offline.
    columns: [
      "id",
      "number",
      "status",
      "total",
      "due_date",
      "paid_at",
      "updated_at",
    ],
    orderBy: "updated_at",
    pageLimit: 200,
  },
  site_diary: {
    table: "site_diary_entries",
    label: "diary entry",
    labelPlural: "diary entries",
    viewHref: "/diary",
    columns: [
      "id",
      "job_id",
      "entry_date",
      "weather",
      "labour_count",
      "work_summary",
      "delays",
      "notes",
      "updated_at",
    ],
    orderBy: "entry_date",
    pageLimit: 200,
  },
  snags: {
    table: "snags",
    label: "snag",
    labelPlural: "snags",
    viewHref: "/snags",
    columns: [
      "id",
      "job_id",
      "title",
      "description",
      "location",
      "trade",
      "priority",
      "status",
      "due_date",
      "updated_at",
    ],
    orderBy: "updated_at",
    pageLimit: 200,
  },
};

/** Narrows an arbitrary string to a cacheable read kind (used as a gate). */
export function isOfflineReadKind(kind: unknown): kind is OfflineReadKind {
  return (
    typeof kind === "string" &&
    (OFFLINE_READ_KINDS as readonly string[]).includes(kind)
  );
}

/** Registry lookup that cannot return undefined for a validated kind. */
export function offlineReadEntity(kind: OfflineReadKind): OfflineReadEntity {
  return OFFLINE_READ_REGISTRY[kind];
}

/** "2 jobs" / "1 job" — never "2 job". */
export function describeOfflineReadCount(
  kind: OfflineReadKind,
  n: number,
): string {
  const e = offlineReadEntity(kind);
  return `${n} ${n === 1 ? e.label : e.labelPlural}`;
}
