/**
 * CrewFlow HQ — Shared Memory Engine, pure model + presentation layer
 * (CEO Directive 002, Phase 2).
 *
 * Server/client-safe. NO Supabase / server-only imports — the service
 * layer, the server actions, and the React components all import from
 * here so the vocabulary (visibilities, importances, statuses, entity
 * kinds, labels) and the pure helpers live in exactly one place.
 *
 * READ-FIRST. Nothing here calls a model provider, computes an
 * embedding, or executes anything. `embedding_placeholder` is reserved
 * architecture only. AI employees consume `canEmployeeAccess()` to read
 * permission-aware slices of memory; they never write.
 *
 * Departments are reused from the Phase 1 AI Employee Framework so the
 * memory graph and the boardroom share one department vocabulary.
 */

import {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  relativeTime,
  type Department,
} from "@/lib/ai-employees/model";

export {
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  relativeTime,
  type Department,
};

// ---------------------------------------------------------------------
// Visibility — permission-aware, reusable across memories.
// ---------------------------------------------------------------------

export const MEMORY_VISIBILITIES = [
  "public_hq",
  "department",
  "private",
  "restricted",
  "system",
] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const VISIBILITY_LABELS: Record<MemoryVisibility, string> = {
  public_hq: "Public (HQ)",
  department: "Department",
  private: "Private",
  restricted: "Restricted",
  system: "System",
};

export const VISIBILITY_HELP: Record<MemoryVisibility, string> = {
  public_hq: "Every AI employee and HQ operator can read this.",
  department: "Only employees in the matching department can read this.",
  private: "Author and explicitly granted parties only.",
  restricted: "Explicitly granted departments or employees only.",
  system: "Engine-internal. Never surfaced to AI employees.",
};

export function visibilityLabel(v: string): string {
  return VISIBILITY_LABELS[v as MemoryVisibility] ?? v;
}

// ---------------------------------------------------------------------
// Importance.
// ---------------------------------------------------------------------

export const IMPORTANCES = ["low", "normal", "high", "critical"] as const;
export type Importance = (typeof IMPORTANCES)[number];

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};

const IMPORTANCE_RANK: Record<Importance, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export function importanceLabel(i: string): string {
  return IMPORTANCE_LABELS[i as Importance] ?? i;
}

export function importanceRank(i: string): number {
  return IMPORTANCE_RANK[i as Importance] ?? 1;
}

/** High + critical count as "important" for the dashboard tile. */
export function isImportant(i: string): boolean {
  return i === "high" || i === "critical";
}

/** Human-friendly label for a 0–100 confidence score. */
export function confidenceNote(c: number): string {
  if (c >= 90) return "Verified";
  if (c >= 75) return "High";
  if (c >= 50) return "Moderate";
  return "Tentative";
}

// ---------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------

export const MEMORY_STATUSES = [
  "draft",
  "active",
  "archived",
  "superseded",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  draft: "Draft",
  active: "Active",
  archived: "Archived",
  superseded: "Superseded",
};

export function memoryStatusLabel(s: string): string {
  return STATUS_LABELS[s as MemoryStatus] ?? s;
}

// ---------------------------------------------------------------------
// Cognitive class (CrewFlow Bible, Volume X §4).
//
// The COARSE category that drives lifecycle (expiry, consolidation,
// retrieval weighting) — additive to, and orthogonal from, the
// fine-grained data-driven `memory_type` lookup. Five classes are a fixed
// enum because they drive engine behaviour; new `memory_type`s stay data.
// ---------------------------------------------------------------------

export const MEMORY_CLASSES = [
  "semantic", // durable facts & knowledge — the shared company brain
  "episodic", // a time-stamped experience an employee had
  "working", // short-lived scratchpad for an in-flight task
  "long_term", // consolidated, durable knowledge promoted from episodes
  "procedural", // learned how-to — playbooks, skills, repeatable methods
] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const MEMORY_CLASS_LABELS: Record<MemoryClass, string> = {
  semantic: "Semantic",
  episodic: "Episodic",
  working: "Working",
  long_term: "Long-term",
  procedural: "Procedural",
};

export const MEMORY_CLASS_HELP: Record<MemoryClass, string> = {
  semantic: "Durable facts and knowledge, true regardless of who learned them.",
  episodic: "A time-stamped experience an employee had at a moment in time.",
  working: "Short-lived scratchpad for an in-flight task; expires with it.",
  long_term: "Consolidated, important knowledge promoted from many episodes.",
  procedural: "Learned how-to: playbooks, skills, repeatable methods.",
};

