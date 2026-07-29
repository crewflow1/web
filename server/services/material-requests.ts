import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  computeMaterialFulfilment,
  isMaterialRequestOverdue,
  type MaterialFulfilmentPosition,
  type MaterialRequestLineRow,
} from "@/lib/material-requests/fulfilment";
import {
  MATERIAL_REQUEST_OPEN_STATUSES,
  type MaterialRequestStatus,
} from "@/lib/material-requests/schema";
import {
  readIssuedForLines,
  type StockSeamClient,
} from "@/server/services/material-fulfilment";

/**
 * Material requests — the read layer.
 *
 * SCOPING — three independent belts, deliberately (the job-site-hub doctrine):
 *   1. RLS: every read runs on the caller's client (the user JWT in the app).
 *   2. `org_id` PINNED explicitly. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so an RLS-only read BLENDS orgs for a dual-org
 *      member — a real P0 class this product has shipped fixes for twice
 *      (#456/#459/#461/#463/#464/#468).
 *   3. The narrowing key (job_id / request id / status set) pinned too.
 *
 * PAGING: reads go through `fetchAllRows`, whose contract requires a UNIQUE
 * TOTAL ORDER — a non-unique sort key (a date, a status) can drop or duplicate
 * rows at a page boundary. Every ordered read below therefore carries `id` as
 * the final tiebreaker, which is unique by construction.
 *
 * EMBEDS ARE FK-HINTED. material_requests carries THREE foreign keys to
 * `users` (requested_by, decided_by, created_by), so a bare `users(...)` embed
 * gives PostgREST three candidates and it rejects the WHOLE query with
 * PGRST201 — which, with the usual `data ?? []`, renders as a healthy-looking
 * empty list. Every embed here names its constraint, and the pair is
 * registered in __tests__/security/postgrest-embed-ambiguity.test.ts.
 *
 * FAN-OUT IS CONSTANT. A queue page costs three reads regardless of size:
 * requests, then all their lines, then ONE stock-movement read across every
 * line id. Never N+1.
 */

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  in: (k: string, v: readonly unknown[]) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  limit: (n: number) => Builder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};
export type MaterialRequestClient = { from: (t: string) => Builder };

export type UserStub = { full_name: string | null; email: string | null } | null;

export type MaterialRequestRow = {
  id: string;
  org_id: string;
  job_id: string | null;
  number: string;
  status: MaterialRequestStatus;
  priority: string;
  needed_by: string | null;
  notes: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  requester: UserStub;
  decider: UserStub;
  job: JobStub;
};

/**
 * `jobs` has NO title column — the app labels a job by its CUSTOMER (see the
 * job page's `job.customer?.name ?? "Job"`). The site address rides along
 * because a materials queue's next question is always "where does it go?".
 */
export type JobStub = {
  id: string;
  site_address_line1: string | null;
  site_city: string | null;
  customer: { name: string | null } | null;
} | null;

const REQUEST_COLS =
  "id, org_id, job_id, number, status, priority, needed_by, notes, requested_by, " +
  "decided_by, decided_at, rejection_reason, created_by, created_at, submitted_at, " +
  // FK-HINTED — three FKs to users on this table (see the header).
  "requester:users!material_requests_requested_by_fkey ( full_name, email ), " +
  "decider:users!material_requests_decided_by_fkey ( full_name, email ), " +
  "job:jobs ( id, site_address_line1, site_city, customer:customers ( name ) )";

const LINE_COLS = "id, material_request_id, description, qty, unit, stock_item_id, sort_order";

export type MaterialRequestLine = MaterialRequestLineRow & { material_request_id: string };

/** Ceiling on a queue page — matches the PO register (500) and /site-reports. */
export const MATERIAL_REQUEST_LIST_LIMIT = 500;
/** How many open requests the job panel lists before "view all". */
export const JOB_MATERIALS_PANEL_LIMIT = 5;

export type MaterialRequestFilters = {
  /** Empty = the default "still wants something doing" set. */
  statuses?: readonly MaterialRequestStatus[];
  jobId?: string;
  requesterId?: string;
  /** Only requests whose needed-by has passed and that are still live. */
  overdueOnly?: boolean;
};

// ── Lines ───────────────────────────────────────────────────────────────────

