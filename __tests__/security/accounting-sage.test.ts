import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAccountingAdapter,
  getAccountingImportAdapter,
  sageReady,
} from "@/lib/integrations/accounting/adapters";

/**
 * Sage accounting adapter (wave w6) — trust-boundary proofs.
 *
 * Sage Business Cloud Accounting is a THIRD bookkeeping adapter built on the SAME
 * two-switch dark gate (FEATURE_ACCOUNTING_CONNECT + SAGE_CLIENT_ID/SECRET) and
 * the SAME contract as Xero / QuickBooks. These proofs pin:
 *   1. the provider vocabulary migration ADMITS 'sage' in all three CHECKs, and
 *      widens ONLY (no RLS change, no write, no trigger, no token read);
 *   2. the adapter is DARK — unavailable + refuse-before-fetch, no SDK, no secret;
 *   3. it is registered as both a push and a pull adapter and reports readiness.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261186000000_accounting_sage_provider.sql";
const SAGE = "lib/integrations/accounting/adapters/sage.ts";
const OAUTH = "lib/integrations/accounting/oauth.ts";
const PAYLOADS = "lib/integrations/accounting/provider-payloads.ts";

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
// 1. THE PROVIDER-VOCABULARY MIGRATION — admits 'sage', widens only
// ---------------------------------------------------------------------------

describe("accounting_sage_provider migration admits 'sage' everywhere it must", () => {
  it("widens the accounting_connections.provider CHECK to include sage", () => {
    expect(sql).toMatch(
      /alter table public\.accounting_connections[\s\S]*add constraint accounting_connections_provider_check[\s\S]*check \(provider in \('xero', 'quickbooks', 'sage'\)\)/i,
    );
  });

  it("widens the accounting_pushed_entities.provider CHECK to include sage", () => {
    expect(sql).toMatch(
      /alter table public\.accounting_pushed_entities[\s\S]*add constraint accounting_pushed_entities_provider_check[\s\S]*check \(provider in \('xero', 'quickbooks', 'sage'\)\)/i,
    );
  });

  it("widens the accounting_export_log.format CHECK to include sage", () => {
    expect(sql).toMatch(
      /alter table public\.accounting_export_log[\s\S]*add constraint accounting_export_log_format_check[\s\S]*check \(format in \('csv', 'xero', 'quickbooks', 'sage'\)\)/i,
    );
  });

  it("is ADDITIVE ONLY — no RLS change, no write, no trigger, no token read", () => {
    // It only DROPs/ADDs the three named CHECKs; it must not touch policy, RLS,
    // rows, triggers, or the token columns.
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/insert\s+into/i);
    expect(sql).not.toMatch(/update\s+public\./i);
    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/access_token/i);
    // Drops are guarded IF EXISTS so a re-run is safe.
    expect(sql).toMatch(/drop constraint if exists accounting_connections_provider_check/i);
  });
});

// ---------------------------------------------------------------------------
// 2. THE SAGE ADAPTER IS DARK — unavailable + refuse-before-fetch, no leak
// ---------------------------------------------------------------------------

describe("Sage adapter is dark without credentials", () => {
  const original = { ...process.env };
  const DARK_PUSH = { rows: [] as never[], accessToken: "", tenantId: "B", refresh: async () => null };
  const clear = () => {
    for (const k of [
      "FEATURE_ACCOUNTING_CONNECT",
      "SAGE_CLIENT_ID",
      "SAGE_CLIENT_SECRET",
    ]) {
      delete process.env[k];
    }
  };

  it("reports unavailable when the two-switch gate is not satisfied", () => {
    clear();
    expect(getAccountingAdapter("sage").isAvailable()).toBe(false);
    expect(sageReady()).toBe(false);
    process.env = { ...original };
  });

  it("credentials WITHOUT the feature flag are still dark (two-switch)", () => {
    clear();
    process.env.SAGE_CLIENT_ID = "id";
    process.env.SAGE_CLIENT_SECRET = "secret";
    // FEATURE_ACCOUNTING_CONNECT deliberately left off.
    expect(getAccountingAdapter("sage").isAvailable()).toBe(false);
    process.env = { ...original };
  });

  it("push + pull return unavailable on the dark path (no network)", async () => {
    clear();
    const push = getAccountingAdapter("sage");
    const pull = getAccountingImportAdapter("sage");
    const inv = await push.pushInvoices(DARK_PUSH);
    const pay = await push.pushPayments(DARK_PUSH);
    const contacts = await pull.pullContacts({ accessToken: "", tenantId: "B", refresh: async () => null });
    const invoices = await pull.pullInvoices({ accessToken: "", tenantId: "B", refresh: async () => null });
    for (const r of [inv, pay, contacts, invoices]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unavailable");
    }
    process.env = { ...original };
  });

  it("REFUSE before fetch: every `fetch` lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(SAGE));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("constructs NO provider SDK client (only `fetch` is the network)", () => {
    const code = codeOf(read(SAGE));
    expect(code).not.toMatch(/\bnew\s+XMLHttpRequest\b/);
    expect(code).not.toMatch(/from\s+["']sage[-/]/);
    // The dark gate is the shared connect substrate, not a bespoke env read.
    expect(code).toMatch(/isProviderConnectable\(this\.provider\)/);
  });

  it("never logs a token or a client secret", () => {
    for (const f of [SAGE, OAUTH]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/access_?token/i);
        expect(call).not.toMatch(/refresh_?token/i);
        expect(call).not.toMatch(/client_?secret/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. CONTRACT PARITY — registered as push + pull, fail-loud tax mapping
// ---------------------------------------------------------------------------

describe("Sage adapter parity with Xero / QuickBooks", () => {
  it("is registered as BOTH the push and the pull adapter for 'sage'", () => {
    const push = getAccountingAdapter("sage");
    const pull = getAccountingImportAdapter("sage");
    expect(push.provider).toBe("sage");
    expect(pull.provider).toBe("sage");
    // Same instance satisfies both contracts (the shared two-switch gate idiom).
    expect(push).toBe(pull);
    // The push contract methods exist.
    expect(typeof push.pushInvoices).toBe("function");
    expect(typeof push.pushPayments).toBe("function");
    // The pull contract methods exist.
    expect(typeof pull.pullContacts).toBe("function");
    expect(typeof pull.pullInvoices).toBe("function");
  });

  it("the Sage tax mapper refuses an unknown rate (no silent exempt fallthrough)", () => {
    const code = codeOf(read(PAYLOADS));
    // sageSalesTaxRatePercentage validates via assertKnownVatRate rather than
    // returning a fallback rate — mirrors xeroSalesTaxType / qboSalesTaxCodeName.
    expect(code).toMatch(/export function sageSalesTaxRatePercentage/);
    const seg = code.slice(code.indexOf("export function sageSalesTaxRatePercentage"));
    expect(seg.slice(0, 300)).toMatch(/assertKnownVatRate/);
  });

  it("isolates a permanent per-row rejection instead of aborting the batch (shared predicate)", () => {
    const code = codeOf(read(SAGE));
    // Same C73-C posture as Xero / QBO: a permanent 4xx is a per-row skip.
    expect(code).toMatch(/isPermanentRowRejection\(/);
    expect(code).toMatch(/skipped\.push\(/);
    // And a per-invoice unmappable-VAT skip (C61) — never a whole-batch abort.
    expect(code).toMatch(/unmappableVatRate\(/);
  });
});
