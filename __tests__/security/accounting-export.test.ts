import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAccountingAdapter,
  getAccountingReadiness,
  accountingCsvReady,
  xeroReady,
  quickbooksReady,
  sageReady,
} from "@/lib/integrations/accounting/adapters";

/**
 * Accounting export (20261093) — trust-boundary proofs.
 *
 * Section 1: the ADAPTERS ARE DARK. With no OAuth credentials the Xero /
 * QuickBooks adapters report unavailable and push NOTHING — no client, no
 * network — and their source contains no `fetch` / provider SDK at all. A
 * credential alone cannot cause a live call, and the absence of one guarantees
 * the dark path.
 *
 * Section 2: the export-log RLS is DB-enforced admin-write / member-read,
 * org-pinned, append-only (no update/delete policy), and holds no money.
 *
 * Section 3: the service is org-pinned + loud (never a silent empty export).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261093000000_accounting_export_log.sql";
const CANONICAL = "lib/integrations/accounting/canonical.ts";
const CSV = "lib/integrations/accounting/csv.ts";
const XERO = "lib/integrations/accounting/adapters/xero.ts";
const QBO = "lib/integrations/accounting/adapters/quickbooks.ts";
const SAGE = "lib/integrations/accounting/adapters/sage.ts";
const SERVICE = "server/services/accounting-export.ts";
const CONNECTIONS_SERVICE = "server/services/accounting-connections.ts";
const ROUTE = "app/api/accounting/export/route.ts";
const ACTION = "app/(app)/reports/accounting/actions.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sql = sqlOnly(read(MIG));

// ---------------------------------------------------------------------------
// 1. THE ADAPTERS ARE DARK — nothing sent without credentials
// ---------------------------------------------------------------------------

describe("accounting adapters are dark without credentials", () => {
  const original = { ...process.env };
  const DARK_INPUT = {
    rows: [] as never[],
    accessToken: "",
    refresh: async () => null,
  };
  const clear = () => {
    for (const k of [
      "FEATURE_ACCOUNTING_CONNECT",
      "XERO_CLIENT_ID",
      "XERO_CLIENT_SECRET",
      "QBO_CLIENT_ID",
      "QBO_CLIENT_SECRET",
      "SAGE_CLIENT_ID",
      "SAGE_CLIENT_SECRET",
    ]) {
      delete process.env[k];
    }
  };

  it("report unavailable when the two-switch gate is not satisfied", () => {
    clear();
    expect(getAccountingAdapter("xero").isAvailable()).toBe(false);
    expect(getAccountingAdapter("quickbooks").isAvailable()).toBe(false);
    expect(getAccountingAdapter("sage").isAvailable()).toBe(false);
    process.env = { ...original };
  });

  it("credentials WITHOUT the feature flag are still dark (two-switch)", () => {
    clear();
    process.env.XERO_CLIENT_ID = "id";
    process.env.XERO_CLIENT_SECRET = "secret";
    // FEATURE_ACCOUNTING_CONNECT deliberately left off.
    expect(getAccountingAdapter("xero").isAvailable()).toBe(false);
    process.env = { ...original };
  });

  it("push NOTHING and return `unavailable` on the dark path", async () => {
    clear();
    for (const p of ["xero", "quickbooks", "sage"] as const) {
      const a = getAccountingAdapter(p);
      // If a `fetch` were reached it would throw in this test env; a clean
      // `unavailable` return proves the push never touched the network.
      const inv = await a.pushInvoices(DARK_INPUT);
      const pay = await a.pushPayments(DARK_INPUT);
      expect(inv.ok).toBe(false);
      expect(pay.ok).toBe(false);
      if (!inv.ok) expect(inv.reason).toBe("unavailable");
      if (!pay.ok) expect(pay.reason).toBe("unavailable");
    }
    process.env = { ...original };
  });

  it("construct NO provider SDK client (only `fetch` is the network)", () => {
    for (const f of [XERO, QBO, SAGE]) {
      const code = codeOf(read(f));
      expect(code).not.toMatch(/\bnew\s+XMLHttpRequest\b/);
      // No provider SDK import — the only network is the guarded `fetch`.
      expect(code).not.toMatch(/from\s+["']xero-node["']/);
      expect(code).not.toMatch(/from\s+["']node-quickbooks["']/);
      expect(code).not.toMatch(/from\s+["']intuit-oauth["']/);
    }
  });

  it("REFUSE before fetch: every `fetch` lives AFTER the isAvailable guard", () => {
    for (const f of [XERO, QBO, SAGE]) {
      const code = codeOf(read(f));
      const guardIdx = code.indexOf("if (!this.isAvailable())");
      const fetchIdx = code.indexOf("fetch(");
      expect(guardIdx).toBeGreaterThan(-1);
      expect(fetchIdx).toBeGreaterThan(-1);
      // The dark guard precedes any network call — refuse-before-fetch.
      expect(guardIdx).toBeLessThan(fetchIdx);
    }
  });
});

describe("accounting readiness — CSV live, providers dark", () => {
  it("CSV is always ready; providers are two-switch-gated (dark today)", () => {
    const original = { ...process.env };
    for (const k of [
      "FEATURE_ACCOUNTING_CONNECT",
      "XERO_CLIENT_ID",
      "XERO_CLIENT_SECRET",
      "QBO_CLIENT_ID",
      "QBO_CLIENT_SECRET",
      "SAGE_CLIENT_ID",
      "SAGE_CLIENT_SECRET",
    ]) {
      delete process.env[k];
    }
    expect(accountingCsvReady()).toBe(true);
    expect(xeroReady()).toBe(false);
    expect(quickbooksReady()).toBe(false);
    expect(sageReady()).toBe(false);
    expect(getAccountingReadiness()).toEqual({
      csv: true,
      xero: false,
      quickbooks: false,
      sage: false,
    });
    process.env = { ...original };
  });
});

// ---------------------------------------------------------------------------
// 2. THE EXPORT LOG — RLS, tenancy, append-only, no money
// ---------------------------------------------------------------------------

describe("accounting_export_log RLS + shape", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.accounting_export_log enable row level security/i,
    );
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert gated on is_org_admin()", () => {
    expect(sql).toMatch(
      /create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
  });

  it("is APPEND-ONLY: no update and no delete policy", () => {
    expect(sql).not.toMatch(/for\s+update/i);
    expect(sql).not.toMatch(/for\s+delete/i);
  });

  it("is org-pinned with a composite candidate key + cascade teardown", () => {
    expect(sql).toMatch(/org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i);
    expect(sql).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });

  it("holds NO money and posts NOWHERE (no amount column, no writes to ledgers)", () => {
    expect(sql).not.toMatch(/amount/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.finances/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.invoices/i);
    expect(sql).not.toMatch(/trigger/i);
  });

  it("constrains format and status to the documented vocabularies", () => {
    expect(sql).toMatch(/format\s+text not null check \(format in \('csv', 'xero', 'quickbooks'\)\)/i);
    expect(sql).toMatch(/status\s+text not null check \(status in \('generated', 'pushed', 'skipped_dark'\)\)/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE SERVICE / ROUTE / ACTION — org-pinned, loud, admin-gated, honest dark
// ---------------------------------------------------------------------------

describe("accounting export service + surfaces", () => {
  it("service pins org_id on both reads and reads loudly", () => {
    const code = codeOf(read(SERVICE));
    // Two .eq('org_id', orgId) pins (invoices + payments).
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
    // Loud: a failed read throws via readFailure, never a silent empty export.
    expect(code).toMatch(/readFailure\(/);
    expect(code).toMatch(/throw readFailure/);
  });

  it("the pure mapper never reads a clock (todayIso injected)", () => {
    const code = codeOf(read(CANONICAL));
    expect(code).not.toMatch(/Date\.now\(/);
    expect(code).not.toMatch(/new Date\(\)/);
  });

  it("CSV serialiser reuses the one authoritative escaper", () => {
    const code = codeOf(read(CSV));
    expect(code).toMatch(/from\s+["']@\/lib\/csv["']/);
    expect(code).toMatch(/csvEscape/);
  });

  it("route + action gate on owner/admin before exporting", () => {
    for (const f of [ROUTE, ACTION]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/role === "owner"/);
      expect(code).toMatch(/role === "admin"/);
    }
  });

  it("the provider-push action delegates to the ONE push composition (syncToProvider)", () => {
    const code = codeOf(read(ACTION));
    // The action no longer resolves the adapter itself; it hands off to the
    // connections service, which records skipped_dark on the dark path.
    expect(code).toMatch(/syncToProvider\(/);
    expect(code).toMatch(/skipped_dark/);
  });

  it("the connections service records skipped_dark and refuses before push when dark", () => {
    const code = codeOf(read(CONNECTIONS_SERVICE));
    expect(code).toMatch(/isAvailable\(\)/);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
    // The dark guard precedes the token read + adapter push.
    const guardIdx = code.indexOf("adapter.isAvailable()");
    const pushIdx = code.indexOf("adapter.pushInvoices(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(pushIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. P2 FIXES — draft invoices excluded + truncation is never silent
// ---------------------------------------------------------------------------

describe("accounting export P2 hardening", () => {
  it("the invoice read EXCLUDES draft invoices (a draft is not a real sale)", () => {
    const code = codeOf(read(SERVICE));
    // The draft filter is applied on the invoices read, not the payments read.
    expect(code).toMatch(/\.neq\(\s*["']status["']\s*,\s*["']draft["']\s*\)/);
  });

  it("both reads PAGE the full ledger (fetchAllRows) — no clamp-trapped .limit()", () => {
    // F-1: a single `.limit(MAX_ROWS + 1)` was silently clamped to the PostgREST
    // max_rows (1000), so the export dropped rows 1001+ and the `truncated`
    // probe was DEAD. The reads now page via fetchAllRows/.range with a unique
    // `id` tiebreak; truncation is derived from the TRUE paged count.
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/paginate["']/);
    expect(code).toMatch(/fetchAllRows</);
    expect(code).toMatch(/\.range\(/);
    // A unique tiebreak on the (created_at / paid_at) ordering.
    expect(code).toMatch(/\.order\(\s*["']id["']\s*,\s*\{\s*ascending:\s*true\s*\}\s*\)/);
    // The clamp trap must be gone entirely: NO `.limit()` on the export path.
    expect(code).not.toMatch(/\.limit\(/);
    // (The dedicated F-1 clamp-trap sweep lives in f1-pagination-guard.test.ts.)
  });

  it("a truncated read is reported LOUDLY and returned as a flag", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/reportReadFailure\(/);
    expect(code).toMatch(/truncated/);
    // The export result type carries the flag out to the surfaces.
    expect(code).toMatch(/truncated:\s*boolean/);
  });

  it("the route surfaces truncation on the response and in the audit note", () => {
    const code = codeOf(read(ROUTE));
    expect(code).toMatch(/X-Accounting-Export-Truncated/);
    expect(code).toMatch(/X-Accounting-Export-Row-Count/);
    // A truncated export records a note in the export log — not silent.
    expect(code).toMatch(/note/);
  });

  it("the export log has a nullable note column (the truncation record)", () => {
    expect(sql).toMatch(/\bnote\s+text\b/i);
    // Still no money and no trigger — the note is metadata, not a ledger write.
    expect(sql).not.toMatch(/amount/i);
    expect(sql).not.toMatch(/trigger/i);
  });
});

// ---------------------------------------------------------------------------
// 5. PER-LINE VAT — the provider push derives tax codes from the invoice's
//    per-line vat_rate, NEVER a blended header rate. The defect: the push read
//    only the header net / vat_total and collapsed every invoice to one line at
//    round(vat/net*100), so a mixed-rate invoice posted under a single wrong
//    (often EXEMPT) code, mis-stating the VAT return. This source contract stops
//    a refactor silently reverting to the header-only derivation.
// ---------------------------------------------------------------------------

describe("accounting push reads per-line VAT (invoice_line_items.vat_rate)", () => {
  it("the export service reads invoice_line_items' vat_rate on the push path (org-pinned, paged)", () => {
    const code = codeOf(read(SERVICE));
    // The push path reads the per-line snapshot for bucketing…
    expect(code).toMatch(/from\(\s*["']invoice_line_items["']\s*\)/);
    // …and specifically its per-line vat_rate + line_total (not just the header).
    expect(code).toMatch(/vat_rate/);
    expect(code).toMatch(/line_total/);
    // Fully paged, org-pinned — no clamp-trapped .limit for the line read either.
    expect(code).toMatch(/fetchAllRows</);
  });

  it("the canonical mapper buckets by vat_rate and reconciles to the header", () => {
    const code = codeOf(read(CANONICAL));
    // The per-rate bucketing helper exists and reconciles (throws) on a mismatch.
    expect(code).toMatch(/bucketInvoiceTaxLines/);
    expect(code).toMatch(/taxLines/);
    // FAIL LOUD: an unmappable rate is refused, not silently mapped to exempt.
    expect(code).toMatch(/UnknownVatRateError/);
  });

  it("the provider tax-code mappers refuse an unknown rate (no EXEMPT fallthrough)", () => {
    const code = codeOf(
      read("lib/integrations/accounting/provider-payloads.ts"),
    );
    // The mappers validate the rate rather than returning EXEMPTOUTPUT / 'Exempt (0%)'.
    expect(code).toMatch(/assertKnownVatRate/);
    // The old silent fallthroughs must be gone from executable code.
    expect(code).not.toMatch(/return\s+"EXEMPTOUTPUT"/);
    expect(code).not.toMatch(/return\s+"Exempt \(0%\)"/);
  });
});
