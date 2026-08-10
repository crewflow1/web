import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * H2-CASH M4 — trust-boundary pins for the money-OUT side of /cash.
 *
 * Hermetic: source contracts, no database. The live-Postgres dual-org proof is
 * __tests__/integration/billing/org-cash-out-isolation.test.ts.
 *
 * FIVE invariants, and every one of them has already been a real defect class in
 * this codebase:
 *
 *  1. NO SECOND MONEY ENGINE. Every figure must come from an existing authority.
 *     A re-implemented VAT rate, CIS rate or settlement formula is how two
 *     answers to the same tax question come into existence — the exact thing
 *     lib/cis/statements.ts' header forbids for M4 and the reason
 *     `computeVatQuarter` has a "leave it alone" pin of its own in
 *     __tests__/security/cis-deduction.test.ts.
 *
 *  2. NO WRITES. This is a read/compose surface. A `finances` posting from a
 *     cash-visibility feature would put the reporting layer inside the ledger.
 *
 *  3. ACTIVE-ORG PINNED. `current_org_ids()` admits EVERY org the viewer belongs
 *     to (#456 and the six slices after it), so on a money page an RLS-only read
 *     BLENDS two companies' payables, VAT and CIS into one position.
 *
 *  4. PAGED WITH A UNIQUE TOTAL ORDER. The F-1 class: a bare `.select()` is
 *     silently truncated at 1000 rows, and a non-unique sort key drops rows at a
 *     page edge. Here that means an UNDERSTATED liability, reported confidently.
 *
 *  5. LOUD READS (#480). A failed read must never render as "£0 owed".
 */

const LIB = "lib/commercial/cash-out.ts";
const SERVICE = "server/services/org-cash-out.ts";
const PAGE = "app/(app)/cash/page.tsx";

/** Strip comments so negative assertions test EXECUTABLE code, not prose. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const libSrc = read(LIB);
const serviceSrc = read(SERVICE);
const pageSrc = read(PAGE);
const libCode = codeOf(libSrc);
const serviceCode = codeOf(serviceSrc);
const pageCode = codeOf(pageSrc);

// ---------------------------------------------------------------------------
// 1. No second money engine — every figure comes from an existing authority
// ---------------------------------------------------------------------------

describe("money-out composes the existing authorities and adds no new money maths", () => {
  it("imports each authority rather than restating it", () => {
    const required: Array<[RegExp, string]> = [
      [/import \{[\s\S]*?computeBillSettlements[\s\S]*?\} from "@\/lib\/suppliers\/payments"/, "supplier settlement"],
      // computeVatQuarter is the VAT authority; endOfQuarterExclusiveIso is the
      // quarter-boundary helper from that SAME module, imported so /cash bounds
      // its window exactly as the tile/PDF/HMRC do. Both must come from here.
      [/import \{[\s\S]*?computeVatQuarter[\s\S]*?\} from "@\/lib\/tax\/compute"/, "VAT quarter"],
      [/import \{ buildMonthlyReturnDataset[\s\S]*?\} from "@\/lib\/cis\/statements"/, "CIS monthly totals"],
      [/import \{ cisPaymentDueDate[\s\S]*?\} from "@\/lib\/cis\/tax-month"/, "CIS payment deadline"],
      [/import \{ computeCommittedCosts[\s\S]*?\} from "@\/lib\/purchase-orders\/committed"/, "committed costs"],
      [/import \{ computePoBilling \} from "@\/lib\/purchase-orders\/billing"/, "PO vs bills"],
    ];
    for (const [re, label] of required) {
      expect(libSrc, `${LIB} must import the ${label} authority`).toMatch(re);
    }
  });

  it("declares no VAT arithmetic of its own", () => {
    // A VAT rate, a /100 apportionment or an output-minus-input subtraction here
    // would be a second VAT engine. `computeVatQuarter` owns all three.
    expect(libCode).not.toMatch(/vat_rate/);
    expect(libCode).not.toMatch(/output_vat\s*[-+]/);
    expect(libCode).not.toMatch(/\b(?:0\.2|0\.05|\b20\b\s*\/\s*100)\b/);
    expect(libCode, "no rate-times-base arithmetic").not.toMatch(/\*\s*\(?\s*\w*[Rr]ate\w*\s*\/\s*100/);
    for (const [src, name] of [
      [libCode, LIB],
      [serviceCode, SERVICE],
      [pageCode, PAGE],
    ] as const) {
      expect(src, `${name} must not redefine computeVatQuarter`).not.toMatch(/function\s+computeVatQuarter/);
    }
  });

  it("declares no CIS deduction arithmetic of its own", () => {
    // M4's rule, restated: this module SUMS frozen figures. No rate, no basis, no
    // materials apportionment — those belong to lib/cis/deduction.ts.
    for (const [src, name] of [
      [libCode, LIB],
      [serviceCode, SERVICE],
      [pageCode, PAGE],
    ] as const) {
      expect(src, `${name} must not compute a CIS basis`).not.toMatch(/cis_basis\s*[*/]/);
      expect(src, `${name} must not apply a deduction rate`).not.toMatch(/deduction_rate\s*[*/]/);
      expect(src, `${name} must not re-derive a deduction`).not.toMatch(
        /function\s+(computeAllocationDeduction|computeBillBasis|previewCisPayment)/,
      );
      expect(src, `${name} must not reach for the raw materials figure`).not.toMatch(
        /materials_total\s*[-+*/]/,
      );
    }
  });

  it("declares no settlement arithmetic of its own", () => {
    // `outstanding = gross − settled`, `gross = amount + vat_total` and the
    // live-allocation filter all live in lib/suppliers/payments.ts.
    expect(libCode, "bill gross must come from the authority").not.toMatch(
      /amount\s*\)?\s*\+\s*[\w.]*vat_total/,
    );
    expect(libCode, "no hand-rolled void filter").not.toMatch(/voided_at\s*==?=?\s*null/);
    expect(libCode).not.toMatch(/function\s+(billGross|computeBillSettlement|liveAllocations)/);
    expect(libCode, "the tolerance belongs to the money-in/money-out shared constant").not.toMatch(
      /0\.005/,
    );
  });

  it("the ONE arithmetic operation it owns is the position itself", () => {
    // The deliverable IS a subtraction. It appears exactly once, inside
    // computeCashPosition, and nowhere else composes its own net figure.
    const posFn = libSrc.slice(libSrc.indexOf("export function computeCashPosition"));
    expect(posFn).toMatch(/net: round2\(collectableNow - outflowDueNow\)/);
    const netSubtractions = libCode.match(/collectableNow\s*-\s*outflowDueNow/g) ?? [];
    expect(netSubtractions.length, "the position is defined once").toBe(1);
    // The page must consume it, not restate it.
    expect(pageCode).toMatch(/computeCashPosition\(\{/);
    expect(pageCode, "the page must not compute its own net").not.toMatch(
      /collectableNow\s*-\s*[\w.]*outflow/,
    );
  });

  it("payroll is SUMMED, never recomputed — no PAYE/NI engine on this surface", () => {
    for (const [src, name] of [
      [libCode, LIB],
      [serviceCode, SERVICE],
      [pageCode, PAGE],
    ] as const) {
      expect(src, `${name} must not re-derive payroll`).not.toMatch(
        /computePayrollLine|annualIncomeTax|annualEmployeeNi|PERSONAL_ALLOWANCE/,
      );
      expect(src, `${name} must not derive net pay from gross`).not.toMatch(
        /gross_pay\s*-\s*/,
      );
    }
    expect(libCode, "net_pay is a stored column, summed").toMatch(
      /sumMoney\(draftLines\.map\(\(l\) => l\.net_pay\)\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Non-overlapping definitions — the precedence is enforced, not just claimed
// ---------------------------------------------------------------------------

describe("nothing is counted twice, and the precedence is stated where it is enforced", () => {
  it("the module header names the precedence decision explicitly", () => {
    // The doctrine has to be findable by the next engineer, not inferred from
    // the code — the same reason lib/commercial/cash-forecast.ts spells out its
    // VAT axis and its "retention is deliberately NOT netted here" rule.
    expect(libSrc).toMatch(/A SUPPLIER BILL BEATS A PURCHASE ORDER/);
    expect(libSrc).toMatch(/CIS WITHHELD AND UNPAID BILLS ARE ALREADY DISJOINT/);
    expect(libSrc).toMatch(/VAT IS AN OFFSET, NOT AN OVERLAP/);
    expect(libSrc).toMatch(/PAYROLL IS NET PAY ONLY, AND THAT IS THE CORRECT CASH FIGURE/);
  });

  it("states WHY employer costs are excluded, so the rule survives the next reader", () => {
    // Net pay is the correct cash figure. Employer NI and PAYE/NI reach HMRC by
    // the 22nd of the following month and pension goes on its own date, so they
    // are an accrual on a different clock. The payroll lane's own
    // `payrollDueThisWeek` is net-pay-only for the same reason — if a future
    // change folds employment cost into either surface, the two definitions of
    // "payroll due" drift apart and one of them starts lying about cash.
    expect(libSrc).toMatch(/accrual on a\s*\n?\s*\*?\s*different clock/);
    expect(libSrc).toMatch(/payrollDueThisWeek/);
    expect(libCode, "the outflow must sum net_pay, never gross_pay").not.toMatch(/gross_pay/);
  });

  it("committed spend is the PO remainder after bills, never the raw PO total", () => {
    const fn = libSrc.slice(
      libSrc.indexOf("export function computeOrgCashOut"),
      libSrc.indexOf("export interface OrgCashPosition"),
    );
    // The PO-vs-bills authority is applied per PO...
    expect(fn).toMatch(/computePoBilling\(\{ poTotal: po\.total, bills: billsByPo\.get\(po\.id\) \?\? \[\] \}\)/);
    // ...and the committed figure is built from its `remaining`, floored.
    expect(fn).toMatch(/Math\.max\(0, billing\.remaining\)/);
    expect(fn).toMatch(/committedNotBilled = round2\(committedNotBilled \+ left\)/);
    // The raw committed total must never become the cash-out figure.
    expect(fn, "committedNotBilled must not be assigned the gross commitment").not.toMatch(
      /committedNotBilled\s*=\s*committed\.committed/,
    );
  });

  it("only rows flagged inPosition can enter the outflow total", () => {
    const fn = libSrc.slice(libSrc.indexOf("const outflowDueNow = round2("));
    expect(fn).toMatch(
      /const outflowDueNow = round2\(unpaidBills \+ cis\.dueNow \+ vatDue \+ payrollDraft\)/,
    );
    // Committed spend and past-deadline CIS are the two rows outside it; adding
    // either would double-count (an order already billed) or claim a debt
    // CrewFlow cannot verify.
    expect(fn, "committed spend must stay out of the position").not.toMatch(
      /outflowDueNow = round2\([^)]*committedNotBilled/,
    );
    expect(fn, "untracked CIS must stay out of the position").not.toMatch(
      /outflowDueNow = round2\([^)]*pastDeadline/,
    );
  });

  it("only supplier bills are payables — a supplier-less finances row is excluded", () => {
    // `supplier_payment_allocations`' composite FK refuses a supplier-less
    // finances row, so such a row could never be settled and would sit in
    // payables forever. The filter lives in the service and is documented there.
    expect(serviceCode).toMatch(/\.filter\(\(f\) => f\.supplier_id != null\)/);
    expect(libSrc).toMatch(/MUST already be filtered to supplier bills/);
  });
});

// ---------------------------------------------------------------------------
// 3. NO WRITES — a read/compose surface, structurally
// ---------------------------------------------------------------------------

describe("money-out never writes", () => {
  it("the service performs no mutation of any kind", () => {
    for (const verb of [
      /\.insert\(/,
      /\.update\(/,
      /\.upsert\(/,
      /\.delete\(/,
      /\.rpc\(/,
    ]) {
      expect(serviceCode, `${SERVICE} must not call ${verb}`).not.toMatch(verb);
    }
  });

  it("the read-only client TYPE cannot express a write", () => {
    // Structural, not just conventional: adding a write means widening the type,
    // which this assertion then fails. Mirrors OperationsClient.
    const decl = serviceSrc.slice(
      serviceSrc.indexOf("export type CashOutClient"),
      serviceSrc.indexOf("export const CIS_LOOKBACK_TAX_MONTHS"),
    );
    for (const verb of ["insert", "update", "upsert", "delete", "rpc"]) {
      expect(decl, `CashOutBuilder must not expose ${verb}`).not.toMatch(new RegExp(`\\b${verb}\\s*:`));
    }
    expect(decl).toMatch(/select:/);
    expect(decl).toMatch(/eq:/);
  });

  it("posts nothing to finances — the reporting layer stays outside the ledger", () => {
    for (const [src, name] of [
      [serviceCode, SERVICE],
      [pageCode, PAGE],
      [libCode, LIB],
    ] as const) {
      expect(src, `${name} must not write finances`).not.toMatch(/from\("finances"\)[\s\S]{0,80}?\.(insert|update|upsert|delete)/);
    }
  });

  it("runs on the TENANT client only — never service_role", () => {
    // Payables, CIS liabilities and payroll are the most sensitive money in the
    // product and every table involved is admin-only at the database. There is no
    // legitimate reason for a read-only visibility surface to bypass RLS, and the
    // service-role key would do exactly that (the same posture
    // server/services/cis.ts takes for UTRs).
    expect(serviceCode).not.toMatch(/SERVICE_ROLE|serviceClient|createServiceClient|service_role/);
    expect(serviceCode).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server"/);
  });

  it("the pure lib touches no I/O at all", () => {
    expect(libCode).not.toMatch(/server-only/);
    expect(libCode).not.toMatch(/createClient/);
    expect(libCode).not.toMatch(/from\("/);
    expect(libCode).not.toMatch(/\bfetch\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. Active-org pinned on EVERY read
// ---------------------------------------------------------------------------

describe("every money-out read is pinned to the active org", () => {
  it("the single paging chokepoint applies the org predicate", () => {
    const fn = serviceSrc.slice(serviceSrc.indexOf("async function paged("), serviceSrc.indexOf("export function cisSnapshotFloor"));
    expect(fn).toMatch(/\.select\(cols\)\.eq\("org_id", orgId\)/);
  });

  it("no read bypasses the chokepoint", () => {
    // Every `.from(` in the file must be the one inside `paged`. A second
    // `db.from(...)` elsewhere would be an unpinned read.
    const froms = serviceCode.match(/\.from\(/g) ?? [];
    expect(froms.length, "exactly one .from( call, inside paged()").toBe(1);
  });

  it("every table the money-out side needs is read through it, and pinned", () => {
    for (const table of [
      "finances",
      "supplier_payments",
      "supplier_payment_allocations",
      "purchase_orders",
      "payroll_runs",
      "payroll_lines",
      "cis_payment_snapshots",
      "invoices",
      "suppliers",
    ]) {
      expect(serviceCode, `${table} must be read via paged(...)`).toMatch(
        new RegExp(`paged\\(\\s*\\n?\\s*db,\\s*\\n?\\s*"${table}"`),
      );
    }
  });

  it("the page passes the ACTIVE org, never a client-supplied one", () => {
    expect(pageCode).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(pageCode).toMatch(/buildOrgCashOut\(ctx\.org\.id\)/);
    expect(pageCode, "no org id may arrive from searchParams/props").not.toMatch(
      /buildOrgCashOut\((?!ctx\.org\.id)/,
    );
  });

  it("takes the client as an argument so the integration tier can drive it with a real JWT", () => {
    expect(serviceSrc).toMatch(/export async function gatherCashOutFacts\(\s*\n?\s*db: CashOutClient/);
  });
});

// ---------------------------------------------------------------------------
// 5. Paged, with a unique total order
// ---------------------------------------------------------------------------

describe("money-out reads are paged with a unique total order", () => {
  it("pages through fetchAllRows rather than a bare select", () => {
    expect(serviceSrc).toMatch(/import \{ fetchAllRows/);
    expect(serviceCode).toMatch(/fetchAllRows<Row>\(/);
    expect(serviceCode).toMatch(/\.range\(from, to\)/);
  });

  it("orders by the primary key for every table that has a single-column one", () => {
    // `id` is unique within the org, so no page-edge row can be dropped or
    // repeated (the F-1 class). Understating a liability is the failure mode.
    for (const table of [
      "finances",
      "supplier_payments",
      "supplier_payment_allocations",
      "purchase_orders",
      "payroll_runs",
      "payroll_lines",
      "invoices",
      "suppliers",
    ]) {
      expect(serviceCode, `${table} must order by id`).toMatch(
        new RegExp(`paged\\(db, "${table}", \\w+, orgId, "id"`),
      );
    }
  });

  it("cis_payment_snapshots orders by payment_id — it has a COMPOSITE key and no id", () => {
    // (org_id, payment_id) is the primary key (20261051000000), so within the
    // pinned org `payment_id` IS the unique total order. Ordering by
    // `tax_month_end` (the tempting choice) would be non-unique.
    expect(serviceCode).toMatch(/"cis_payment_snapshots",\s*\n?\s*SNAPSHOT_COLS,\s*\n?\s*orgId,\s*\n?\s*"payment_id"/);
    expect(serviceCode).not.toMatch(/"cis_payment_snapshots"[\s\S]{0,120}orgId,\s*\n?\s*"tax_month_end"/);
  });

  it("the CIS read is BOUNDED, and the bound is surfaced to the reader", () => {
    expect(serviceCode).toMatch(/CIS_LOOKBACK_TAX_MONTHS = 13/);
    expect(serviceCode).toMatch(/gte\("tax_month_end", snapshotFloor\)/);
    // An unresolvable floor widens the read rather than hiding a liability.
    expect(serviceCode).toMatch(/snapshotFloor \? b\.gte\("tax_month_end", snapshotFloor\) : b/);
    // The UI states the window, so "past the deadline" is never an open claim.
    expect(pageCode).toMatch(/cisLookbackMonths/);
  });
});

// ---------------------------------------------------------------------------
// 6. Loud reads — a failure never renders as "£0 owed"
// ---------------------------------------------------------------------------

describe("a failed money-out read is loud, never a confident zero", () => {
  it("the pager reports its error instead of swallowing it", () => {
    const fn = serviceSrc.slice(serviceSrc.indexOf("async function paged("), serviceSrc.indexOf("export function cisSnapshotFloor"));
    expect(fn).toMatch(/const \{ data, error \} = await fetchAllRows/);
    expect(fn).toMatch(/failed: error != null/);
  });

  it("any failed read raises loadError, and the empty view is failed by default", () => {
    expect(serviceCode).toMatch(/const failed = results\.some\(\(r\) => r\.failed\)/);
    expect(serviceCode).toMatch(/loadError: facts\.failed/);
    const empty = serviceSrc.slice(
      serviceSrc.indexOf("export const EMPTY_CASH_OUT_VIEW"),
      serviceSrc.indexOf("async function paged("),
    );
    expect(empty, "a thrown failure must not read as 'nothing owed'").toMatch(/loadError: true/);
  });

  it("the page's banner covers a money-OUT failure too", () => {
    expect(pageCode).toMatch(/loadError \|\| out\.loadError/);
    expect(pageSrc).toMatch(/role="alert"/);
  });

  it("a snapshot whose payment is missing is DROPPED, not assumed live", () => {
    // Defaulting `voided_at` to null would resurrect a voided payment's
    // deduction as a tax liability — inventing a debt, not merely missing one.
    expect(serviceCode).toMatch(/if \(!p\) return \[\]/);
    expect(serviceSrc).toMatch(/guessing[\s\S]{0,80}would fabricate one/);
  });
});

// ---------------------------------------------------------------------------
// 7. Honest certainty and the role gate
// ---------------------------------------------------------------------------

describe("honest certainty — an estimate is never dressed as a liability", () => {
  it("uses the existing plain-English ladder and no fake probability", () => {
    expect(libSrc).toMatch(/CASH_OUT_CERTAINTY = \["OWED", "DUE", "COMMITTED", "UNTRACKED"\]/);
    for (const [src, name] of [
      [libCode, LIB],
      [pageCode, PAGE],
    ] as const) {
      expect(src, `${name} must carry no probability`).not.toMatch(/probability|confidence\s*[:=]\s*0\.|likelihood/i);
    }
  });

  it("VAT and draft payroll are flagged isEstimate; bills and CIS are not", () => {
    const rows = libSrc.slice(libSrc.indexOf("export function buildCashOutComponents"));
    const estimateOf = (key: string) => {
      const start = rows.indexOf(`key: "${key}"`);
      expect(start, `${key} row not found`).toBeGreaterThan(-1);
      const chunk = rows.slice(start, start + 900);
      return /isEstimate: true/.test(chunk.slice(0, chunk.indexOf("href:")));
    };
    expect(estimateOf("vat_quarter")).toBe(true);
    expect(estimateOf("payroll_draft")).toBe(true);
    expect(estimateOf("supplier_bills")).toBe(false);
    expect(estimateOf("cis_hmrc")).toBe(false);
  });

  it("the UI prints the word 'Estimate' and quantifies the estimated share", () => {
    expect(pageSrc, "the word must be rendered, not just a boolean prop").toMatch(
      />\s*Estimate\s*<\/span>/,
    );
    expect(pageSrc).toMatch(/of the outflow is an estimate/);
    expect(pageSrc).toMatch(/formatGbp\(position\.estimatedOutflow\)/);
  });

  it("the net position is allowed to be negative, and says what a deficit means", () => {
    expect(libSrc).toMatch(/NOT floored/);
    expect(pageSrc).toMatch(/you owe more than you can collect right now/);
  });

  it("the page states plainly that this is not a bank balance", () => {
    expect(pageSrc).toMatch(/not your cash at bank/i);
    expect(pageSrc).toMatch(/PAYE\/NI/);
  });
});

describe("the money-out section is admin-only, because a non-admin would see it WRONG", () => {
  it("the role gate exists and admits owner/admin only", () => {
    expect(serviceSrc).toMatch(
      /export function cashOutVisibleToRole\(role: string\): boolean \{\s*\n\s*return role === "owner" \|\| role === "admin";/,
    );
  });

  it("the page uses the gate rather than showing an understated figure", () => {
    expect(pageCode).toMatch(/const showOutflows = cashOutVisibleToRole\(ctx\.membership\.role\)/);
    expect(pageCode).toMatch(/showOutflows \?/);
    // And staff never reach the page at all (pre-existing).
    expect(pageCode).toMatch(/if \(ctx\.membership\.role === "staff"\)/);
  });

  it("the reason is documented where the gate lives, not left as folklore", () => {
    expect(serviceSrc).toMatch(/WRONG IN THE DANGEROUS\s*\n?\s*\*\s*DIRECTION/);
    expect(serviceSrc).toMatch(/ADMIN-ONLY at the database/);
  });
});

// ---------------------------------------------------------------------------
// 8. The receivables side is untouched
// ---------------------------------------------------------------------------

describe("the existing money-IN authority is not modified", () => {
  it("buildOrgCash and lib/commercial/org-cash keep their own definitions", () => {
    // Money-out is ADDITIVE. If the outflow work had needed to change
    // collectableNow, that would be a change to a live production figure and it
    // would belong in its own reviewed slice.
    const orgCashLib = codeOf(read("lib/commercial/org-cash.ts"));
    expect(orgCashLib).toMatch(/collectableNow: round2\(Math\.max\(0, owedNow - withheld\)\)/);
    expect(orgCashLib, "money-in must not learn about payables").not.toMatch(
      /supplier_id|cis_deduction|net_pay|purchase_order/,
    );
    const orgCashSvc = codeOf(read("server/services/org-cash.ts"));
    expect(orgCashSvc).not.toMatch(/supplier_payments|cis_payment_snapshots|payroll_lines/);
  });

  it("the page still renders the whole money-in surface", () => {
    for (const marker of [
      /Collectable now/,
      /Retention held/,
      /Ready to invoice/,
      /Money in — cash outlook/,
      /Planned billing/,
      /Unscheduled contract value/,
    ]) {
      expect(pageSrc, `money-in marker ${marker} must survive`).toMatch(marker);
    }
  });
});