export function memoryClassLabel(c: string): string {
  return MEMORY_CLASS_LABELS[c as MemoryClass] ?? c;
}

export function isMemoryClass(c: string): c is MemoryClass {
  return (MEMORY_CLASSES as readonly string[]).includes(c);
}

/**
 * Durable company-brain classes — never auto-expire; superseded only by
 * versioning or explicit human archival (Volume X §10).
 */
export const DURABLE_CLASSES: ReadonlySet<MemoryClass> = new Set<MemoryClass>([
  "semantic",
  "long_term",
  "procedural",
]);

/** Ephemeral lived-experience classes — subject to TTL / decay (Volume X §10). */
export const EPHEMERAL_CLASSES: ReadonlySet<MemoryClass> = new Set<MemoryClass>([
  "episodic",
  "working",
]);

export function isDurableClass(c: string): boolean {
  return DURABLE_CLASSES.has(c as MemoryClass);
}

export function isEphemeralClass(c: string): boolean {
  return EPHEMERAL_CLASSES.has(c as MemoryClass);
}

// ---------------------------------------------------------------------
// Relationship entity kinds.
// ---------------------------------------------------------------------

export const ENTITY_TYPES = [
  "feature",
  "customer",
  "organisation",
  "github_pr",
  "roadmap_item",
  "decision",
  "employee",
  "bug",
  "release",
  "documentation",
  "memory",
  "other",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  feature: "Feature",
  customer: "Customer",
  organisation: "Organisation",
  github_pr: "GitHub PR",
  roadmap_item: "Roadmap item",
  decision: "Decision",
  employee: "Employee",
  bug: "Bug",
  release: "Release",
  documentation: "Documentation",
  memory: "Memory",
  other: "Other",
};

export function entityTypeLabel(t: string): string {
  return ENTITY_TYPE_LABELS[t as EntityType] ?? t;
}

// ---------------------------------------------------------------------
// Employee link kinds + event kinds.
// ---------------------------------------------------------------------

