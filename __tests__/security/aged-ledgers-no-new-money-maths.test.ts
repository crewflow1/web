import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * NO NEW MONEY MATHS — the aged ledgers may compose the existing authorities and
 * nothing else.
 *
 * ── WHY THIS IS A SECURITY TEST AND NOT A STYLE TEST ─────────────────────────
 * A second copy of a settlement rule is how a report and the page it is meant to
 * agree with silently diverge, and the operator has no way to tell which figure
 * is the real one. This codebase has already paid for it once: before
 * `computeCommercialCash`, `computeJobCommercialPosition` counted a
 * `partially_paid` invoice's FULL total as paid, so a £20k invoice with £5k
 * received read as £0 outstanding. The fix was one authority per rule. These
 * reports must not reopen that.
 *
 * Five rules are owned elsewhere and none of them may be re-derived here:
 *
 *   receivable balance  `invoiceRemaining`        lib/commercial/org-cash
 *   collectable set     `isCollectableStatus`     lib/invoices/overdue
 *   days late           `invoiceDaysOverdue`      lib/invoices/overdue
 *   payable balance     `computeBillSettlements`  lib/suppliers/payments
 *   retention           `computeRetentionPosition` + `computeRetentionSchedule`
 *
 * ── HOW IT IS ENFORCED ───────────────────────────────────────────────────────
 * Two complementary halves:
 *
 *  1. POSITIVELY — each new module must be seen calling the authority that owns
 *     its figures. A module that stopped importing them would fail even if its
 *     replacement arithmetic looked correct.
 *
 *  2. STRUCTURALLY — `lib/commercial/ageing.ts` is never handed the INPUTS a
 *     balance is derived from. No total, no paid, no vat_total, no gross, no
 *     settled, no payment or allocation rows, no invoice status. It therefore
 *     cannot re-derive one however a future edit is written, which is a stronger
 *     guarantee than asking a reviewer to notice a `-` in a diff.
 *
 * Assertions run against source with COMMENT LINES STRIPPED, because the headers
 * deliberately quote the very idioms being banned to explain why they are banned.
 */

const ROOT = resolve(__dirname, "..", "..");

