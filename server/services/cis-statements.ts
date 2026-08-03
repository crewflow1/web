import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  assessStatementFreshness,
  buildMonthlyReturnDataset,
  summariseStatement,
  type CisPaymentSnapshotRow,
  type CisStatementStatus,
  type MonthlyReturnDataset,
  type StatementSummary,
} from "@/lib/cis/statements";
import type { ContractorIdentity } from "@/lib/cis/statements";
import type { CisContractorProfileInput } from "@/lib/cis/contractor";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";

/**
 * H2-CIS M4 service layer — statements and the monthly return DATASET.
 *
 * ── NOTHING IN THIS FILE TALKS TO HMRC ──────────────────────────────────────
 * There is no HTTP client here, no Government Gateway credential, no submission
 * endpoint. `markReturnExported` records that the OPERATOR downloaded figures
 * from CrewFlow; it makes no claim about filing and must never be presented as
 * if it did.
 *
 * Every call runs on the TENANT (user-JWT) client, so the admin-only RLS added
 * by 20261055000000 is the real boundary — a non-admin member reads nothing and
 * writes nothing even reaching this module directly. The service-role client is
 * deliberately never used: these rows carry the org's own PAYE reference and
 * subcontractors' masked UTRs, and there is no legitimate reason to bypass RLS.
 *
 * These tables post-date the generated types in lib/supabase/types.ts, so the
 * client is reached through the same structural cast the rest of the CIS domain
 * uses (server/services/cis.ts, suppliers, toolbox talks).
 */

export type StatementResult<T> = { ok: true; data: T } | { ok: false; error: string };

type Res<T> = { data: T | null; error: { message: string } | null };

interface Sel<T> extends PromiseLike<Res<T[]>> {
  eq(c: string, v: unknown): Sel<T>;
  in(c: string, v: unknown[]): Sel<T>;
  order(c: string, o?: { ascending?: boolean }): Sel<T>;
  limit(n: number): Sel<T>;
  range(from: number, to: number): Sel<T>;
  is(c: string, v: unknown): Sel<T>;
  maybeSingle(): PromiseLike<Res<T>>;
}
type Table = {
  select(cols: string): Sel<Record<string, unknown>>;
  upsert(row: Record<string, unknown>, o?: { onConflict?: string }): PromiseLike<Res<null>>;
};
type LooseClient = {
  from: (t: string) => unknown;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<Res<unknown>>;
};

async function client(): Promise<LooseClient> {
  return (await createClient()) as unknown as LooseClient;
}

const table = (c: LooseClient, name: string) => c.from(name) as Table;

/** PostgREST surfaces our RAISE messages; strip the SQL noise for the operator. */
function humanise(message: string): string {
  return message.replace(/^[A-Z0-9]{5}:\s*/, "").trim();
}

// ---------------------------------------------------------------------------
// Contractor profile
// ---------------------------------------------------------------------------

export type CisContractorProfile = {
  org_id: string;
  legal_name: string;
  employer_paye_reference: string;
  accounts_office_reference: string | null;
  contractor_utr: string | null;
};

export async function getContractorProfile(orgId: string): Promise<CisContractorProfile | null> {
  const c = await client();
  const { data, error } = await table(c, "cis_contractor_profiles")
    .select("org_id, legal_name, employer_paye_reference, accounts_office_reference, contractor_utr")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("cis: contractor profile", error);
  return (data as CisContractorProfile | null) ?? null;
}