export const LINK_KINDS = [
  "relevant",
  "pinned",
  "owner",
  "contributor",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const EVENT_TYPES = [
  "created",
  "updated",
  "viewed",
  "ai_accessed",
  "status_changed",
  "pinned",
  "unpinned",
  "linked",
  "unlinked",
  "version_restored",
  // Volume X §9–§10 lifecycle transitions (Directive 009 M1 PR5). Mirrors the
  // widened hq_memory_events.event_type CHECK in
  // 20260727000000_hq_memory_lifecycle.sql — kept in lock-step.
  "summarised",
  "consolidated",
  "superseded",
  "archived",
  "expired",
] as const;
export type MemoryEventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<MemoryEventType, string> = {
  created: "Created",
  updated: "Updated",
  viewed: "Viewed",
  ai_accessed: "Accessed by AI",
  status_changed: "Status changed",
  pinned: "Pinned",
  unpinned: "Unpinned",
  linked: "Linked",
  unlinked: "Unlinked",
  version_restored: "Version restored",
  summarised: "Summary refreshed",
  consolidated: "Consolidated into a lesson",
  superseded: "Superseded by a duplicate",
  archived: "Archived",
  expired: "Expired",
};

export function eventLabel(t: string): string {
  return EVENT_LABELS[t as MemoryEventType] ?? t.replace(/_/g, " ");
}

// ---------------------------------------------------------------------
// Domain row types (mirror the DB columns).
// ---------------------------------------------------------------------

/** Row from the extensible hq_memory_types lookup. */
export type MemoryType = {
  slug: string;
  label: string;
  description: string;
  icon: string;
  accent: string;
  default_department: string | null;
  sort_order: number;
  is_active: boolean;
};

/** Row from the extensible hq_memory_sources lookup. */
export type MemorySource = {
  slug: string;
  label: string;
  category: "manual" | "system" | "integration";
  is_active: boolean;
  sort_order: number;
};

export type MemoryRelationship = {
  id: string;
  memory_id: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string;
  relation: string;
  created_by_email: string | null;
  created_at: string;
};

export type MemoryEmployeeLink = {
  id: string;
  memory_id: string;
  ai_employee_id: string;
  link_kind: string;
  created_at: string;
};

export type MemoryAccessGrant = {
  id: string;
  memory_id: string;
  grantee_type: "department" | "employee";
  grantee_value: string;
  created_at: string;
};

export type MemoryEvent = {
  id: string;
  memory_id: string;
  event_type: string;
  actor_email: string | null;
  ai_employee_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type MemoryVersion = {
  id: string;
  memory_id: string;
  version: number;
  title: string;
  summary: string;
  body: string;
  memory_type: string | null;
  department: string | null;
  importance: string | null;
  tags: string[];
  status: string | null;
  edited_by_email: string | null;
  created_at: string;
};

/** The memory record — single source of truth. */
export type MemoryRecord = {
  id: string;
  title: string;
  summary: string;
  body: string;
  memory_type: string;
  department: string | null;
  importance: string;
  tags: string[];
  keywords: string[];
  created_by_id: string | null;
  created_by_email: string | null;
  source: string;
  visibility: string;
  organisation_id: string | null;
  organisation_name: string | null;
  confidence: number;
  status: string;
  version: number;
  pinned: boolean;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  // Additive (Volume X §5; CEO Directive 009 Module 1). Optional so the
  // existing read-first service layer keeps compiling unchanged; the AI
  // write/recall paths (PR2/PR3) populate and consume them.
  memory_class?: MemoryClass;
  owner_employee_id?: string | null;
  expires_at?: string | null;
  consolidated_into?: string | null;
  salience?: number;
  bound_task_id?: string | null;
  last_reinforced_at?: string | null;
};

/**
 * List/search projection — every column EXCEPT the (potentially large)
 * `body`. Search results, the dashboard, and per-employee feeds use this
 * so we never pull megabytes of body text to render cards.
 */
export type MemoryListItem = Omit<MemoryRecord, "body">;

export type MemoryDetail = {
  memory: MemoryRecord;
  relationships: MemoryRelationship[];
  employeeLinks: MemoryEmployeeLink[];
  grants: MemoryAccessGrant[];
  events: MemoryEvent[];
  versions: MemoryVersion[];
};

// ---------------------------------------------------------------------
// Permission resolution (pure) — the core of "permission-aware".
//
// Answers: may this AI employee READ this memory? Used to build each
// employee's read-only feed. HQ super-admin operators always see
// everything in the admin UI (this gate is for AI consumption).
// ---------------------------------------------------------------------

export function canEmployeeAccess(
  memory: Pick<MemoryRecord, "visibility" | "department" | "owner_employee_id">,
  employee: { id: string; department: string },
  grants: ReadonlyArray<Pick<MemoryAccessGrant, "grantee_type" | "grantee_value">>,
): boolean {
  // An employee may always read its OWN private experience (Volume X §6).
  // owner_employee_id is additive and optional; when absent (the classic
  // company-owned memory) this is simply false and behaviour is unchanged.
  const isOwner =
    memory.owner_employee_id != null &&
    memory.owner_employee_id === employee.id;

  const hasGrant = grants.some(
    (g) =>
      (g.grantee_type === "employee" && g.grantee_value === employee.id) ||
      (g.grantee_type === "department" &&
        g.grantee_value === employee.department),
  );

  switch (memory.visibility) {
    case "public_hq":
      return true;
    case "system":
      // Engine-internal. Never surfaced to an AI employee.
      return false;
    case "department":
      return (
        (memory.department != null &&
          memory.department === employee.department) ||
        isOwner ||
        hasGrant
      );
    case "private":
    case "restricted":
      return isOwner || hasGrant;
    default:
      // Unknown visibility → fail closed.
      return false;
  }
}

// ---------------------------------------------------------------------
// Write-permission resolution (pure) — the §6 AI write rules.
//
// Answers: when an AI employee proposes to WRITE a memory, may it commit
// autonomously, must it cross an approval checkpoint, or is it forbidden?
// This is the DB-free predicate the SQL `hq_memory_write` mirrors as its
// atomic, final gate (the same split as canEmployeeAccess ↔ the SQL stage-1
// read filter). Keyed purely on the memory shape + the employee's scopes, so
// create vs. update never changes the outcome (a create always owns itself;
// editing another's private memory is forbidden either way).
//
// Volume X §6:
//  - create episodic/working/private memory it OWNS            → autonomous
//  - create/update shared semantic/long_term/procedural        → a PROPOSAL
//      that hits an approval checkpoint, UNLESS the employee holds the
//      `memory.write.shared` capability scope (Volume XIII)     → autonomous
//  - never edit another employee's private memory, or system   → denied
// ---------------------------------------------------------------------

/** The §6 write outcomes. */
export type WriteOutcome = "autonomous" | "approval_required" | "denied";

export type WriteDecision = {
  outcome: WriteOutcome;
  /** Machine-stable reason code — for the audit trail + the (future,
   *  Module 4) approval-task payload. */
  reason: string;
};

/**
 * The capability scope that lets an employee write SHARED company knowledge
 * without an approval checkpoint (Volume X §6; Volume XIII capability model).
 * Held as a token on the employee's Capability Registry grant (Directive #015
 * / D-05); the legacy `ai_employees.permissions.scopes` column it used to live
 * on was removed in LR5.4B.
 */
export const SHARED_WRITE_SCOPE = "memory.write.shared";

// ---------------------------------------------------------------------
// The capability floor for using the memory facet AT ALL (the runner
// wiring gate — CEO Directive: shared-memory into the live runners).
//
// SHARED_WRITE_SCOPE (above) governs a NARROW question: may an already
// memory-capable employee commit SHARED company knowledge without an
// approval checkpoint. These tokens govern the COARSER, prior question a
// deterministic runner must answer before it ever touches `ctx.memory`:
// is this employee granted the memory facet at all? They mirror the
// existing employee grant vocabulary exactly (the resolved capability set
// is `tools_allowed ∪ permissions.scopes` — see the capability registry
// backfill), so no new token is minted here:
//   • "memory"        — the coarse scope an employee's grant carries when it
//                       may read AND write memory (research-ai, outreach-ai);
//   • "recall_memory" — the fine tool token for the read side (outreach-ai);
//   • "write_memory"  — the fine tool token for the write side (research-ai,
//                       outreach-ai).
// An employee whose grant carries NONE of these (e.g. lead-qualification,
// scopes `read`/`score`/`qualify`) is deny-by-default: the runner skips
// memory entirely rather than leaning on the SQL gate to refuse it — the
// default-deny floor honoured one layer earlier, and one fewer round-trip.
// ---------------------------------------------------------------------

/** The coarse capability token granting an employee use of the memory facet. */
export const MEMORY_CAPABILITY = "memory";
/** The fine tool token for the recall (read) side of the memory facet. */
export const MEMORY_RECALL_CAPABILITY = "recall_memory";
/** The fine tool token for the remember (write) side of the memory facet. */
export const MEMORY_WRITE_CAPABILITY = "write_memory";

/** Which side of the facet a capability check is for. */
export type MemoryCapabilityMode = "recall" | "remember";

/**
 * Does this employee's resolved capability set permit it to use the memory
 * facet for `mode`? Pure: keyed purely on the token set (the resolved
 * `tools_allowed ∪ scopes` union), so it is the TypeScript twin of the runner
 * gate — the coarse `memory` token grants both sides, and the fine
 * `recall_memory` / `write_memory` tokens grant their own side. This is a
 * FLOOR the runner checks BEFORE calling `ctx.memory`; the SQL primitives
 * (`hq_memory_recall` / `hq_memory_write`) remain the authoritative,
 * defence-in-depth boundary regardless of what this returns.
 */
export function employeeCanUseMemory(
  tokens: ReadonlyArray<string>,
  mode: MemoryCapabilityMode,
): boolean {
  if (tokens.includes(MEMORY_CAPABILITY)) return true;
  return mode === "recall"
    ? tokens.includes(MEMORY_RECALL_CAPABILITY)
    : tokens.includes(MEMORY_WRITE_CAPABILITY);
}

/**
 * Resolve the §6 write decision for one proposed memory write. Pure: no DB,
 * no I/O. The SQL primitive re-derives the same decision as the atomic gate.
 */
export function decideMemoryWrite(
  memory: {
    memory_class: MemoryClass;
    visibility: MemoryVisibility | string;
    owner_employee_id?: string | null;
  },
  employee: { id: string; scopes?: ReadonlyArray<string> },
): WriteDecision {
  const { visibility } = memory;
  const cls = memory.memory_class;
  const owner = memory.owner_employee_id ?? null;
  const isOwner = owner != null && owner === employee.id;

  // (1) System memory is engine-internal — never writable via the AI path.
  if (visibility === "system") {
    return { outcome: "denied", reason: "system_visibility" };
  }

  // (2) Never edit another employee's private/restricted memory (§6).
  if (
    owner != null &&
    !isOwner &&
    (visibility === "private" || visibility === "restricted")
  ) {
    return { outcome: "denied", reason: "foreign_private" };
  }

  // (3) Shared, durable company-brain knowledge (semantic/long_term/procedural
  //     at public_hq/department visibility): a PROPOSAL that crosses an approval
  //     checkpoint, unless the employee holds the shared-write capability scope.
  const isSharedDurable =
    DURABLE_CLASSES.has(cls) &&
    (visibility === "public_hq" || visibility === "department");
  if (isSharedDurable) {
    const hasScope = (employee.scopes ?? []).includes(SHARED_WRITE_SCOPE);
    return hasScope
      ? { outcome: "autonomous", reason: "shared_write_capability" }
      : { outcome: "approval_required", reason: "shared_knowledge_proposal" };
  }

  // (4) The employee's OWN lived experience (episodic/working), or its OWN
  //     private memory — autonomous: reversible, bounded, low blast-radius.
  const isOwnedExperience =
    isOwner && (cls === "episodic" || cls === "working" || visibility === "private");
  if (isOwnedExperience) {
    return { outcome: "autonomous", reason: "owned_experience" };
  }

  // (5) Fail closed — anything not explicitly permitted is denied.
  return { outcome: "denied", reason: "not_permitted" };
}

// ---------------------------------------------------------------------
// Keyword + tag normalisation (pure) — the indexing helpers the service
// runs on every write so memories are searchable + topic-grouped.
// ---------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "had", "her", "was", "one", "our", "out", "his", "has", "have", "this",
  "that", "with", "from", "they", "will", "would", "there", "their", "what",
  "about", "which", "when", "into", "your", "than", "then", "them", "these",
  "some", "more", "over", "such", "only", "also", "been", "were", "very",
]);

