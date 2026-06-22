import "server-only";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  aggregateMemoryFacets,
  canEmployeeAccess,
  extractKeywords,
  importanceRank,
  MEMORY_CLASSES,
  MEMORY_VISIBILITIES,
  type DashboardStats,
  type MemoryAccessGrant,
  type MemoryClass,
  type MemoryDetail,
  type MemoryEmployeeLink,
  type MemoryEvent,
  type MemoryListItem,
  type MemoryRecord,
  type MemoryRelationship,
  type MemorySource,
  type MemoryType,
  type MemoryVersion,
} from "@/lib/memory/model";
import {
  rankAndAssemble,
  type AssemblyResult,
  type RecallCandidate,
} from "@/lib/memory/retrieval";
import { getEmbeddingProvider } from "@/lib/ai/embeddings";

/**
 * CrewFlow HQ — Shared Memory Engine data access (CEO Directive 002).
 *
 * Service-role client only. The eight hq_memory* tables have RLS
 * enabled with ZERO policies, so every read/write here is invisible to
 * the customer/staff JWT client. Callers (pages + actions) must already
 * have confirmed isSuperAdminEmail.
 *
 * The tables aren't in the generated Supabase types yet, so the query
 * builder is reached through a single small typed shim (`table<T>()`)
 * rather than scattering `as never` / `any` across every call. This
 * mirrors the hq-audit / ai-employees untyped-table pattern but keeps
 * the rest of the module fully typed.
 *
 * READ-FIRST for AI. AI employees consume `getEmployeeMemoryFeed`
 * (permission-filtered, read-only). Writes here are HQ-operator only and
 * are always paired with an audit entry + a memory event by the caller.
 * Nothing in this module invokes a model provider or computes an
 * embedding — `embedding_placeholder` is reserved architecture.
 */

// ---------------------------------------------------------------------
// Minimal typed shim over the (still-untyped) Supabase query builder.
// ---------------------------------------------------------------------

type DbError = { message: string } | null;
type ListResult<T> = { data: T[] | null; count: number | null; error: DbError };
type SingleResult<T> = { data: T | null; error: DbError };

interface MemQuery<T> extends PromiseLike<ListResult<T>> {
  select(
    columns: string,
    options?: { count?: "exact" | "planned" | "estimated"; head?: boolean },
  ): MemQuery<T>;
  insert(payload: unknown): MemQuery<T>;
  update(payload: unknown): MemQuery<T>;
  delete(): MemQuery<T>;
  eq(column: string, value: unknown): MemQuery<T>;
  neq(column: string, value: unknown): MemQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): MemQuery<T>;
  contains(column: string, value: unknown): MemQuery<T>;
  or(filters: string): MemQuery<T>;
  gte(column: string, value: unknown): MemQuery<T>;
  lte(column: string, value: unknown): MemQuery<T>;
  lt(column: string, value: unknown): MemQuery<T>;
  textSearch(
    column: string,
    query: string,
    options?: { type?: "websearch" | "plain" | "phrase"; config?: string },
  ): MemQuery<T>;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): MemQuery<T>;
  range(from: number, to: number): MemQuery<T>;
  limit(count: number): MemQuery<T>;
  maybeSingle(): PromiseLike<SingleResult<T>>;
}

type AdminClient = ReturnType<typeof createAdminClient>;

function table<T>(admin: AdminClient, name: string): MemQuery<T> {
  return admin.from(name as never) as unknown as MemQuery<T>;
}

/**
 * Typed shim over the (still-untyped) Supabase RPC builder. The AI write
 * path (PR2) reaches SQL engine primitives — `hq_memory_write` — through
 * this, the same way reads go through `table<T>()`. Returns the scalar the
 * function yields (a memory uuid for hq_memory_write) or null.
 */