/** Every line for a set of requests, org-pinned and fully paged. */
export async function gatherLinesForRequests(
  db: MaterialRequestClient,
  orgId: string,
  requestIds: readonly string[],
  pageSize?: number,
): Promise<MaterialRequestLine[]> {
  if (requestIds.length === 0) return [];
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("material_request_lines")
        .select(LINE_COLS)
        .eq("org_id", orgId) // ACTIVE-ORG PIN
        .in("material_request_id", requestIds)
        // `id` is the unique total order fetchAllRows requires. Display order
        // (sort_order) is applied in-process — a non-unique sort key at a page
        // boundary can drop rows, and a dropped LINE is a material nobody buys.
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  // LOUD. This is the single most dangerous read in the module: with the error
  // discarded, a failed lines query yields ZERO lines, and
  // computeMaterialFulfilment over zero lines reports totalRequested 0 and
  // totalOutstanding 0 — i.e. "nothing is outstanding" for a request that may
  // have a site waiting on twenty bags of cement. Empty-on-error is
  // indistinguishable from healthy, which is the whole incident class
  // (__tests__/security/loud-read-failures.test.ts). The best-effort PANEL
  // wrappers below catch this and degrade visibly; the detail page lets it
  // reach the error boundary.
  if (error) {
    throw readFailure("material requests: lines", error as SupabaseReadError);
  }
  return (data as unknown as MaterialRequestLine[]) ?? [];
}

function linesByRequest(lines: readonly MaterialRequestLine[]): Map<string, MaterialRequestLine[]> {
  const map = new Map<string, MaterialRequestLine[]>();
  for (const l of lines) {
    const list = map.get(l.material_request_id) ?? [];
    list.push(l);
    map.set(l.material_request_id, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  }
  return map;
}

// ── Fulfilment for a set of requests (ONE stock read) ───────────────────────

export type FulfilmentByRequest = Map<string, MaterialFulfilmentPosition>;

/**
 * Derive the fulfilment position for every request in one pass.
 *
 * ONE stock-movement read for the whole page (plus its corrections read),
 * regardless of how many requests or lines are involved.
 */
export async function deriveFulfilment(
  db: MaterialRequestClient,
  orgId: string,
  lines: readonly MaterialRequestLine[],
): Promise<FulfilmentByRequest> {
  const grouped = linesByRequest(lines);
  const { issued, stockModulePending } = await readIssuedForLines(
    db as unknown as StockSeamClient,
    orgId,
    lines.map((l) => l.id),
  );

  const byLine = new Map<string, typeof issued>();
  for (const i of issued) {
    const list = byLine.get(i.material_request_line_id) ?? [];
    list.push(i);
    byLine.set(i.material_request_line_id, list);
  }

  const out: FulfilmentByRequest = new Map();
  for (const [requestId, reqLines] of grouped) {
    out.set(
      requestId,
      computeMaterialFulfilment({
        lines: reqLines,
        issued: reqLines.flatMap((l) => byLine.get(l.id) ?? []),
        stockModulePending,
      }),
    );
  }
  return out;
}

// ── The office queue ────────────────────────────────────────────────────────

export type MaterialRequestListItem = {
  request: MaterialRequestRow;
  lineCount: number;
  fulfilment: MaterialFulfilmentPosition;
  overdue: boolean;
};

/**
 * The /materials/requests queue.
 *
 * Ordered newest-first with `id` as the tiebreaker so the total order is
 * UNIQUE — without it two requests created in the same millisecond can swap
 * between pages, showing one twice and hiding the other.
 */
export async function gatherMaterialRequests(
  db: MaterialRequestClient,
  orgId: string,
  filters: MaterialRequestFilters = {},
  limit: number = MATERIAL_REQUEST_LIST_LIMIT,
): Promise<MaterialRequestRow[]> {
  let q = db
    .from("material_requests")
    .select(REQUEST_COLS)
    .eq("org_id", orgId); // ACTIVE-ORG PIN

  const statuses = filters.statuses?.length ? filters.statuses : undefined;
  if (statuses) q = q.in("status", statuses);
  if (filters.jobId) q = q.eq("job_id", filters.jobId);
  if (filters.requesterId) q = q.eq("requested_by", filters.requesterId);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false }) // UNIQUE tiebreaker
    .limit(limit);
  if (error) {
    console.error("[material-requests] queue read failed", error);
    return [];
  }
  return (data as unknown as MaterialRequestRow[]) ?? [];
}

export async function loadMaterialRequestQueue(
  orgId: string,
  todayIso: string,
  filters: MaterialRequestFilters = {},
): Promise<MaterialRequestListItem[]> {
  try {
    const supabase = await createClient();
    const db = supabase as unknown as MaterialRequestClient;
    const requests = await gatherMaterialRequests(db, orgId, filters);
    if (requests.length === 0) return [];

    const lines = await gatherLinesForRequests(
      db,
      orgId,
      requests.map((r) => r.id),
    );
    const fulfilment = await deriveFulfilment(db, orgId, lines);
    const counts = linesByRequest(lines);

    const items = requests.map((request) => ({
      request,
      lineCount: counts.get(request.id)?.length ?? 0,
      fulfilment:
        fulfilment.get(request.id) ??
        computeMaterialFulfilment({ lines: [], issued: [], stockModulePending: false }),
      overdue: isMaterialRequestOverdue(request, todayIso),
    }));

    // The overdue filter is applied here rather than in SQL because "overdue"
    // depends on the live status set as well as the date — one definition
    // (lib/material-requests/fulfilment) drives the filter, the badge and the
    // job panel, so they cannot disagree.
    return filters.overdueOnly ? items.filter((i) => i.overdue) : items;
  } catch (err) {
    console.error("[material-requests] queue failed", err);
    return [];
  }
}