/**
 * Derive a compact keyword list from the searchable parts of a memory.
 * Lowercased, de-duped, stop-words + short tokens removed, capped.
 */
export function extractKeywords(
  parts: ReadonlyArray<string | null | undefined>,
  max = 12,
): string[] {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  const tokens = text.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

/** Parse a free-form tag string ("a, b c") into clean, slug-ish tags. */
export function normalizeTags(
  input: string | null | undefined,
  max = 20,
): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    let t = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (!t) continue;
    if (t.length > 40) t = t.slice(0, 40);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Dashboard aggregation (pure) — facets computed from a bounded recent
// window. Headline totals come from indexed COUNT queries in the
// service; this derives the grouped views + contributor leaderboard +
// 14-day knowledge-growth sparkline from the sampled rows.
// ---------------------------------------------------------------------

export type FacetCount = { key: string; label: string; count: number };
export type Contributor = { email: string; count: number };
export type GrowthPoint = { date: string; count: number };

export type MemoryFacets = {
  byType: FacetCount[];
  byDepartment: FacetCount[];
  byStatus: FacetCount[];
  byImportance: FacetCount[];
  topContributors: Contributor[];
  growth: GrowthPoint[];
};

type FacetRow = {
  memory_type: string;
  department: string | null;
  status: string;
  importance: string;
  created_by_email: string | null;
  created_at: string;
};

function tally(
  rows: ReadonlyArray<FacetRow>,
  pick: (r: FacetRow) => string | null,
  labelFn: (key: string) => string,
): FacetCount[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = pick(r);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelFn(key), count }))
    .sort((a, b) => b.count - a.count);
}

