import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAccountingAdapter,
  getAccountingReadiness,
  accountingCsvReady,
  xeroReady,
  quickbooksReady,
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
const SERVICE = "server/services/accounting-export.ts";
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
  const clear = () => {
    for (const k of [
      "XERO_CLIENT_ID",
      "XERO_CLIENT_SECRET",
      "XERO_TENANT_ID",
      "QUICKBOOKS_CLIENT_ID",
      "QUICKBOOKS_CLIENT_SECRET",
      "QUICKBOOKS_REALM_ID",
    ]) {
      delete process.env[k];
    }
  };

  it("report unavailable when their credentials are absent", () => {
    clear();
    expect(getAccountingAdapter("xero").isAvailable()).toBe(false);
    expect(getAccountingAdapter("quickbooks").isAvailable()).toBe(false);
    process.env = { ...original };
  });

  it("push NOTHING and return `unavailable` on the dark path", async () => {
    clear();
    for (const p of ["xero", "quickbooks"] as const) {
      const a = getAccountingAdapter(p);
      const inv = await a.pushInvoices([]);
      const pay = await a.pushPayments([]);
      expect(inv.ok).toBe(false);
      expect(pay.ok).toBe(false);
      if (!inv.ok) expect(inv.reason).toBe("unavailable");
      if (!pay.ok) expect(pay.reason).toBe("unavailable");
    }
    process.env = { ...original };
  });

  it("make NO network call and construct NO client (no fetch / SDK in source)", () => {
    for (const f of [XERO, QBO]) {
      const code = codeOf(read(f));
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/\bnew\s+XMLHttpRequest\b/);
      expect(code).not.toMatch(/https?:\/\/[a-z]/i);
      // No provider SDK import.
      expect(code).not.toMatch(/from\s+["']xero-node["']/);
      expect(code).not.toMatch(/from\s+["']node-quickbooks["']/);
      expect(code).not.toMatch(/from\s+["']intuit-oauth["']/);
    }
  });

  it("gate the (unreachable) push body strictly AFTER the availability check", () => {
    for (const f of [XERO, QBO]) {
      const code = codeOf(read(f));
      // Every push method returns unavailable() when !isAvailable() before doing
      // anything else — the guard is the first statement.
      expect(code).toMatch(/if\s*\(\s*!this\.isAvailable\(\)\s*\)\s*return\s+unavailable/);
    }
  });
});

describe("accounting readiness — CSV live, providers dark", () => {
  it("CSV is always ready; providers are credential-gated (dark today)", () => {
    const original = { ...process.env };
    for (const k of [
      "XERO_CLIENT_ID",
      "XERO_CLIENT_SECRET",
      "XERO_TENANT_ID",
      "QUICKBOOKS_CLIENT_ID",
      "QUICKBOOKS_CLIENT_SECRET",
      "QUICKBOOKS_REALM_ID",
    ]) {
      delete process.env[k];
    }
    expect(accountingCsvReady()).toBe(true);
    expect(xeroReady()).toBe(false);
    expect(quickbooksReady()).toBe(false);
    expect(getAccountingReadiness()).toEqual({
      csv: true,
      xero: false,
      quickbooks: false,
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

  it("the provider-push action records skipped_dark when the adapter is dark", () => {
    const code = codeOf(read(ACTION));
    expect(code).toMatch(/isAvailable\(\)/);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
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

  it("both reads request one past the cap so truncation is detectable", () => {
    const code = codeOf(read(SERVICE));
    const probes = code.match(/\.limit\(\s*MAX_ROWS\s*\+\s*1\s*\)/g) ?? [];
    // Invoices + payments — both over-request by one to reveal the cap hit.
    expect(probes.length).toBeGreaterThanOrEqual(2);
    // The old silent `.limit(MAX_ROWS)` (no signal) must be gone.
    expect(code).not.toMatch(/\.limit\(\s*MAX_ROWS\s*\)/);
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