// ── One request ─────────────────────────────────────────────────────────────

export type MaterialRequestDetail = {
  request: MaterialRequestRow;
  lines: MaterialRequestLine[];
  fulfilment: MaterialFulfilmentPosition;
};

/**
 * One request, in full.
 *
 * DELIBERATELY NOT BEST-EFFORT, unlike the panel loaders below. `null` means
 * exactly one thing here — "no such request in this org" — and a read FAILURE
 * throws instead, so the detail page reaches its error boundary rather than
 * rendering `notFound()`. Swallowing the error would tell an approver the
 * request does not exist when in truth we could not read it: a decision
 * surface must never present "I could not look" as "there is nothing there".
 */
export async function loadMaterialRequest(
  orgId: string,
  requestId: string,
): Promise<MaterialRequestDetail | null> {
  const supabase = await createClient();
  const db = supabase as unknown as MaterialRequestClient;

  const { data, error } = await db
    .from("material_requests")
    .select(REQUEST_COLS)
    .eq("org_id", orgId) // ACTIVE-ORG PIN — a dual-org member passes RLS for both
    .eq("id", requestId)
    .limit(1);
  if (error) throw readFailure("material requests: detail", error as SupabaseReadError);

  const request = ((data as unknown as MaterialRequestRow[]) ?? [])[0];
  if (!request) return null;

  const lines = await gatherLinesForRequests(db, orgId, [requestId]);
  const fulfilment = await deriveFulfilment(db, orgId, lines);
  return {
    request,
    lines: linesByRequest(lines).get(requestId) ?? [],
    fulfilment:
      fulfilment.get(requestId) ??
      computeMaterialFulfilment({ lines: [], issued: [], stockModulePending: false }),
  };
}

// ── The Job Site Hub panel ──────────────────────────────────────────────────

export type JobMaterialsSummary = {
  total: number;
  open: number;
  awaitingApproval: number;
  overdue: number;
  /** Open requests, soonest-needed first, capped at the panel limit. */
  items: MaterialRequestListItem[];
  /** True when fulfilment could not be measured — the panel says so. */
  stockModulePending: boolean;
};

/**
 * Materials on this job, for the site hub.
 *
 * Best-effort by contract: this panel renders alongside nine others, so any
 * failure degrades to an empty summary. A materials hiccup must cost the
 * materials panel, never the job page.
 */
export async function loadJobMaterialsPanel(
  orgId: string,
  jobId: string,
  todayIso: string,
  limit: number = JOB_MATERIALS_PANEL_LIMIT,
): Promise<JobMaterialsSummary> {
  const empty: JobMaterialsSummary = {
    total: 0,
    open: 0,
    awaitingApproval: 0,
    overdue: 0,
    items: [],
    stockModulePending: false,
  };
  try {
    const all = await loadMaterialRequestQueue(orgId, todayIso, { jobId });
    const open = all.filter((i) =>
      (MATERIAL_REQUEST_OPEN_STATUSES as readonly string[]).includes(i.request.status),
    );
    const sorted = [...open].sort((a, b) => {
      // Soonest-needed first; a request with no date sits behind those with one.
      const an = a.request.needed_by ?? "9999-12-31";
      const bn = b.request.needed_by ?? "9999-12-31";
      return an.localeCompare(bn) || a.request.number.localeCompare(b.request.number);
    });
    return {
      total: all.length,
      open: open.length,
      awaitingApproval: all.filter((i) => i.request.status === "submitted").length,
      overdue: all.filter((i) => i.overdue).length,
      items: sorted.slice(0, limit),
      stockModulePending: all.some((i) => i.fulfilment.stockModulePending),
    };
  } catch (err) {
    console.error("[material-requests] job panel failed", err);
    return empty;
  }
}

/** Display name for a user stub — the queue's "requested by" column. */
export function userLabel(user: UserStub): string {
  if (!user) return "—";
  return user.full_name?.trim() || user.email || "—";
}

/**
 * How this product names a job: its customer, exactly as the job page does
 * (`job.customer?.name ?? "Job"`). There is no jobs.title column, so any
 * surface that invents one drifts from every other page.
 */
export function jobLabel(job: JobStub): string | null {
  if (!job) return null;
  return job.customer?.name?.trim() || job.site_address_line1?.trim() || "Job";
}

/** "12 Mill Lane, Leeds" — the delivery hint beside a request. */
export function jobLocation(job: JobStub): string | null {
  if (!job) return null;
  const parts = [job.site_address_line1?.trim(), job.site_city?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}