export function aggregateMemoryFacets(
  rows: ReadonlyArray<FacetRow>,
  typeLabels: Record<string, string> = {},
): MemoryFacets {
  const byType = tally(rows, (r) => r.memory_type, (k) => typeLabels[k] ?? k);
  const byDepartment = tally(rows, (r) => r.department, departmentLabel);
  const byStatus = tally(rows, (r) => r.status, memoryStatusLabel);
  const byImportance = tally(rows, (r) => r.importance, importanceLabel);

  const contrib = new Map<string, number>();
  for (const r of rows) {
    if (!r.created_by_email) continue;
    contrib.set(r.created_by_email, (contrib.get(r.created_by_email) ?? 0) + 1);
  }
  const topContributors = [...contrib.entries()]
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // 14-day growth, oldest → newest, zero-filled.
  const days: GrowthPoint[] = [];
  const dayCounts = new Map<string, number>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86_400_000);
    const key = dt.toISOString().slice(0, 10);
    days.push({ date: key, count: dayCounts.get(key) ?? 0 });
  }

  return { byType, byDepartment, byStatus, byImportance, topContributors, growth: days };
}

export type DashboardStats = {
  total: number;
  today: number;
  important: number;
  pinned: number;
  unread: number;
  recentlyAccessed: number;
  facets: MemoryFacets;
  recent: MemoryListItem[];
  pinnedMemories: MemoryListItem[];
};
