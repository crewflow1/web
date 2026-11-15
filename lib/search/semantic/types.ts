/**
 * Tenant Semantic Search — shared, vendor-free types.
 *
 * Pure types only (no SDK, no `server-only`, no Node builtins) so the mappers,
 * the ranker, the worker, the route, and the tests all share one vocabulary.
 */

/**
 * Where a corpus row sits on the staff-reachability allowlist. Mirrors the
 * tenant_search_documents.visibility CHECK and the retrieval RPC's gate:
 *   - "member" / "staff" → reachable by assigned staff (+ admins).
 *   - "management"       → Sales/Money/Operations admin surfaces; admin-only.
 *   - "private"          → admin-only job documents.
 * The RPC's staff allowlist is POSITIVE ('member'|'staff'), so any other value
 * fails closed for a non-admin.
 */
export type TenantSearchVisibility = "member" | "staff" | "management" | "private";

/** A corpus row as the mappers produce it (pre-embedding). */
export type TenantSearchDocument = {
  sourceTable: string;
  sourceId: string;
  /** The job this record belongs to (staff-assignment gate), or null. */
  jobId: string | null;
  visibility: TenantSearchVisibility;
  /** The embeddable + lexically-indexed text. Column-allowlisted, money-free. */
  content: string;
};

/** A single hit as the retrieval RPC returns it (NEVER carries the embedding). */
export type SemanticHit = {
  sourceTable: string;
  sourceId: string;
  jobId: string | null;
  visibility: TenantSearchVisibility;
  snippet: string;
  /** 1 - cosine_distance ∈ [-1, 1], or null when no same-version vector matched. */
  cosSim: number | null;
  /** ts_rank over the corpus content_tsv (0 when no lexical match). */
  tsRank: number;
};