/** Source with comment lines removed — these pins are about CODE. */
function code(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

const AGEING = code("lib/commercial/ageing.ts");
const DEBTORS = code("lib/commercial/aged-debtors.ts");
const CREDITORS = code("lib/commercial/aged-creditors.ts");
const OVERDUE = code("lib/commercial/overdue-payables.ts");
const REGISTER = code("lib/commercial/retention-register.ts");
const SERVICE = code("server/services/aged-ledgers.ts");

// ---------------------------------------------------------------------------
// 1. positively — the authorities are actually called
// ---------------------------------------------------------------------------

describe("the receivable balance comes from the cash authority", () => {
  it("aged-debtors imports and calls invoiceRemaining", () => {
    expect(DEBTORS).toMatch(/invoiceRemaining[\s\S]*from "@\/lib\/commercial\/org-cash"/);
    expect(DEBTORS).toMatch(/invoiceRemaining\(forRemaining\)/);
  });

  it("the collectable population comes from the overdue authority, not a local Set", () => {
    // A local copy would drift the day a status is added to the enum, and the
    // /cash reconciliation would break with nothing failing.
    expect(DEBTORS).toMatch(/isCollectableStatus[\s\S]*from "@\/lib\/invoices\/overdue"/);
    expect(DEBTORS).toMatch(/if \(!isCollectableStatus\(inv\.status\)\) continue;/);
    expect(DEBTORS).not.toMatch(/new Set\(\s*\[\s*"sent"/);
    expect(DEBTORS).not.toContain('"awaiting_payment"');
    expect(DEBTORS).not.toContain('"partially_paid"');
  });

  it("lateness comes from invoiceDaysOverdue, not a local date subtraction", () => {
    expect(DEBTORS).toMatch(/invoiceDaysOverdue\(\{ status: inv\.status, due_date: inv\.due_date \}/);
    expect(DEBTORS).not.toContain("86_400_000");
    expect(DEBTORS).not.toContain("86400000");
    expect(DEBTORS).not.toMatch(/Date\.parse/);
  });

  it("aged-debtors contains no hand-rolled balance", () => {
    for (const banned of [
      /total\s*-\s*paid/,
      /Math\.max\(\s*0\s*,\s*toPounds/,
      /toPounds\([^)]*\)\s*-/,
      /vat_total/,
    ]) {
      expect(DEBTORS, `banned idiom ${banned}`).not.toMatch(banned);
    }
  });
});

describe("the payable balance comes from the supplier authority", () => {
  it("aged-creditors imports and calls computeBillSettlements", () => {
    expect(CREDITORS).toMatch(/computeBillSettlements[\s\S]*from "@\/lib\/suppliers\/payments"/);
    expect(CREDITORS).toMatch(/computeBillSettlements\(\{/);
  });

  it("gross is never re-added from amount + vat_total here", () => {
    // billGross owns that, and it is the figure a payment settles.
    expect(CREDITORS).not.toMatch(/amount[\s\S]{0,20}\+[\s\S]{0,20}vat_total/);
    expect(CREDITORS).not.toMatch(/gross\s*-\s*settled/);
  });

  it("voided payments are excluded by the authority, not re-filtered locally", () => {
    expect(CREDITORS).not.toMatch(/voided_at\s*==?=?\s*null/);
    expect(CREDITORS).not.toMatch(/filter\([^)]*voided/);
  });

  it("day counting reuses the shared helper", () => {
    expect(CREDITORS).toMatch(/daysBetween.*from "@\/lib\/schedule\/window"/);
    expect(CREDITORS).not.toContain("86_400_000");
  });
});

describe("overdue payables COMPOSES aged creditors — it only changes the ageing DATE", () => {
  it("composes composeAgedCreditors rather than re-deriving settlement", () => {
    // The whole point of the module: inject a due-date resolver into the existing
    // creditors bridge, so there is one payables settlement path, not two.
    expect(OVERDUE).toMatch(/composeAgedCreditors[\s\S]*from "@\/lib\/commercial\/aged-creditors"/);
    expect(OVERDUE).toMatch(/composeAgedCreditors\(/);
  });

  it("never touches the settlement authority or a balance directly", () => {
    // It must not import or call computeBillSettlements, re-add gross, or filter
    // voided payments — those all live behind composeAgedCreditors.
    expect(OVERDUE).not.toMatch(/computeBillSettlements/);
    expect(OVERDUE).not.toMatch(/amount[\s\S]{0,20}\+[\s\S]{0,20}vat_total/);
    expect(OVERDUE).not.toMatch(/gross\s*-\s*settled/);
    expect(OVERDUE).not.toMatch(/voided_at\s*==?=?\s*null/);
  });

  it("adds only DATE arithmetic, via the shared day helper — never raw milliseconds", () => {
    // Due date = base + terms. `addDays` is exact whole-day arithmetic on a date
    // key; a hand-rolled `+ n * 86_400_000` on an instant would reintroduce the
    // BST bug the day-key helpers exist to prevent.
    expect(OVERDUE).toMatch(/addDays.*from "@\/lib\/schedule\/window"/);
    expect(OVERDUE).not.toContain("86_400_000");
    expect(OVERDUE).not.toContain("86400000");
  });

  it("the base date is London-pinned, never a toISOString day", () => {
    expect(OVERDUE).toMatch(/formatDayKeyUK/);
    // A bare `.toISOString().slice(0, 10)` on created_at would be the UTC day.
    expect(OVERDUE).not.toMatch(/created_at[\s\S]{0,40}toISOString/);
  });
});

describe("retention comes from the retention authorities", () => {
  it("the register calls computeRetentionPosition and computeRetentionSchedule", () => {
    expect(REGISTER).toMatch(/computeRetentionPosition\(\{/);
    expect(REGISTER).toMatch(/computeRetentionSchedule\(\{/);
  });

  it("no local rate, held or defects-period arithmetic", () => {
    expect(REGISTER).not.toMatch(/\/\s*100/);
    expect(REGISTER).not.toMatch(/accrued\s*-\s*released/);
    expect(REGISTER).not.toMatch(/setUTCMonth|getUTCMonth/);
  });
});

describe("the service does reads, not maths", () => {
  it("composes the pure bridges rather than bucketing inline", () => {
    expect(SERVICE).toMatch(/composeAgedDebtors\(/);
    // The creditors side now ages by TRUE due date via composeOverduePayables,
    // which itself composes composeAgedCreditors — one settlement path, two lenses.
    expect(SERVICE).toMatch(/composeOverduePayables\(/);
  });

  it("its ONLY money operation is the round2-wrapped per-invoice payment fold", () => {
    // The same fold server/services/org-cash.ts performs, for the same purpose:
    // turning payment rows into the `paid` figure the authority expects.
    expect(SERVICE).toMatch(
      /paidByInvoice\.set\(id, round2\(\(paidByInvoice\.get\(id\) \?\? 0\) \+ toPounds\(mv\(p\.amount\)\)\)\)/,
    );
    // No subtraction, multiplication or division of money anywhere.
    expect(SERVICE).not.toMatch(/toPounds\([^)]*\)\s*[-*/]/);
    expect(SERVICE).not.toMatch(/[-*/]\s*toPounds\(/);
    expect(SERVICE).not.toMatch(/Math\.max\(\s*0\s*,/);
  });

  it("never re-derives the collectable set or the overdue predicate", () => {
    expect(SERVICE).not.toMatch(/new Set\(\s*\[\s*"sent"/);
    expect(SERVICE).not.toMatch(/due_date\s*<\s*/);
  });
});

// ---------------------------------------------------------------------------
// 2. structurally — the bucketer cannot re-derive a balance
// ---------------------------------------------------------------------------

describe("the bucketer is never given the inputs a balance is derived from", () => {
  const BANNED_INPUTS = [
    "vat_total",
    "gross",
    "settled",
    "allocation",
    "invoice_payments",
    "toPounds",
    "invoiceRemaining",
    "computeBillSettlement",
  ];

  for (const token of BANNED_INPUTS) {
    it(`ageing.ts never names \`${token}\``, () => {
      expect(AGEING, `ageing.ts must not see ${token}`).not.toContain(token);
    });
  }

  it("ageing.ts never sees an invoice status or a payment figure", () => {
    // `total` IS present as the name of a ledger TOTAL (an output), which is why
    // the ban targets the inputs a balance is computed from rather than the word.
    expect(AGEING).not.toMatch(/\bstatus\b/);
    expect(AGEING).not.toMatch(/\bpaid\b/);
    expect(AGEING).not.toMatch(/\bdue_date\b/);
  });

  it("ageing.ts imports nothing but lib/money", () => {
    const imports = [...AGEING.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/money"]);
  });

  it("ageing.ts uses only round2 and sumMoney for money", () => {
    expect(AGEING).toMatch(/import \{ round2, sumMoney \} from "@\/lib\/money"/);
  });

  it("every subtraction in ageing.ts is inside a sort comparator, never a rendered figure", () => {
    // The comparators produce an ORDERING. Any other `-` on money would be a
    // derived amount, which is what this whole file exists to prevent.
    const subtractions = [...AGEING.matchAll(/[^\s\w)]\s*-\s*|\w\s+-\s+\w/g)];
    const lines = AGEING.split("\n");
    const offending: string[] = [];
    for (const [i, line] of lines.entries()) {
      if (!/[\w)]\s*-\s*[\w(]/.test(line)) continue;
      // Comparator bodies are the only sanctioned home for a `-` here.
      const context = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      if (/\.sort\(/.test(context)) continue;
      offending.push(`${i + 1}: ${line.trim()}`);
    }
    expect(subtractions.length, "sanity: the scan found something to check").toBeGreaterThan(0);
    expect(offending, `subtraction outside a sort comparator:\n${offending.join("\n")}`).toEqual([]);
  });
});
