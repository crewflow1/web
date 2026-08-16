import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  computeVatNetTotals,
  computeVatQuarter,
  endOfQuarterExclusiveIso,
} from "@/lib/tax/compute";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";
import { composeVatReturn } from "@/lib/integrations/hmrc/vat-return";
import { composeCis300Return } from "@/lib/integrations/hmrc/cis-return";
import {
  composeFpsReturn,
  type FpsInputEmployee,
  type FpsYearToDate,
} from "@/lib/integrations/hmrc/rti-fps";
import {
  getContractorProfile,
  liveReturnDataset,
} from "@/server/services/cis-statements";

/**
 * HMRC connections service — org-pinned, token-FREE read over hmrc_connections.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. The query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected" — reporting HMRC as not-connected when the read merely
 * errored is the precise lie loud reads exist to stop.
 *
 * TOKEN-FREE. The token columns are NEVER selected here (they are also stripped
 * from the authenticated read surface by a column privilege in 20261099). Only
 * the connection state the UI needs is returned.
 *
 * DARK. This service never writes a token or a `connected` status — that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without HMRC client credentials + the feature flag.
 */

export type HmrcConnection = {
  status: "disconnected" | "connecting" | "connected" | "error";
  vrn: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const SELECT_COLUMNS = "status, hmrc_vrn, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  status: string;
  hmrc_vrn: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

/** The single HMRC connection state for one org, defaulting to disconnected when absent. Org-pinned, loud. */
export async function getHmrcConnection(orgId: string): Promise<HmrcConnection> {
  const supabase = await createClient();
  // hmrc_connections post-dates the generated types.ts; cast to a minimal
  // select builder (the accounting_connections idiom).
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{
            data: ConnectionRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
  const { data, error } = await loose
    .from("hmrc_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("hmrc connection: get", error);

  if (!data) {
    return { status: "disconnected", vrn: null, connectedAt: null, lastSyncAt: null, lastError: null };
  }
  return {
    status: data.status as HmrcConnection["status"],
    vrn: data.hmrc_vrn,
    connectedAt: data.connected_at,
    lastSyncAt: data.last_sync_at,
    lastError: data.last_error,
  };
}

// ---------------------------------------------------------------------------
// hmrc_submissions — the INTERNAL prepare/hold record (dark submit stays off)
//
// This is the writer + reader the 20261099 migration and the settings panel
// already promise. Preparing a return is PURE composition over CrewFlow's OWN
// tax authorities (computeVatQuarter / buildMonthlyReturnDataset) plus a DB
// INSERT — no HMRC network call, no token, no vendor recognition. The composers
// are invoked with `allowInternalPrepare: true` so this works while HMRC stays
// dark. There is deliberately NO submit/POST here: the terminal filing path is
// legally recognition-gated and stays absent (see lib/integrations/hmrc/oauth.ts
// and the migration's LEGAL BOUNDARY note).
//
// APPEND-ONLY + IDEMPOTENT. hmrc_submissions has no update/delete policy, so a
// prepared record cannot be rewritten. There is no unique constraint on
// (org, kind, period), so idempotency is enforced here with a LOUD pre-check:
// re-preparing the same period returns the existing row rather than duplicating.
//
// TOKEN-FREE. hmrc_submissions carries no secret — the payload is the org's own
// tax figures a member may already see. This module never selects a token column.
// ---------------------------------------------------------------------------

export type HmrcSubmissionKind = "vat_return" | "cis300" | "fps";
export type HmrcSubmissionStatus = "prepared" | "held";

export type HmrcSubmission = {
  id: string;
  kind: HmrcSubmissionKind;
  periodKey: string;
  status: HmrcSubmissionStatus;
  payload: unknown;
  preparedBy: string | null;
  createdAt: string;
};

export type PrepareSubmissionResult =
  | { ok: true; id: string; created: boolean; status: HmrcSubmissionStatus }
  | { ok: false; error: string };

const SUBMISSION_COLUMNS = "id, kind, period_key, status, payload, prepared_by, created_at";

type SubmissionRow = {
  id: string;
  kind: string;
  period_key: string;
  status: string;
  payload: unknown;
  prepared_by: string | null;
  created_at: string;
};

/** PostgREST surfaces our RAISE messages; strip the SQL noise for the operator. */
function humanise(message: string): string {
  return message.replace(/^[A-Z0-9]{5}:\s*/, "").trim();
}

// hmrc_connections / hmrc_submissions post-date the generated types.ts; reach
// them through a minimal structural cast (the accounting_connections idiom used
// by getHmrcConnection above and the wider CIS domain).
type DbResult<T> = { data: T | null; error: { message: string } | null };
interface QueryBuilder<T> extends PromiseLike<DbResult<T[]>> {
  eq(col: string, val: unknown): QueryBuilder<T>;
  gte(col: string, val: unknown): QueryBuilder<T>;
  lte(col: string, val: unknown): QueryBuilder<T>;
  lt(col: string, val: unknown): QueryBuilder<T>;
  in(col: string, vals: unknown[]): QueryBuilder<T>;
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder<T>;
  limit(n: number): QueryBuilder<T>;
  range(from: number, to: number): QueryBuilder<T>;
  maybeSingle(): PromiseLike<DbResult<T>>;
}
interface InsertBuilder<T> extends PromiseLike<DbResult<T[]>> {
  select(cols?: string): InsertBuilder<T>;
  single(): PromiseLike<DbResult<T>>;
}
interface LooseTable {
  select(cols: string): QueryBuilder<Record<string, unknown>>;
  insert(row: Record<string, unknown>): InsertBuilder<Record<string, unknown>>;
}
type LooseDb = { from(t: string): LooseTable };

async function looseDb(): Promise<LooseDb> {
  return (await createClient()) as unknown as LooseDb;
}

function toSubmission(row: SubmissionRow): HmrcSubmission {
  return {
    id: row.id,
    kind: row.kind as HmrcSubmissionKind,
    periodKey: row.period_key,
    status: row.status as HmrcSubmissionStatus,
    payload: row.payload,
    preparedBy: row.prepared_by,
    createdAt: row.created_at,
  };
}

/**
 * Every prepared/held HMRC submission for one org, newest first. Org-pinned
 * (current_org_ids() admits every org a multi-org admin belongs to, so an
 * unpinned read would blend two companies' returns) and LOUD.
 */
export async function getHmrcSubmissions(orgId: string): Promise<HmrcSubmission[]> {
  const db = await looseDb();
  const { data, error } = await db
    .from("hmrc_submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) throw readFailure("hmrc submissions: list", error);
  return ((data ?? []) as unknown as SubmissionRow[]).map(toSubmission);
}

/** LOUD idempotency probe — an existing prepared/held record for this period. */
async function findSubmission(
  db: LooseDb,
  orgId: string,
  kind: HmrcSubmissionKind,
  periodKey: string,
): Promise<{ id: string; status: HmrcSubmissionStatus } | null> {
  const { data, error } = await db
    .from("hmrc_submissions")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("period_key", periodKey)
    .limit(1);
  if (error) throw readFailure("hmrc submissions: idempotency check", error);
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string }>;
  const row = rows[0];
  return row ? { id: row.id, status: row.status as HmrcSubmissionStatus } : null;
}

/**
 * Ensure the org has an hmrc_connections row and return its id. hmrc_submissions'
 * composite FK (connection_id, org_id) requires one. A DISCONNECTED row is the
 * only dark-reachable connection state (migration 20261099) — it carries no
 * token and no VRN and exists solely to anchor the submission. Admin-insert RLS
 * is the real boundary; this runs under the caller's JWT.
 */
async function ensureConnectionId(db: LooseDb, orgId: string): Promise<string> {
  const { data: existing, error: readErr } = await db
    .from("hmrc_connections")
    .select("id")
    .eq("org_id", orgId)
    .maybeSingle();
  if (readErr) throw readFailure("hmrc connection: ensure (read)", readErr);
  const existingId = (existing as { id?: unknown } | null)?.id;
  if (typeof existingId === "string" && existingId.length > 0) return existingId;

  const { data: inserted, error: insErr } = await db
    .from("hmrc_connections")
    .insert({ org_id: orgId, provider: "hmrc", status: "disconnected" })
    .select("id")
    .single();
  if (insErr) throw readFailure("hmrc connection: ensure (insert)", insErr);
  const id = (inserted as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("hmrc connection: ensure returned no id");
  }
  return id;
}

/** INSERT the frozen payload under the admin-insert RLS. Never mutates. */
async function insertSubmission(
  db: LooseDb,
  p: {
    orgId: string;
    preparedBy: string;
    kind: HmrcSubmissionKind;
    periodKey: string;
    status: HmrcSubmissionStatus;
    payload: unknown;
  },
): Promise<PrepareSubmissionResult> {
  const connectionId = await ensureConnectionId(db, p.orgId);
  const { data, error } = await db
    .from("hmrc_submissions")
    .insert({
      org_id: p.orgId,
      connection_id: connectionId,
      kind: p.kind,
      period_key: p.periodKey,
      status: p.status,
      payload: p.payload,
      prepared_by: p.preparedBy,
    })
    .select("id, status")
    .single();
  if (error) return { ok: false, error: humanise(error.message) };
  const row = data as { id?: unknown; status?: unknown } | null;
  if (!row || typeof row.id !== "string") {
    return { ok: false, error: "hmrc prepare: insert returned no row" };
  }
  return {
    ok: true,
    id: row.id,
    created: true,
    status: (typeof row.status === "string" ? row.status : p.status) as HmrcSubmissionStatus,
  };
}

/**
 * Prepare + HOLD an internal VAT return for the quarter starting `quarterStartIso`.
 * Reads the org's own invoices/finances, runs the single VAT authority
 * (computeVatQuarter), composes the 9-box payload and freezes it in
 * hmrc_submissions. Idempotent per (org, period): re-preparing returns the
 * existing row. Nothing is transmitted to HMRC.
 *
 * `periodKey` is CrewFlow's own quarter identifier (the quarter-start date). The
 * real MTD obligation periodKey comes from HMRC's retrieve-obligations API, which
 * is dark; the internal record is honest about being CrewFlow's own period.
 */
export async function prepareVatReturn(params: {
  orgId: string;
  preparedBy: string;
  quarterStartIso: string;
  status?: HmrcSubmissionStatus;
}): Promise<PrepareSubmissionResult> {
  const { orgId, preparedBy } = params;
  const status = params.status ?? "prepared";
  const quarterStartIso = params.quarterStartIso;
  const quarterEndIso = endOfQuarterExclusiveIso(quarterStartIso);
  const periodKey = quarterStartIso.slice(0, 10);

  const db = await looseDb();

  const existing = await findSubmission(db, orgId, "vat_return", periodKey);
  if (existing) return { ok: true, id: existing.id, created: false, status: existing.status };

  // Output VAT is CASH — every payment received in the quarter (the
  // invoice_payments LEDGER), so a partial payment on a still-open invoice
  // counts on the day the cash landed. Input VAT is ACCRUAL (finance rows logged
  // in the quarter). Domestic reverse-charge VAT (S55A) is self-accounted into
  // boxes 1 AND 4 (net-neutral) with its net value in box 7. Same predicates the
  // tax page and quarterly PDF use, so the prepared record matches what the org
  // sees. All three inputs come from the ONE paged read layer.
  //
  // PAGED (F-1). computeVatQuarter SUMs by iterating every row: the ledger and
  // reverse-charge reads page under the 1000-row cap (see gatherVatQuarterInputs)
  // and the finances read pages here on created_at+id — a bare `.select()` would
  // truncate and freeze too little VAT into hmrc_submissions.payload.
  const inputs = await gatherVatQuarterInputs(
    db as unknown as VatInputsDb,
    orgId,
    quarterStartIso,
    quarterEndIso,
  );
  const { data: finRows, error: finErr } = await fetchAllRows((from, to) =>
    db
      .from("finances")
      .select("id, vat_total, amount, created_at")
      .eq("org_id", orgId)
      .gte("created_at", quarterStartIso)
      .lt("created_at", quarterEndIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (finErr) throw readFailure("hmrc vat prepare: finances", finErr);

  const finances = ((finRows ?? []) as unknown as Array<{
    vat_total: number | string | null;
    amount: number | string | null;
    created_at: string;
  }>).map((f) => ({ vat_total: f.vat_total, amount: f.amount, created_at: f.created_at }));

  const vat = computeVatQuarter(
    inputs.invoicePayments,
    finances,
    quarterStartIso,
    quarterEndIso,
    inputs.reverseCharge.vat,
  );
  // Boxes 6/7 (mandatory net totals) are NOT VAT amounts, but they ARE derivable
  // from the SAME rows and window that feed boxes 1/4: box 6 is the net (ex-VAT)
  // value of the payments summed for box 1; box 7 the net value of the finance
  // rows summed for box 4 — which already includes reverse-charge purchase bills
  // (they are finance rows), so box 7 counts their net exactly once. Same set,
  // same window — so the frozen 9-box payload's net totals reconcile with its
  // VAT boxes instead of freezing at £0.
  const netTotals = computeVatNetTotals(
    inputs.invoicePayments,
    finances,
    quarterStartIso,
    quarterEndIso,
  );
  const composed = composeVatReturn(
    { periodKey, vat, netTotals },
    { allowInternalPrepare: true },
  );
  if (!composed.ok) return { ok: false, error: composed.message };

  return insertSubmission(db, {
    orgId,
    preparedBy,
    kind: "vat_return",
    periodKey,
    status,
    payload: composed.payload,
  });
}

/**
 * Prepare + HOLD an internal CIS300 monthly return for the tax month ending
 * `taxMonthEnd`. Reads the org's frozen CIS snapshots via the existing dataset
 * builder (liveReturnDataset), composes the CIS300 payload and freezes it.
 * Idempotent per (org, period). Nothing is transmitted to HMRC; declarations are
 * never asserted (the composer leaves them null).
 */
export async function prepareCis300Return(params: {
  orgId: string;
  preparedBy: string;
  taxMonthEnd: string;
  status?: HmrcSubmissionStatus;
}): Promise<PrepareSubmissionResult> {
  const { orgId, preparedBy, taxMonthEnd } = params;
  const status = params.status ?? "prepared";
  const periodKey = taxMonthEnd;

  const db = await looseDb();

  const existing = await findSubmission(db, orgId, "cis300", periodKey);
  if (existing) return { ok: true, id: existing.id, created: false, status: existing.status };

  const dataset = await liveReturnDataset(orgId, taxMonthEnd);
  const profile = await getContractorProfile(orgId);
  const contractor = profile
    ? {
        aoReference: profile.accounts_office_reference,
        employerPayeReference: profile.employer_paye_reference,
        utr: profile.contractor_utr,
        name: profile.legal_name,
      }
    : undefined;

  const composed = composeCis300Return({ dataset, contractor }, { allowInternalPrepare: true });
  if (!composed.ok) return { ok: false, error: composed.message };

  return insertSubmission(db, {
    orgId,
    preparedBy,
    kind: "cis300",
    periodKey,
    status,
    payload: composed.payload,
  });
}

/**
 * The UK tax-year START (6 April) that contains an ISO date. HMRC's tax year runs
 * 6 April → 5 April. A pure date boundary — not a tax calculation. Used to window
 * the year-to-date gather for an FPS.
 */
function taxYearStartForDate(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0 = Jan
  const day = d.getUTCDate();
  const startYear = m > 3 || (m === 3 && day >= 6) ? y : y - 1;
  return `${startYear}-04-06`;
}

/**
 * Prepare + HOLD an internal RTI Full Payment Submission (FPS) for a FINALISED
 * payroll run. Reads the org's own frozen `payroll_lines`, gathers each
 * employee's tax-year-to-date cumulatives, composes the FPS payload and freezes
 * it in hmrc_submissions (kind 'fps'). Idempotent per run. Nothing is transmitted
 * to HMRC; the "final submission" declaration is never asserted (the composer
 * leaves it false). RTI filing stays legally recognition-gated (see
 * lib/integrations/hmrc/rti-fps.ts and migration 20261156).
 *
 * ONLY A FINALISED RUN. A draft run's figures can still change; filing draft pay
 * would file figures that are not yet real, so a draft run is refused.
 */
export async function prepareFpsReturn(params: {
  orgId: string;
  preparedBy: string;
  payrollRunId: string;
  status?: HmrcSubmissionStatus;
}): Promise<PrepareSubmissionResult> {
  const { orgId, preparedBy, payrollRunId } = params;
  const status = params.status ?? "prepared";

  const db = await looseDb();

  // Load the run, ORG-PINNED + LOUD. current_org_ids() admits every org a
  // multi-org admin belongs to, so the pin is load-bearing: without it a run id
  // from another company could be filed under this org.
  const { data: runData, error: runErr } = await db
    .from("payroll_runs")
    .select("id, cycle, period_start, period_end, status")
    .eq("id", payrollRunId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (runErr) throw readFailure("hmrc fps prepare: run", runErr);
  const run = runData as unknown as {
    id: string;
    cycle: string;
    period_start: string;
    period_end: string;
    status: string;
  } | null;
  if (!run) return { ok: false, error: "No such payroll run for this org." };
  if (run.status !== "finalised") {
    return { ok: false, error: "Only a finalised payroll run can be prepared as an FPS." };
  }
  const cycle: "weekly" | "monthly" = run.cycle === "weekly" ? "weekly" : "monthly";

  // Period key is unique per run within the org (payroll_runs is UNIQUE on
  // (org_id, cycle, period_start, period_end)), so idempotency binds one FPS to
  // one run — a re-prepare returns the existing frozen record, never a duplicate.
  const periodKey = `${cycle}:${run.period_start}..${run.period_end}`;
  const existing = await findSubmission(db, orgId, "fps", periodKey);
  if (existing) return { ok: true, id: existing.id, created: false, status: existing.status };

  // YEAR-TO-DATE. An FPS carries each employee's cumulative tax-year figures to
  // the pay date. Gather every FINALISED run in this run's tax year up to and
  // INCLUDING it, then sum this run's own lines for the period figures and all
  // in-year lines for the YTD. PAGED (F-1) + LOUD: a truncated/errored read must
  // never freeze an understated FPS.
  const taxYearStart = taxYearStartForDate(run.period_end);

  const { data: yearRunRows, error: yearRunErr } = await fetchAllRows((from, to) =>
    db
      .from("payroll_runs")
      .select("id")
      .eq("org_id", orgId)
      .eq("status", "finalised")
      .gte("period_end", taxYearStart)
      .lte("period_end", run.period_end)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (yearRunErr) throw readFailure("hmrc fps prepare: year runs", yearRunErr);
  const yearRunIds = ((yearRunRows ?? []) as unknown as Array<{ id: string }>).map((r) => r.id);
  // The current run is finalised and inside the window, so it MUST be present.
  // If a read anomaly dropped it, fail closed rather than freeze an FPS missing
  // the very run it is for.
  if (!yearRunIds.includes(run.id)) {
    return { ok: false, error: "Could not resolve the payroll run's tax-year context." };
  }

  type LineRow = {
    payroll_run_id: string;
    user_id: string;
    hours: number | string | null;
    gross_pay: number | string | null;
    paye_estimate: number | string | null;
    ni_estimate: number | string | null;
    net_pay: number | string | null;
    user?: { full_name?: string | null } | null;
  };
  // Chunk the run-id list so a busy year's run set never overflows a single
  // `.in(...)`; each chunk is fully paged.
  const ID_CHUNK = 200;
  const allLines: LineRow[] = [];
  for (let i = 0; i < yearRunIds.length; i += ID_CHUNK) {
    const idsChunk = yearRunIds.slice(i, i + ID_CHUNK);
    const { data: lineRows, error: lineErr } = await fetchAllRows((from, to) =>
      db
        .from("payroll_lines")
        .select(
          "payroll_run_id, user_id, hours, gross_pay, paye_estimate, ni_estimate, net_pay, user:users ( full_name )",
        )
        .eq("org_id", orgId)
        .in("payroll_run_id", idsChunk)
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (lineErr) throw readFailure("hmrc fps prepare: payroll lines", lineErr);
    for (const r of (lineRows ?? []) as unknown as LineRow[]) allLines.push(r);
  }

  const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;

  // YTD cumulatives per user across the whole in-year set.
  const ytdByUser = new Map<string, FpsYearToDate>();
  for (const l of allLines) {
    const prev = ytdByUser.get(l.user_id) ?? { taxablePay: 0, taxDeducted: 0, employeeNic: 0 };
    ytdByUser.set(l.user_id, {
      taxablePay: prev.taxablePay + num(l.gross_pay),
      taxDeducted: prev.taxDeducted + num(l.paye_estimate),
      employeeNic: prev.employeeNic + num(l.ni_estimate),
    });
  }

  // This period's employees are the current run's own lines.
  const periodLines = allLines.filter((l) => l.payroll_run_id === run.id);
  if (periodLines.length === 0) {
    return { ok: false, error: "This payroll run has no lines to file." };
  }
  const employees: FpsInputEmployee[] = periodLines.map((l) => ({
    employeeId: l.user_id,
    name: l.user?.full_name ?? null,
    hoursWorked: num(l.hours),
    grossPay: num(l.gross_pay),
    payeDeducted: num(l.paye_estimate),
    employeeNic: num(l.ni_estimate),
    netPay: num(l.net_pay),
    yearToDate: ytdByUser.get(l.user_id),
  }));

  // Employer identity — the SAME PAYE / Accounts-Office references CIS uses.
  // Absent ⇒ nulls; never invented.
  const profile = await getContractorProfile(orgId);
  const employer = profile
    ? {
        employerPayeReference: profile.employer_paye_reference,
        accountsOfficeReference: profile.accounts_office_reference,
        name: profile.legal_name,
      }
    : undefined;

  const composed = composeFpsReturn(
    { payDate: run.period_end, paymentFrequency: cycle, employees, employer },
    { allowInternalPrepare: true },
  );
  if (!composed.ok) return { ok: false, error: composed.message };

  return insertSubmission(db, {
    orgId,
    preparedBy,
    kind: "fps",
    periodKey,
    status,
    payload: composed.payload,
  });
}
