import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import {
  buildRetentionRegister,
  type RegisterJob,
  type RetentionRegister,
} from "@/lib/commercial/retention-register";

/**
 * The retention register's read layer. READ-ONLY by construction.
 *
 * Five paged, active-org-pinned reads composed into `buildRetentionRegister`.
 * There is no write path in this module and there must never be one: a register
 * is a statement of what the ledgers already say. No `insert`, `update`,
 * `delete`, `upsert` or `rpc` appears here, and none may be added — pinned by
 * __tests__/security/retention-register-org-scope.test.ts. In particular nothing
 * here touches `finances`: reporting retention must not post a cost.
 *
 * ── WHY EACH READ CARRIES ITS OWN `org_id` ───────────────────────────────────
 * RLS is not scoping. `current_org_ids()` returns EVERY org the viewer belongs
 * to, so for a member of two companies an unpinned read blends both registers
 * into one listing — the exact defect class the repo spent six slices closing,
 * and uniquely damaging here because the operator would take a blended figure
 * into a client meeting. Every read is `.eq("org_id", orgId)`.
 *
 * ── PAGED WITH A UNIQUE TOTAL ORDER ──────────────────────────────────────────
 * PostgREST caps a response at 1000 rows, so a bare `select()` silently
 * truncates and the register would UNDERSTATE retention with no error. Reads go
 * through `fetchAllRows`, and every ordering appends the primary key `id` so
 * rows sharing the sort key cannot be dropped or duplicated at a page boundary
 * (the F-1 silent-truncation class).
 *
 * ── LOUD READS ───────────────────────────────────────────────────────────────
 * A failed read must never render as "no retention outstanding" — that is a
 * builder deciding not to chase money that is owed. Any read failure sets
 * `loadError`, and the page renders an explicit banner instead of an empty
 * register. `EMPTY` likewise carries `loadError: true`.
 */

type Row = Record<string, unknown>;

/**
 * `completion_certificates` and the retention columns post-date the generated
 * types in lib/supabase/types.ts, so the client is reached through a precise
 * structural shim — the same seam server/services/org-cash.ts uses.
 */
type AnyB = PromiseLike<{ data: Row[] | null }> & {
  select: (c: string) => AnyB;
  order: (k: string, o: { ascending: boolean }) => AnyB;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
  eq: (k: string, v: unknown) => AnyB;
};
type LooseClient = { from: (t: string) => AnyB };

const mv = (v: unknown) => v as number | string | null;
const sv = (v: unknown) => (v == null ? null : String(v));

export interface RetentionRegisterView {
  register: RetentionRegister;
  /** The as-at date every figure was computed against (YYYY-MM-DD). */
  asAtIso: string;
  /** True when a read failed — the page must say so rather than show £0. */
  loadError: boolean;
}

const EMPTY: RetentionRegisterView = {
  register: {
    lines: [],
    totals: {
      accrued: 0,
      released: 0,
      held: 0,
      outstandingByState: { overdue: 0, due: 0, held: 0, awaiting_completion: 0, released: 0 },
      lineCountByState: { overdue: 0, due: 0, held: 0, awaiting_completion: 0, released: 0 },
      jobCount: 0,
      jobsHoldingCount: 0,
      jobsOverdueCount: 0,
    },
  },
  asAtIso: "",
  loadError: true,
};

/** One table, every row, org-pinned, paged, uniquely ordered. */
async function paged(
  db: LooseClient,
  table: string,
  cols: string,
  orderKey: string,
  orgId: string,
): Promise<{ rows: Row[]; failed: boolean }> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    const base = db
      .from(table)
      .select(cols)
      .eq("org_id", orgId)
      .order(orderKey, { ascending: true });
    return (orderKey === "id" ? base : base.order("id", { ascending: true })).range(from, to);
  });
  return { rows: data, failed: error != null };
}

/**
 * The job's SITE, as one short line. Display only — no address parsing beyond
 * picking the most specific field that is populated, so a job with no address
 * degrades to null rather than to a stray comma.
 */