export async function upsertContractorProfile(
  orgId: string,
  input: CisContractorProfileInput,
  userId: string,
): Promise<StatementResult<null>> {
  const c = await client();
  const { error } = await table(c, "cis_contractor_profiles").upsert(
    {
      org_id: orgId,
      legal_name: input.legal_name,
      employer_paye_reference: input.employer_paye_reference,
      accounts_office_reference: input.accounts_office_reference ?? null,
      contractor_utr: input.contractor_utr ?? null,
      updated_by: userId,
      created_by: userId,
    },
    { onConflict: "org_id" },
  );
  if (error) return { ok: false, error: humanise(error.message) };
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// The frozen ledger this milestone reads
// ---------------------------------------------------------------------------

const SNAPSHOT_COLUMNS =
  "payment_id, supplier_id, cis_status, deduction_rate, verification_reference, " +
  "legal_name, utr_masked, cis_gross_payment, materials_total, citb_total, " +
  "cis_basis, cis_deduction, tax_month_start, tax_month_end";

type RawSnapshot = Record<string, unknown> & { payment_id: string };

/**
 * Every LIVE CIS payment snapshot in one tax month, with its payment's date and
 * void state. Voided payments are dropped here rather than downstream so no
 * caller can accidentally include one — a voided payment is not part of any
 * statement or return.
 */
export async function listMonthSnapshots(
  orgId: string,
  taxMonthEnd: string,
  supplierId?: string,
): Promise<CisPaymentSnapshotRow[]> {
  const c = await client();
  // PAGED (F-1). A busy contractor's tax month can cross the 1000-row PostgREST
  // cap (many subcontractors × many payments). This set is SUMMED downstream
  // into every statement and monthly-return total, so a bare `.select()` would
  // silently truncate and under-report. Page under the cap on the unique
  // (org_id, payment_id) key. Loud fail: a failed read must never build a NIL
  // return — nil is a real, reportable state and cannot alias a query failure.
  const { data, error } = await fetchAllRows((from, to) => {
    let q = table(c, "cis_payment_snapshots")
      .select(SNAPSHOT_COLUMNS)
      .eq("org_id", orgId)
      .eq("tax_month_end", taxMonthEnd);
    if (supplierId) q = q.eq("supplier_id", supplierId);
    return q.order("payment_id", { ascending: true }).range(from, to);
  });
  if (error) throw readFailure("cis: month payment snapshots", error);
  const rows = (data ?? []) as RawSnapshot[];
  if (rows.length === 0) return [];

  // Loud fail: this join drives the voided-payment filter — on error it must
  // block, not fail open into including voided payments. CHUNKED (F-1): with the
  // snapshot read now fully paged, `rows` can exceed 1000, so the `.in(id, …)`
  // join would itself truncate at the cap and leave later snapshots with no
  // payment match (defaulting voided_at to null ⇒ a voided payment sneaks in).
  // Chunk the id list strictly below the cap so each `.in()` returns in full
  // (supplier_payments.id is unique, so a chunk of N ids yields ≤ N rows).
  const byId = new Map<string, { id: string; paid_at: string; voided_at: string | null }>();
  const JOIN_CHUNK = 500;
  const paymentIds = rows.map((r) => r.payment_id);
  for (let i = 0; i < paymentIds.length; i += JOIN_CHUNK) {
    const idsChunk = paymentIds.slice(i, i + JOIN_CHUNK);
    const { data: payments, error: paymentsError } = await table(c, "supplier_payments")
      .select("id, paid_at, voided_at")
      .eq("org_id", orgId)
      .in("id", idsChunk);
    if (paymentsError) throw readFailure("cis: snapshot payments join", paymentsError);
    for (const p of (payments ?? []) as Array<{
      id: string;
      paid_at: string;
      voided_at: string | null;
    }>) {
      byId.set(p.id, p);
    }
  }

  return rows
    .map((r) => {
      const p = byId.get(r.payment_id);
      return {
        ...(r as unknown as CisPaymentSnapshotRow),
        paid_at: p?.paid_at ?? "",
        voided_at: p?.voided_at ?? null,
      };
    })
    .filter((r) => r.voided_at == null);
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type CisStatementRow = {
  id: string;
  org_id: string;
  supplier_id: string;
  statement_number: string;
  tax_month_start: string;
  tax_month_end: string;
  statement_due_on: string;
  contractor_name: string;
  contractor_paye_reference: string;
  subcontractor_name: string;
  subcontractor_utr_masked: string | null;
  verification_number: string | null;
  verification_number_required: boolean;
  gross_amount: string | number;
  materials_amount: string | number;
  deduction_amount: string | number;
  payment_count: number;
  rate_is_uniform: boolean;
  deduction_rate: string | number | null;
  cis_status: string | null;
  is_statutory: boolean;
  content_hash: string;
  ledger_fingerprint: string;
  status: CisStatementStatus;
  issued_on: string;
  issued_at: string;
  supersedes_id: string | null;
  withdraw_reason: string | null;
};

const STATEMENT_COLUMNS =
  "id, org_id, supplier_id, statement_number, tax_month_start, tax_month_end, " +
  "statement_due_on, contractor_name, contractor_paye_reference, subcontractor_name, " +
  "subcontractor_utr_masked, verification_number, verification_number_required, " +
  "gross_amount, materials_amount, deduction_amount, payment_count, rate_is_uniform, " +
  "deduction_rate, cis_status, is_statutory, content_hash, ledger_fingerprint, status, " +
  "issued_on, issued_at, supersedes_id, withdraw_reason";

export async function listStatements(
  orgId: string,
  opts: { taxMonthEnd?: string; supplierId?: string } = {},
): Promise<CisStatementRow[]> {
  const c = await client();
  // PAGED (F-1). An org accrues one statement per subcontractor per tax month,
  // so this org-scoped list grows without bound and a bare `.select()` would
  // silently truncate at the 1000-row cap — dropping older statements and the
  // downstream email queue's view of them. Keep the display order (month desc,
  // number) and add the unique `id` tiebreak so pages can't drop/repeat a row.
  const { data, error } = await fetchAllRows((from, to) => {
    let q = table(c, "cis_statements").select(STATEMENT_COLUMNS).eq("org_id", orgId);
    if (opts.taxMonthEnd) q = q.eq("tax_month_end", opts.taxMonthEnd);
    if (opts.supplierId) q = q.eq("supplier_id", opts.supplierId);
    return q
      .order("tax_month_end", { ascending: false })
      .order("statement_number")
      .order("id", { ascending: true })
      .range(from, to);
  });
  if (error) throw readFailure("cis: statements list", error);
  return (data ?? []) as unknown as CisStatementRow[];
}

export async function getStatement(
  orgId: string,
  statementId: string,
): Promise<CisStatementRow | null> {
  const c = await client();
  const { data, error } = await table(c, "cis_statements")
    .select(STATEMENT_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", statementId)
    .maybeSingle();
  if (error) throw readFailure("cis: statement", error);
  return (data as unknown as CisStatementRow | null) ?? null;
}

/**
 * The payments a statement covered, as frozen at issue. This is the provenance
 * record — it is what makes "these totals ARE the ledger" checkable rather than
 * asserted, and it survives a later void of any of those payments.
 */
export async function listStatementPayments(orgId: string, statementId: string) {
  const c = await client();
  const { data, error } = await table(c, "cis_statement_payments")
    .select(
      "payment_id, paid_on, cis_gross_payment, materials_total, cis_deduction, deduction_rate, cis_status",
    )
    .eq("org_id", orgId)
    .eq("statement_id", statementId)
    .order("paid_on");
  if (error) throw readFailure("cis: statement payments", error);
  return (data ?? []) as Array<{
    payment_id: string;
    paid_on: string;
    cis_gross_payment: string | number;
    materials_total: string | number;
    cis_deduction: string | number;
    deduction_rate: string | number;
    cis_status: string;
  }>;
}

/**
 * Ask the DATABASE for the current fingerprint of the ledger behind a statement.
 *
 * Deliberately not recomputed in TypeScript. One algorithm, in one place
 * (`public.cis_statement_ledger_fingerprint`), is what makes "issued value ==
 * current value" mean "the ledger has not moved" rather than "two
 * implementations happen to agree today".
 */
export async function currentLedgerFingerprint(
  orgId: string,
  supplierId: string,
  taxMonthEnd: string,
): Promise<string | null> {
  const c = await client();
  const { data, error } = await c.rpc("cis_statement_ledger_fingerprint", {
    p_org_id: orgId,
    p_supplier_id: supplierId,
    p_tax_month_end: taxMonthEnd,
  });
  if (error) return null;
  return typeof data === "string" ? data : null;
}

/** Is this issued statement still consistent with the ledger? */
export async function statementFreshness(statement: CisStatementRow) {
  const current = await currentLedgerFingerprint(
    statement.org_id,
    statement.supplier_id,
    statement.tax_month_end,
  );
  if (current === null) return { fresh: true as const, reason: null };
  return assessStatementFreshness({
    storedFingerprint: statement.ledger_fingerprint,
    currentFingerprint: current,
    status: statement.status,
  });
}

/**
 * What a statement WOULD say if issued now, computed from the live ledger.
 * Used for the preview and for the "issue" affordance; the database recomputes
 * everything independently when the statement is actually issued.
 */
export async function previewStatement(
  orgId: string,
  supplierId: string,
  taxMonthEnd: string,
): Promise<StatementSummary | null> {
  const rows = await listMonthSnapshots(orgId, taxMonthEnd, supplierId);
  return summariseStatement(rows, { taxMonthEnd });
}

export async function issueStatement(
  orgId: string,
  supplierId: string,
  taxMonthEnd: string,
): Promise<StatementResult<string>> {
  const c = await client();
  const { data, error } = await c.rpc("issue_cis_statement", {
    p_org_id: orgId,
    p_supplier_id: supplierId,
    p_tax_month_end: taxMonthEnd,
  });
  if (error) return { ok: false, error: humanise(error.message) };
  return { ok: true, data: String(data) };
}

export async function withdrawStatement(
  orgId: string,
  statementId: string,
  reason: string,
): Promise<StatementResult<null>> {
  const c = await client();
  const { error } = await c.rpc("withdraw_cis_statement", {
    p_org_id: orgId,
    p_statement_id: statementId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: humanise(error.message) };
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// The monthly return dataset
// ---------------------------------------------------------------------------

export type CisMonthlyReturnRow = {
  id: string;
  org_id: string;
  tax_month_start: string;
  tax_month_end: string;
  return_due_on: string;
  contractor_name: string;
  contractor_paye_reference: string;
  accounts_office_reference: string | null;
  is_nil: boolean;
  subcontractor_count: number;
  payment_count: number;
  total_gross: string | number;
  total_materials: string | number;
  total_deduction: string | number;
  status: "prepared" | "exported";
  ledger_fingerprint: string;
  content_hash: string;
  prepared_at: string;
  exported_at: string | null;
  superseded_at: string | null;
};

const RETURN_COLUMNS =
  "id, org_id, tax_month_start, tax_month_end, return_due_on, contractor_name, " +
  "contractor_paye_reference, accounts_office_reference, is_nil, subcontractor_count, " +
  "payment_count, total_gross, total_materials, total_deduction, status, " +
  "ledger_fingerprint, content_hash, prepared_at, exported_at, superseded_at";

/** The CURRENT (non-superseded) prepared return for a tax month, if any. */
export async function getPreparedReturn(
  orgId: string,
  taxMonthEnd: string,
): Promise<CisMonthlyReturnRow | null> {
  const c = await client();
  const { data, error } = await table(c, "cis_monthly_returns")
    .select(RETURN_COLUMNS)
    .eq("org_id", orgId)
    .eq("tax_month_end", taxMonthEnd)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw readFailure("cis: prepared return", error);
  return (data as unknown as CisMonthlyReturnRow | null) ?? null;
}

/**
 * Is a prepared return still consistent with the ledger?
 *
 * Asks the DATABASE for the current fingerprint rather than recomputing it here,
 * for the same reason as the statement check: one algorithm means a difference
 * proves the ledger moved, instead of merely proving two implementations
 * disagree. A voided payment, a new payment or a corrected one all show up.
 */
export async function preparedReturnIsStale(row: CisMonthlyReturnRow): Promise<boolean> {
  const c = await client();
  const { data, error } = await c.rpc("cis_monthly_return_ledger_fingerprint", {
    p_org_id: row.org_id,
    p_tax_month_end: row.tax_month_end,
  });
  if (error || typeof data !== "string") return false;
  return data !== row.ledger_fingerprint;
}

/** A single monthly return by id, org-scoped. The export route's read. */
export async function getReturnById(
  orgId: string,
  returnId: string,
): Promise<CisMonthlyReturnRow | null> {
  const c = await client();
  const { data, error } = await table(c, "cis_monthly_returns")
    .select(RETURN_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", returnId)
    .maybeSingle();
  if (error) throw readFailure("cis: monthly return by id", error);
  return (data as unknown as CisMonthlyReturnRow | null) ?? null;
}

export async function listPreparedReturns(orgId: string): Promise<CisMonthlyReturnRow[]> {
  const c = await client();
  const { data, error } = await table(c, "cis_monthly_returns")
    .select(RETURN_COLUMNS)
    .eq("org_id", orgId)
    .is("superseded_at", null)
    .order("tax_month_end", { ascending: false })
    .limit(24);
  if (error) throw readFailure("cis: prepared returns list", error);
  return (data ?? []) as unknown as CisMonthlyReturnRow[];
}

export async function listReturnLines(orgId: string, returnId: string) {
  const c = await client();
  // PAGED (F-1). A single monthly return has one line per subcontractor, which a
  // large contractor can push past the 1000-row cap; these lines ARE the return
  // body, so a truncated read would file/export an incomplete return. Page on a
  // unique total order — supplier_id is unique per return (one line per sub),
  // with `id` as an explicit tiebreak.
  const { data, error } = await fetchAllRows((from, to) =>
    table(c, "cis_monthly_return_lines")
      .select(
        "supplier_id, subcontractor_name, subcontractor_utr_masked, verification_number, " +
          "verification_number_required, rate_is_uniform, deduction_rate, cis_status, " +
          "gross_amount, materials_amount, deduction_amount, payment_count",
      )
      .eq("org_id", orgId)
      .eq("return_id", returnId)
      .order("supplier_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("cis: return lines", error);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/**
 * The LIVE dataset for a tax month, straight from the ledger — what a return
 * prepared right now would contain. Shown alongside any already-prepared return
 * so a divergence is visible rather than inferred.
 *
 * Returns a nil dataset for a month with no payments. That is a real, reportable
 * state, not an empty result.
 */
export async function liveReturnDataset(
  orgId: string,
  taxMonthEnd: string,
): Promise<MonthlyReturnDataset> {
  const rows = await listMonthSnapshots(orgId, taxMonthEnd);
  return buildMonthlyReturnDataset(rows, taxMonthEnd);
}

export async function prepareReturn(
  orgId: string,
  taxMonthEnd: string,
): Promise<StatementResult<string>> {
  const c = await client();
  const { data, error } = await c.rpc("prepare_cis_monthly_return", {
    p_org_id: orgId,
    p_tax_month_end: taxMonthEnd,
  });
  if (error) return { ok: false, error: humanise(error.message) };
  return { ok: true, data: String(data) };
}

/**
 * Record that the operator downloaded the figures.
 *
 * NAMED FOR WHAT IT IS. This function does not file, transmit, submit or
 * acknowledge anything to HMRC — CrewFlow has no such capability. If a future
 * milestone adds real filing, it must add its own state and its own evidence,
 * and must not repurpose this one.
 */
export async function markReturnExported(
  orgId: string,
  returnId: string,
): Promise<StatementResult<null>> {
  const c = await client();
  const { error } = await c.rpc("mark_cis_monthly_return_exported", {
    p_org_id: orgId,
    p_return_id: returnId,
  });
  if (error) return { ok: false, error: humanise(error.message) };
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// Month helpers for the operator surfaces
// ---------------------------------------------------------------------------

/** The tax month containing today, plus the previous `count - 1` months. */
export function recentTaxMonthEnds(todayIso: string, count = 13): string[] {
  const current = cisTaxMonthEnd(todayIso);
  if (!current) return [];
  const out: string[] = [];
  const [y, m, d] = current.split("-").map(Number) as [number, number, number];
  for (let i = 0; i < count; i++) {
    const dt = new Date(Date.UTC(y, m - 1 - i, d));
    out.push(
      `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
        dt.getUTCDate(),
      ).padStart(2, "0")}`,
    );
  }
  return out;
}

export type { ContractorIdentity };