async function callRpc<T>(
  admin: AdminClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<SingleResult<T>> {
  const run = admin.rpc as unknown as (
    f: string,
    a: Record<string, unknown>,
  ) => PromiseLike<SingleResult<T>>;
  const { data, error } = await run(fn, args);
  return { data, error };
}

// ---------------------------------------------------------------------
// Column projections — `body`, `search_tsv` and `embedding_placeholder`
// are deliberately excluded from list/feed queries.
// ---------------------------------------------------------------------

const LIST_COLUMNS = [
  "id", "title", "summary", "memory_type", "department", "importance",
  "tags", "keywords", "created_by_id", "created_by_email", "source",
  "visibility", "organisation_id", "organisation_name", "confidence",
  "status", "version", "pinned", "access_count", "last_accessed_at",
  "created_at", "updated_at",
].join(", ");

const DETAIL_COLUMNS = `${LIST_COLUMNS}, body`;

const REL_COLUMNS =
  "id, memory_id, entity_type, entity_id, entity_label, relation, created_by_email, created_at";
const LINK_COLUMNS =
  "id, memory_id, ai_employee_id, link_kind, created_at";
const GRANT_COLUMNS =
  "id, memory_id, grantee_type, grantee_value, created_at";
const EVENT_COLUMNS =
  "id, memory_id, event_type, actor_email, ai_employee_id, detail, created_at";
const VERSION_COLUMNS =
  "id, memory_id, version, title, summary, body, memory_type, department, importance, tags, status, edited_by_email, created_at";
const FACET_COLUMNS =
  "memory_type, department, status, importance, created_by_email, created_at";

const RECENT_WINDOW = 1000; // bounded sample for dashboard facets
const FEED_WINDOW = 200; // bounded candidate set per AI-employee feed

// ---------------------------------------------------------------------
// Lookups (extensible — "new memory types are data, not code").
// ---------------------------------------------------------------------

export async function listMemoryTypes(
  activeOnly = false,
): Promise<MemoryType[]> {
  const admin = createAdminClient();
  let q = table<MemoryType>(admin, "hq_memory_types").select(
    "slug, label, description, icon, accent, default_department, sort_order, is_active",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-memory] listMemoryTypes failed", error);
    return [];
  }
  return (data ?? []) as MemoryType[];
}

export async function listMemorySources(
  activeOnly = false,
): Promise<MemorySource[]> {
  const admin = createAdminClient();
  let q = table<MemorySource>(admin, "hq_memory_sources").select(
    "slug, label, category, is_active, sort_order",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-memory] listMemorySources failed", error);
    return [];
  }
  return (data ?? []) as MemorySource[];
}

/** slug -> label map for facet/labelling. */
async function memoryTypeLabelMap(): Promise<Record<string, string>> {
  const types = await listMemoryTypes();
  return Object.fromEntries(types.map((t) => [t.slug, t.label]));
}

// ---------------------------------------------------------------------
// Search — keyword (FTS) + every structured filter, paginated.
// "Everything instant": all filters hit btree/GIN indexes.
// ---------------------------------------------------------------------

export type MemorySort = "recent" | "oldest" | "accessed";

export type MemorySearchParams = {
  q?: string;
  type?: string;
  department?: string;
  importance?: string;
  status?: string;
  source?: string;
  visibility?: string;
  tag?: string;
  pinnedOnly?: boolean;
  sort?: MemorySort;
  page?: number;
  pageSize?: number;
};