function siteLabel(job: Row): string | null {
  const parts = [sv(job.site_address_line1), sv(job.site_city), sv(job.site_postcode)]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(", ") : null;
}

function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r[key] == null ? "" : String(r[key]);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

/**
 * Build the org's retention register.
 *
 * `now` is injectable so tests and the page can pin one as-at instant. The
 * business day comes from `invoiceBusinessToday` — the SAME day authority the
 * invoice-overdue and cash surfaces use, so "as at" means one thing across every
 * money report rather than two surfaces disagreeing by a day at the boundary.
 */
export async function buildRetentionRegisterView(
  orgId: string,
  now: Date = new Date(),
): Promise<RetentionRegisterView> {
  const asAtIso = invoiceBusinessToday(now);
  try {
    const supabase = await createClient();
    const db = supabase as unknown as LooseClient;

    const results = await Promise.all([
      // `jobs` has no title column — a job is identified by its customer and its
      // SITE, so the register carries the site so two jobs for the same client
      // are distinguishable in a meeting about one of them.
      paged(
        db,
        "jobs",
        "id, customer_id, site_address_line1, site_city, site_postcode, " +
          "retention_percent, practical_completion_date, " +
          "defects_liability_months, retention_first_release_pct",
        "id",
        orgId,
      ),
      // The retention BASE: non-draft NET (`amount`) per job. `status` is carried
      // because `computeRetentionPosition` owns which statuses are certified.
      paged(db, "invoices", "id, job_id, status, amount", "id", orgId),
      paged(db, "retention_releases", "id, job_id, amount", "id", orgId),
      paged(db, "customers", "id, name", "id", orgId),
      // Practical Completion Certificates. One LIVE issued cert per job is a
      // unique index (20261014000000), so filtering to `issued` in TS below
      // yields at most one per job; superseded/draft/archived rows are read and
      // discarded rather than trusted as evidence.
      paged(
        db,
        "completion_certificates",
        "id, job_id, status, certificate_number, completion_date",
        "id",
        orgId,
      ),
    ]);

    const loadError = results.some((r) => r.failed);
    const [jobRows = [], invoiceRows = [], releaseRows = [], customerRows = [], certRows = []] =
      results.map((r) => r.rows);

    const customerName = new Map(customerRows.map((c) => [String(c.id), sv(c.name)]));
    const invByJob = groupBy(invoiceRows, "job_id");
    const relByJob = groupBy(releaseRows, "job_id");

    // Issued certificates only — a draft is not evidence of anything.
    const certByJob = new Map<string, { number: string | null; date: string | null }>();
    for (const c of certRows) {
      if (String(c.status ?? "") !== "issued") continue;
      const jid = c.job_id == null ? "" : String(c.job_id);
      if (!jid) continue;
      certByJob.set(jid, {
        number: sv(c.certificate_number),
        date: sv(c.completion_date),
      });
    }

    const jobs: RegisterJob[] = jobRows.map((j) => {
      const jid = String(j.id);
      const cert = certByJob.get(jid);
      return {
        jobId: jid,
        jobLabel: siteLabel(j),
        customerId: sv(j.customer_id),
        customerName: j.customer_id ? customerName.get(String(j.customer_id)) ?? null : null,
        ratePercent: mv(j.retention_percent),
        defectsLiabilityMonths: mv(j.defects_liability_months),
        firstReleasePct: mv(j.retention_first_release_pct),
        jobCompletionDate: sv(j.practical_completion_date),
        certificateCompletionDate: cert?.date ?? null,
        certificateNumber: cert?.number ?? null,
        invoices: (invByJob.get(jid) ?? []).map((i) => ({
          status: String(i.status ?? ""),
          amount: mv(i.amount),
        })),
        releases: (relByJob.get(jid) ?? []).map((r) => ({ amount: mv(r.amount) })),
      };
    });

    return {
      register: buildRetentionRegister({ jobs, todayIso: asAtIso }),
      asAtIso,
      loadError,
    };
  } catch (err) {
    console.warn("[retention-register] buildRetentionRegisterView failed", err);
    return { ...EMPTY, asAtIso };
  }
}