export type MemorySearchResult = {
  memories: MemoryListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function searchMemories(
  params: MemorySearchParams = {},
): Promise<MemorySearchResult> {
  const admin = createAdminClient();
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = table<MemoryListItem>(admin, "hq_memories").select(LIST_COLUMNS, {
    count: "exact",
  });

  const term = params.q?.trim();
  if (term) {
    q = q.textSearch("search_tsv", term, { type: "websearch", config: "english" });
  }
  if (params.type) q = q.eq("memory_type", params.type);
  if (params.department) q = q.eq("department", params.department);
  if (params.importance) q = q.eq("importance", params.importance);
  if (params.status) q = q.eq("status", params.status);
  if (params.source) q = q.eq("source", params.source);
  if (params.visibility) q = q.eq("visibility", params.visibility);
  if (params.tag) q = q.contains("tags", [params.tag]);
  if (params.pinnedOnly) q = q.eq("pinned", true);

  switch (params.sort) {
    case "oldest":
      q = q.order("created_at", { ascending: true });
      break;
    case "accessed":
      q = q.order("last_accessed_at", { ascending: false, nullsFirst: false });
      break;
    case "recent":
    default:
      q = q.order("created_at", { ascending: false });
      break;
  }

  const { data, count, error } = await q.range(from, to);
  if (error) {
    console.error("[hq-memory] searchMemories failed", error);
    return { memories: [], total: 0, page, pageSize, pageCount: 0 };
  }
  const total = count ?? 0;
  return {
    memories: (data ?? []) as MemoryListItem[],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------
// Detail — record + every relationship/link/grant/event/version slice.
// ---------------------------------------------------------------------

export async function getMemoryRecord(id: string): Promise<MemoryRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await table<MemoryRecord>(admin, "hq_memories")
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[hq-memory] getMemoryRecord failed", error);
    return null;
  }
  return (data as MemoryRecord | null) ?? null;
}

export async function loadMemoryDetail(id: string): Promise<MemoryDetail | null> {
  const admin = createAdminClient();
  const memory = await getMemoryRecord(id);
  if (!memory) return null;

  const [rel, links, grants, events, versions] = await Promise.all([
    table<MemoryRelationship>(admin, "hq_memory_relationships")
      .select(REL_COLUMNS)
      .eq("memory_id", id)
      .order("created_at", { ascending: true }),
    table<MemoryEmployeeLink>(admin, "hq_memory_employee_links")
      .select(LINK_COLUMNS)
      .eq("memory_id", id),
    table<MemoryAccessGrant>(admin, "hq_memory_access_grants")
      .select(GRANT_COLUMNS)
      .eq("memory_id", id),
    table<MemoryEvent>(admin, "hq_memory_events")
      .select(EVENT_COLUMNS)
      .eq("memory_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    table<MemoryVersion>(admin, "hq_memory_versions")
      .select(VERSION_COLUMNS)
      .eq("memory_id", id)
      .order("version", { ascending: false }),
  ]);

  return {
    memory,
    relationships: (rel.data ?? []) as MemoryRelationship[],
    employeeLinks: (links.data ?? []) as MemoryEmployeeLink[],
    grants: (grants.data ?? []) as MemoryAccessGrant[],
    events: (events.data ?? []) as MemoryEvent[],
    versions: (versions.data ?? []) as MemoryVersion[],
  };
}

// ---------------------------------------------------------------------
// Dashboard — headline counts via indexed COUNT(head) queries; grouped
// facets + growth + contributors from a bounded recent window.
// ---------------------------------------------------------------------

async function countMemories(
  admin: AdminClient,
  build: (q: MemQuery<MemoryRecord>) => MemQuery<MemoryRecord>,
): Promise<number> {
  const base = table<MemoryRecord>(admin, "hq_memories").select("id", {
    count: "exact",
    head: true,
  });
  const { count, error } = await build(base);
  if (error) {
    console.error("[hq-memory] countMemories failed", error);
    return 0;
  }
  return count ?? 0;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const admin = createAdminClient();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const todayIso = startOfToday.toISOString();
  const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [
    total,
    today,
    important,
    pinned,
    unread,
    recentlyAccessed,
    typeLabels,
    windowRes,
    recentRes,
    pinnedRes,
  ] = await Promise.all([
    countMemories(admin, (q) => q),
    countMemories(admin, (q) => q.gte("created_at", todayIso)),
    countMemories(admin, (q) => q.in("importance", ["high", "critical"])),
    countMemories(admin, (q) => q.eq("pinned", true)),
    countMemories(admin, (q) => q.eq("access_count", 0)),
    countMemories(admin, (q) => q.gte("last_accessed_at", weekAgoIso)),
    memoryTypeLabelMap(),
    table<{
      memory_type: string;
      department: string | null;
      status: string;
      importance: string;
      created_by_email: string | null;
      created_at: string;
    }>(admin, "hq_memories")
      .select(FACET_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(RECENT_WINDOW),
    table<MemoryListItem>(admin, "hq_memories")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(8),
    table<MemoryListItem>(admin, "hq_memories")
      .select(LIST_COLUMNS)
      .eq("pinned", true)
      .order("updated_at", { ascending: false })
      .limit(8),
  ]);

  const facets = aggregateMemoryFacets(windowRes.data ?? [], typeLabels);

  return {
    total,
    today,
    important,
    pinned,
    unread,
    recentlyAccessed,
    facets,
    recent: (recentRes.data ?? []) as MemoryListItem[],
    pinnedMemories: (pinnedRes.data ?? []) as MemoryListItem[],
  };
}

// ---------------------------------------------------------------------
// AI employee feed — READ-ONLY, permission-filtered. This is the surface
// each AI employee page consumes automatically: Pinned / Relevant /
// Department / Recent memory. Editing is intentionally NOT exposed.
// ---------------------------------------------------------------------

export type EmployeeMemoryFeed = {
  pinned: MemoryListItem[];
  relevant: MemoryListItem[];
  department: MemoryListItem[];
  recent: MemoryListItem[];
};

const EMPTY_FEED: EmployeeMemoryFeed = {
  pinned: [],
  relevant: [],
  department: [],
  recent: [],
};

export async function getEmployeeMemoryFeed(employee: {
  id: string;
  department: string;
}): Promise<EmployeeMemoryFeed> {
  const admin = createAdminClient();

  const [linkRes, grantRes, candidateRes] = await Promise.all([
    table<{ memory_id: string; link_kind: string }>(
      admin,
      "hq_memory_employee_links",
    )
      .select("memory_id, link_kind")
      .eq("ai_employee_id", employee.id),
    table<{ memory_id: string; grantee_type: string; grantee_value: string }>(
      admin,
      "hq_memory_access_grants",
    )
      .select("memory_id, grantee_type, grantee_value")
      .or(
        `and(grantee_type.eq.employee,grantee_value.eq.${employee.id}),and(grantee_type.eq.department,grantee_value.eq.${employee.department})`,
      ),
    table<MemoryListItem>(admin, "hq_memories")
      .select(LIST_COLUMNS)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(FEED_WINDOW),
  ]);

  if (linkRes.error || grantRes.error || candidateRes.error) {
    console.error("[hq-memory] getEmployeeMemoryFeed failed", {
      link: linkRes.error,
      grant: grantRes.error,
      candidate: candidateRes.error,
    });
    return EMPTY_FEED;
  }

  const linkedIds = new Set((linkRes.data ?? []).map((l) => l.memory_id));
  const grantedIds = new Set((grantRes.data ?? []).map((g) => g.memory_id));
  const candidates = (candidateRes.data ?? []) as MemoryListItem[];

  const accessible = (m: MemoryListItem): boolean =>
    canEmployeeAccess(
      m,
      employee,
      grantedIds.has(m.id)
        ? [{ grantee_type: "employee", grantee_value: employee.id }]
        : [],
    );

  const pinned = candidates.filter((m) => m.pinned && accessible(m)).slice(0, 6);
  const department = candidates
    .filter((m) => m.department === employee.department && accessible(m))
    .slice(0, 6);
  const recent = candidates.filter(accessible).slice(0, 6);

  // Relevant = explicitly linked memories (the link itself is the
  // authorisation signal), fetched by id so they surface even when older
  // than the recent candidate window.
  let relevant: MemoryListItem[] = [];
  if (linkedIds.size > 0) {
    const { data: linkedRows } = await table<MemoryListItem>(admin, "hq_memories")
      .select(LIST_COLUMNS)
      .in("id", [...linkedIds])
      .eq("status", "active")
      .order("created_at", { ascending: false });
    relevant = ((linkedRows ?? []) as MemoryListItem[])
      .filter((m) => m.visibility !== "system")
      .slice(0, 6);
  }

  return { pinned, relevant, department, recent };
}

// ---------------------------------------------------------------------
// Access bookkeeping — a human opening a memory bumps its counter. Per
// the design, human views are NOT logged as per-view events (that noise
// is reserved for future AI consumption via the 'ai_accessed' event).
// ---------------------------------------------------------------------

export async function recordMemoryAccess(
  id: string,
  currentCount: number,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await table<MemoryRecord>(admin, "hq_memories")
      .update({
        access_count: currentCount + 1,
        last_accessed_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) console.error("[hq-memory] recordMemoryAccess failed", error);
  } catch (e) {
    console.error("[hq-memory] recordMemoryAccess threw", e);
  }
}

// ---------------------------------------------------------------------
// Writes — HQ operator only. Each is paired by the caller with an audit
// entry (recordAdminActivity) + revalidate. We additionally write a
// per-memory event here so the memory's own timeline is self-contained.
// ---------------------------------------------------------------------

export type RelationshipInput = {
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  relation: string;
};

export type MemoryWriteInput = {
  title: string;
  summary: string;
  body: string;
  memoryType: string;
  department: string | null;
  importance: string;
  visibility: string;
  source: string;
  status: string;
  confidence: number;
  pinned: boolean;
  tags: string[];
  organisationName: string | null;
  relationships: RelationshipInput[];
  employeeIds: string[];
  grantDepartments: string[];
};

type Actor = { id: string | null; email: string | null };

async function insertEvent(
  admin: AdminClient,
  row: {
    memory_id: string;
    event_type: string;
    actor_email: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  const { error } = await table(admin, "hq_memory_events").insert({
    memory_id: row.memory_id,
    event_type: row.event_type,
    actor_email: row.actor_email,
    ai_employee_id: null,
    detail: row.detail ?? null,
  });
  if (error) console.error("[hq-memory] insertEvent failed", error);
}

async function replaceChildRows(
  admin: AdminClient,
  memoryId: string,
  input: MemoryWriteInput,
  actorEmail: string | null,
): Promise<void> {
  // Relationships, employee links and access grants are replaced wholesale
  // on each write — simple + correct for an internal tool, and avoids
  // diffing logic. The memory's event timeline preserves the history.
  await Promise.all([
    table(admin, "hq_memory_relationships").delete().eq("memory_id", memoryId),
    table(admin, "hq_memory_employee_links").delete().eq("memory_id", memoryId),
    table(admin, "hq_memory_access_grants").delete().eq("memory_id", memoryId),
  ]);

  if (input.relationships.length > 0) {
    const { error } = await table(admin, "hq_memory_relationships").insert(
      input.relationships.map((r) => ({
        memory_id: memoryId,
        entity_type: r.entityType,
        entity_id: r.entityId,
        entity_label: r.entityLabel,
        relation: r.relation || "related_to",
        created_by_email: actorEmail,
      })),
    );
    if (error) console.error("[hq-memory] insert relationships failed", error);
  }

  if (input.employeeIds.length > 0) {
    const { error } = await table(admin, "hq_memory_employee_links").insert(
      input.employeeIds.map((employeeId) => ({
        memory_id: memoryId,
        ai_employee_id: employeeId,
        link_kind: "relevant",
        created_by_email: actorEmail,
      })),
    );
    if (error) console.error("[hq-memory] insert employee links failed", error);
  }

  if (input.grantDepartments.length > 0) {
    const { error } = await table(admin, "hq_memory_access_grants").insert(
      input.grantDepartments.map((dept) => ({
        memory_id: memoryId,
        grantee_type: "department",
        grantee_value: dept,
        created_by_email: actorEmail,
      })),
    );
    if (error) console.error("[hq-memory] insert access grants failed", error);
  }
}

function buildKeywords(input: MemoryWriteInput): string[] {
  return extractKeywords([input.title, input.summary, input.body, ...input.tags]);
}

export type WriteResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function createMemory(
  input: MemoryWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const keywords = buildKeywords(input);

  const { data, error } = await table<{ id: string }>(admin, "hq_memories")
    .insert({
      title: input.title,
      summary: input.summary,
      body: input.body,
      memory_type: input.memoryType,
      department: input.department,
      importance: input.importance,
      tags: input.tags,
      keywords,
      created_by_id: actor.id,
      created_by_email: actor.email,
      source: input.source,
      visibility: input.visibility,
      organisation_name: input.organisationName,
      confidence: input.confidence,
      status: input.status,
      version: 1,
      pinned: input.pinned,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-memory] createMemory failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  const id = data.id;

  // Version 1 snapshot.
  const { error: verErr } = await table(admin, "hq_memory_versions").insert({
    memory_id: id,
    version: 1,
    title: input.title,
    summary: input.summary,
    body: input.body,
    memory_type: input.memoryType,
    department: input.department,
    importance: input.importance,
    tags: input.tags,
    status: input.status,
    edited_by_email: actor.email,
  });
  if (verErr) console.error("[hq-memory] createMemory version failed", verErr);

  await replaceChildRows(admin, id, input, actor.email);
  await insertEvent(admin, {
    memory_id: id,
    event_type: "created",
    actor_email: actor.email,
    detail: { memory_type: input.memoryType, importance: input.importance },
  });

  return { ok: true, id };
}

export async function updateMemory(
  id: string,
  input: MemoryWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const current = await getMemoryRecord(id);
  if (!current) return { ok: false, error: "Memory not found" };

  const nextVersion = current.version + 1;
  const keywords = buildKeywords(input);

  const { error } = await table<MemoryRecord>(admin, "hq_memories")
    .update({
      title: input.title,
      summary: input.summary,
      body: input.body,
      memory_type: input.memoryType,
      department: input.department,
      importance: input.importance,
      tags: input.tags,
      keywords,
      source: input.source,
      visibility: input.visibility,
      organisation_name: input.organisationName,
      confidence: input.confidence,
      status: input.status,
      version: nextVersion,
      pinned: input.pinned,
    })
    .eq("id", id);

  if (error) {
    console.error("[hq-memory] updateMemory failed", error);
    return { ok: false, error: error.message };
  }

  const { error: verErr } = await table(admin, "hq_memory_versions").insert({
    memory_id: id,
    version: nextVersion,
    title: input.title,
    summary: input.summary,
    body: input.body,
    memory_type: input.memoryType,
    department: input.department,
    importance: input.importance,
    tags: input.tags,
    status: input.status,
    edited_by_email: actor.email,
  });
  if (verErr) console.error("[hq-memory] updateMemory version failed", verErr);

  await replaceChildRows(admin, id, input, actor.email);
  await insertEvent(admin, {
    memory_id: id,
    event_type: "updated",
    actor_email: actor.email,
    detail: { from_version: current.version, to_version: nextVersion },
  });

  return { ok: true, id };
}

export async function setMemoryPinned(
  id: string,
  pinned: boolean,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { error } = await table<MemoryRecord>(admin, "hq_memories")
    .update({ pinned })
    .eq("id", id);
  if (error) {
    console.error("[hq-memory] setMemoryPinned failed", error);
    return { ok: false, error: error.message };
  }
  await insertEvent(admin, {
    memory_id: id,
    event_type: pinned ? "pinned" : "unpinned",
    actor_email: actor.email,
  });
  return { ok: true, id };
}

export async function setMemoryStatus(
  id: string,
  status: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const current = await getMemoryRecord(id);
  if (!current) return { ok: false, error: "Memory not found" };

  const { error } = await table<MemoryRecord>(admin, "hq_memories")
    .update({ status })
    .eq("id", id);
  if (error) {
    console.error("[hq-memory] setMemoryStatus failed", error);
    return { ok: false, error: error.message };
  }
  await insertEvent(admin, {
    memory_id: id,
    event_type: "status_changed",
    actor_email: actor.email,
    detail: { from: current.status, to: status },
  });
  return { ok: true, id };
}

// ---------------------------------------------------------------------
// AI write path (Volume X §6/§12; CEO Directive 009 Module 1, PR2).
//
// `rememberMemory` is the service-layer surface the future SDK
// `Memory.remember()` binds to. It is a THIN, faithful wrapper over the
// atomic SQL primitive `hq_memory_write`, which is the SINGLE source of
// truth for the §6 write decision — it re-derives the exact rules the pure
// `decideMemoryWrite` predicate (lib/memory/model.ts) encodes and enforces
// them in-transaction (insert + version-1 snapshot + per-memory event + a
// `memory.asserted` Pulse event, atomic via the transactional outbox).
//
// One engine, two callers: the human operator path above (createMemory /
// updateMemory) is untouched; this is the additive AI author path.
//
// §6 outcomes map onto the result:
//   * autonomous commit                  -> { ok: true, id, approvalRequired: false }
//   * shared-knowledge proposal withheld -> { ok: true, id: null, approvalRequired: true }
//       (nothing touches the company brain; the waiting_approval task is opened
//        by the Module 4 Workflow/Task engine, no caller-code change — §12.2)
//   * §6 denial / invalid input          -> { ok: false, error }
//
// Embeddings are a PLUG-IN, not a dependency: the vector is backfilled by a
// future PR4 consumer off the `memory.asserted` event, so nothing here
// imports an embedding model or changes when semantic search is enabled.
// ---------------------------------------------------------------------

export type RememberInput = {
  memoryClass: string;
  memoryType: string;
  title: string;
  summary?: string;
  body?: string;
  visibility?: string;
  salience?: number;
  expiresAt?: string | null;
  boundTaskId?: string | null;
  correlationId?: string | null;
  context?: Record<string, unknown>;
};

export type RememberResult =
  | { ok: true; id: string | null; approvalRequired: boolean }
  | { ok: false; error: string };

const rememberSchema = z.object({
  memoryClass: z.enum(MEMORY_CLASSES),
  memoryType: z.string().min(1).max(60),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).optional().default(""),
  body: z.string().max(200000).optional().default(""),
  visibility: z.enum(MEMORY_VISIBILITIES).optional().default("private"),
  salience: z.number().int().min(0).max(100).optional().default(50),
  expiresAt: z.string().datetime().nullish(),
  boundTaskId: z.string().uuid().nullish(),
  correlationId: z.string().uuid().nullish(),
  context: z.record(z.unknown()).optional().default({}),
});

export async function rememberMemory(
  input: RememberInput,
  employee: { id: string },
): Promise<RememberResult> {
  const parsed = rememberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const m = parsed.data;

  // Fast, friendly rejection — an AI employee never authors engine-internal
  // memory (the SQL gate enforces this too; this just avoids a round-trip).
  if (m.visibility === "system") {
    return { ok: false, error: "system memory cannot be written by an AI employee" };
  }

  // Ownership is DERIVED, never caller-supplied: an employee owns the private
  // experience it writes (episodic/working, or anything private). Shared,
  // durable company knowledge is owner-less (the company brain). This makes
  // the §6 decision deterministic from (class, visibility) and prevents a
  // caller from spoofing ownership.
  const owner =
    m.visibility === "private" ||
    m.memoryClass === "episodic" ||
    m.memoryClass === "working"
      ? employee.id
      : null;

  const admin = createAdminClient();
  const { data, error } = await callRpc<string>(admin, "hq_memory_write", {
    p_employee_id: employee.id,
    p_class: m.memoryClass,
    p_type: m.memoryType,
    p_title: m.title,
    p_summary: m.summary,
    p_body: m.body,
    p_visibility: m.visibility,
    p_owner: owner,
    p_salience: m.salience,
    p_expires_at: m.expiresAt ?? null,
    p_bound_task_id: m.boundTaskId ?? null,
    p_correlation_id: m.correlationId ?? null,
    p_context: m.context,
  });

  if (error) {
    console.error("[hq-memory] rememberMemory failed", error);
    return { ok: false, error: error.message };
  }

  // The SQL returns the new memory's uuid on an autonomous commit, or NULL
  // when a shared-knowledge proposal is withheld pending approval. NULL is
  // unambiguous here: denials and invalid input RAISE (handled above).
  return { ok: true, id: data ?? null, approvalRequired: data == null };
}

// ---------------------------------------------------------------------
// AI recall path (Volume X §7–§8; CEO Directive 009 Module 1, PR3).
//
// `recallMemory` is the service-layer surface the future SDK
// `Memory.recall()` binds to. The split mirrors the write path: the atomic,
// permissioned reads live in the SQL primitive `hq_memory_recall` (stage 1
// the §6 permission filter — the same rules as the pure `canEmployeeAccess`
// — and stage 2 the indexed lexical + structural candidate retrieval), and
// the deterministic maths lives in the pure `rankAndAssemble`
// (lib/memory/retrieval.ts): blended scoring (§7.3), diversify (§7.4) and the
// token-budget knapsack (§8). Permission is enforced BEFORE scoring, in SQL,
// so the ranking layer can never widen what an employee may read.
//
// Reads do NOT broadcast. There is no `memory.read` verb in the frozen event
// registry and the spine is the business-event heartbeat, not the read trail,
// so recall emits nothing on The Pulse. The assembled set is instead audited
// per-memory + reinforced (decays slower, gains popularity) by the separate
// `hq_memory_reinforce` primitive — signal, not noise.
//
// Embeddings are a PLUG-IN, not a dependency (PR4). The caller passes only the
// human `query`; recall asks `getEmbeddingProvider()` for a vector ITSELF and,
// when one comes back, hands the SQL an ANN channel alongside lexical +
// structural. With no provider configured — or any provider failure — the
// vector is simply null, semantic search switches off, and every other channel
// keeps working. The application cannot tell the difference, which is exactly
// why the vector is generated here and NEVER supplied by the caller: only an
// internally-produced vector carries a known version (provider:model:dDIM:vREV),
// and that version MUST travel with the vector so the SQL only ever compares
// within one model's space. There is no `queryEmbedding` on the input — the
// stable contract is `query`, and that does not change whether semantic is on.
// ---------------------------------------------------------------------

/**
 * Hard ceiling on the query-embedding call. Recall is request-scoped and
 * latency-critical; a slow embedding provider must degrade to lexical recall,
 * never stall the read. On timeout the embed throws → semantic goes dark.
 */
const QUERY_EMBED_TIMEOUT_MS = 3_000;

/**
 * Turn the query string into a semantic probe — a (vector, version) pair — or
 * (null, null) when semantic recall isn't possible. This is the whole
 * plug-in contract on the read path, in one place:
 *
 *   - blank query                         → (null, null): nothing to embed
 *   - no provider configured              → (null, null): semantic off
 *   - provider.embed() throws / times out → (null, null): semantic off
 *   - vector has the wrong shape          → (null, null): semantic off
 *
 * In every degraded case recall keeps working on permission + lexical +
 * structural + ranking + assembly, and the caller cannot tell. The version is
 * the provider's composite identity; it is returned WITH the vector so the two
 * always travel together into the SQL (single-model-space comparison).
 */
async function resolveQueryProbe(
  query: string | null | undefined,
): Promise<{ embedding: number[] | null; version: string | null }> {
  const none = { embedding: null, version: null } as const;

  const text = query?.trim();
  if (!text) return none;

  const provider = getEmbeddingProvider();
  if (!provider) return none;

  try {
    const { vectors } = await provider.embed([text], {
      signal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
    });
    const vector = vectors[0];
    if (!vector || vector.length !== provider.info.dimension) return none;
    return { embedding: vector, version: provider.info.version };
  } catch (err) {
    // A provider failure must NEVER fail the recall the caller asked for.
    console.warn("[hq-memory] query embedding failed; semantic recall off", err);
    return none;
  }
}

export type RecallInput = {
  /** Free-text task query (websearch grammar). Null/blank → recency-ranked recall. */
  query?: string | null;
  /** Subject entity kind for structural recall (e.g. 'feature', 'customer'). */
  subjectKind?: string | null;
  /** Subject entity id (free-form, matches hq_memory_relationships.entity_id). */
  subjectId?: string | null;
  /** Restrict to specific cognitive classes (e.g. only 'procedural'). */
  classFilter?: MemoryClass[] | null;
  /** Candidate cap fetched from SQL; the ranker diversifies/budgets it down. */
  candidateLimit?: number;
  /** Token budget for the assembled context (Volume X §8). */
  tokenBudget?: number;
  /** Reinforce + audit the assembled set (default true); pass false for a dry run. */
  reinforce?: boolean;
};

/** One assembled memory the recall returns, with display metadata + how it was placed. */
export type RecallItem = {
  id: string;
  memoryClass: MemoryClass;
  memoryType: string;
  title: string;
  summary: string;
  visibility: string;
  department: string | null;
  ownerEmployeeId: string | null;
  importance: string;
  salience: number;
  pinned: boolean;
  /** Blended §7.3 score (higher = more relevant). */
  score: number;
  /** How the §8 knapsack placed it: full body, or summary-only under pressure. */
  form: "full" | "summary";
};

export type RecallResult =
  | {
      ok: true;
      /** The assembled set, highest score first. */
      items: RecallItem[];
      /** Token accounting + included/summarised/dropped ids (Volume X §8). */
      manifest: AssemblyResult;
      /** How many permitted candidates SQL returned before ranking. */
      candidateCount: number;
    }
  | { ok: false; error: string };

/** The raw candidate row hq_memory_recall returns (snake_case jsonb). */
type RecallCandidateRow = {
  id: string;
  memory_class: MemoryClass;
  memory_type: string;
  title: string;
  summary: string;
  visibility: string;
  department: string | null;
  owner_employee_id: string | null;
  importance: string;
  salience: number;
  pinned: boolean;
  access_count: number;
  consolidated_into: string | null;
  version: number;
  created_at: string;
  last_reinforced_at: string | null;
  ts_rank: number;
  structural_match: number;
  /** Semantic similarity in [-1,1] for same-version vectors; null when off/absent. */
  cos_sim: number | null;
  body_tokens: number;
  summary_tokens: number;
};

const recallSchema = z.object({
  query: z.string().max(2000).nullish(),
  subjectKind: z.string().max(60).nullish(),
  subjectId: z.string().max(300).nullish(),
  classFilter: z.array(z.enum(MEMORY_CLASSES)).nullish(),
  candidateLimit: z.number().int().min(1).max(200).optional().default(48),
  tokenBudget: z.number().int().min(1).max(200000).optional().default(4000),
  reinforce: z.boolean().optional().default(true),
});

export async function recallMemory(
  input: RecallInput,
  employee: { id: string },
): Promise<RecallResult> {
  const parsed = recallSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const m = parsed.data;

  // Resolve the semantic probe BEFORE the read — outside any transaction, one
  // optional external call, gracefully null. The vector + its version travel
  // together so the SQL only compares within one model's space; both null ⇒
  // semantic stays dark and recall is byte-identical to the lexical path.
  const probe = await resolveQueryProbe(m.query);

  const admin = createAdminClient();
  const { data, error } = await callRpc<RecallCandidateRow[]>(admin, "hq_memory_recall", {
    p_employee_id: employee.id,
    p_query: m.query ?? null,
    p_query_embedding: probe.embedding,
    p_subject_kind: m.subjectKind ?? null,
    p_subject_id: m.subjectId ?? null,
    p_class_filter: m.classFilter ?? null,
    p_limit: m.candidateLimit,
    p_query_version: probe.version,
  });

  if (error) {
    console.error("[hq-memory] recallMemory failed", error);
    return { ok: false, error: error.message };
  }

  const rows = (data ?? []) as RecallCandidateRow[];
  const byId = new Map<string, RecallCandidateRow>(rows.map((r) => [r.id, r]));
  const now = Date.now();

  // Map the raw SQL signals onto the pure candidate shape. cosSim is filled
  // only for rows that carried a same-version vector (null otherwise → the
  // scorer treats it as 0); age is now − last recall (or creation) so used
  // knowledge ranks fresher (§7 reinforcement).
  const candidates: RecallCandidate[] = rows.map((r) => ({
    id: r.id,
    memoryClass: r.memory_class,
    memoryType: r.memory_type,
    importanceRank: importanceRank(r.importance),
    salience: r.salience,
    accessCount: r.access_count,
    pinned: r.pinned,
    tsRank: r.ts_rank,
    cosSim: r.cos_sim ?? undefined,
    structuralMatch: r.structural_match,
    ageMs: now - Date.parse(r.last_reinforced_at ?? r.created_at),
    bodyTokens: r.body_tokens,
    summaryTokens: r.summary_tokens,
    supersededBy: r.consolidated_into,
  }));

  // Stage 3–5 — score → diversify → assemble, all pure (Volume X §7.3/§7.4/§8).
  const { items: ranked, manifest } = rankAndAssemble(candidates, {
    tokenBudget: m.tokenBudget,
  });

  const items: RecallItem[] = [];
  for (const it of ranked) {
    const r = byId.get(it.id);
    if (!r) continue;
    items.push({
      id: r.id,
      memoryClass: r.memory_class,
      memoryType: r.memory_type,
      title: r.title,
      summary: r.summary,
      visibility: r.visibility,
      department: r.department,
      ownerEmployeeId: r.owner_employee_id,
      importance: r.importance,
      salience: r.salience,
      pinned: r.pinned,
      score: it.score,
      form: it.form,
    });
  }

  // Reinforce + audit ONLY the assembled set (Volume X §7/§10). Best-effort:
  // a reinforcement failure must never fail the recall the caller asked for.
  if (m.reinforce && items.length > 0) {
    const { error: rErr } = await callRpc<null>(admin, "hq_memory_reinforce", {
      p_employee_id: employee.id,
      p_memory_ids: items.map((i) => i.id),
    });
    if (rErr) console.error("[hq-memory] recallMemory reinforce failed", rErr);
  }

  return { ok: true, items, manifest, candidateCount: rows.length };
}
