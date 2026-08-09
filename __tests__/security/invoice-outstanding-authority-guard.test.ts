import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * STATIC CLASS GUARD — the outstanding / overdue / collectable authority is
 * defined ONCE.
 *
 * The defect class this pins: a module OTHER than the two authority files
 * re-deciding, locally, which invoice statuses are outstanding / overdue /
 * collectable — either by defining its own `isInvoiceOverdue`, or by hardcoding
 * the status subset {sent, awaiting_payment, partially_paid, overdue} instead of
 * importing the canonical exports:
 *
 *   - lib/invoices/overdue.ts  → OVERDUE_COLLECTABLE_STATUSES, isInvoiceOverdue
 *   - lib/invoices/schema.ts   → OUTSTANDING_STATUSES
 *
 * Why it matters: the payment-sync trigger stamps `partially_paid` on ANY
 * deposit and `awaiting_payment` is a first-class outstanding state. A local
 * copy that lists only {sent, overdue} (the shape of the customer-portal
 * action-centre defect) silently drops those invoices from "what is owed" — a
 * customer-facing money-correctness defect. This test fails CI the moment a new
 * local copy is introduced anywhere under app/, lib/ or server/.
 *
 * SCOPE: this guards the OUTSTANDING/OVERDUE/COLLECTABLE authority specifically.
 * The sibling "issued / accrual" set {…, paid, …} (ISSUED_INVOICE_STATUSES) is a
 * DIFFERENT authority and is intentionally NOT matched here — those literals
 * carry `paid`, so their member set never equals the outstanding set.
 */

const ROOT = resolve(__dirname, "..", "..");
const SCAN_ROOTS = ["app", "lib", "server"];

/** The two files that ARE the authority — the only legitimate home for the literal. */
const AUTHORITY = new Set([
  "lib/invoices/overdue.ts",
  "lib/invoices/schema.ts",
]);

/**
 * Documented, genuinely-legitimate exceptions. Empty today — every real offender
 * was routed through the canonical exports. A single-status UI badge (e.g.
 * `status === "paid"`) is not matched by the detectors below and needs no entry.
 */
const ALLOWLIST: Record<string, string> = {
  // "path/from/root.ts": "reason it is a legitimate, non-authority status check",
};

/** The canonical outstanding / collectable member set, sorted. */
const OUTSTANDING_MEMBERS = ["awaiting_payment", "overdue", "partially_paid", "sent"];
const INVOICE_STATUS_TOKENS = new Set([
  "draft",
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  "overdue",
]);

/** Source with line-comments and block-comment lines stripped, so prose that
 * quotes the old predicate to explain the fix is never mistaken for committing it. */
function readCode(absPath: string): string {
  return readFileSync(absPath, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
      walk(abs, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(abs);
    }
  }
  return out;
}

/** A local re-definition of the overdue predicate. */
function definesLocalIsInvoiceOverdue(code: string): boolean {
  return /\b(?:export\s+)?(?:async\s+)?function\s+isInvoiceOverdue\b/.test(code) ||
    /\bconst\s+isInvoiceOverdue\s*[:=]/.test(code);
}

/** A hardcoded array/Set literal whose invoice-status members ARE the outstanding set. */
function hardcodesOutstandingSubset(code: string): boolean {
  const literals = code.match(/\[[^\]]*\]/g) ?? [];
  for (const lit of literals) {
    const tokens = [...lit.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const members = [...new Set(tokens.filter((t) => INVOICE_STATUS_TOKENS.has(t)))].sort();
    if (
      members.length === OUTSTANDING_MEMBERS.length &&
      members.every((m, i) => m === OUTSTANDING_MEMBERS[i])
    ) {
      return true;
    }
  }
  return false;
}

/** The classic gross gate `X.status === "sent" || X.status === "overdue"` (either order). */
function usesSentOrOverdueGate(code: string): boolean {
  return (
    /status\s*===\s*"sent"\s*\|\|\s*[\w.]*\bstatus\s*===\s*"overdue"/.test(code) ||
    /status\s*===\s*"overdue"\s*\|\|\s*[\w.]*\bstatus\s*===\s*"sent"/.test(code)
  );
}

describe("outstanding/overdue authority is defined once (static class guard)", () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(resolve(ROOT, r)));

  it("scans a non-trivial number of source files", () => {
    // Guard against a broken walk silently passing everything.
    expect(files.length).toBeGreaterThan(200);
  });

  it("the detectors actually fire on the canonical literal (self-check)", () => {
    // The exact pre-fix shapes MUST be caught, or the guard proves nothing.
    expect(hardcodesOutstandingSubset('["sent","awaiting_payment","partially_paid","overdue"]')).toBe(true);
    expect(definesLocalIsInvoiceOverdue("export function isInvoiceOverdue(inv) {}")).toBe(true);
    expect(usesSentOrOverdueGate('inv.status === "sent" || inv.status === "overdue"')).toBe(true);
    // The ISSUED sibling set (carries `paid`) is a DIFFERENT authority — never matched.
    expect(hardcodesOutstandingSubset('["sent","awaiting_payment","partially_paid","paid","overdue"]')).toBe(false);
    // A single-status badge is fine.
    expect(usesSentOrOverdueGate('status === "paid"')).toBe(false);
  });

  it("no module outside the authority re-defines the outstanding/overdue status set", () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (AUTHORITY.has(rel) || ALLOWLIST[rel]) continue;
      const code = readCode(abs);
      const reasons: string[] = [];
      if (definesLocalIsInvoiceOverdue(code)) reasons.push("local isInvoiceOverdue");
      if (hardcodesOutstandingSubset(code)) reasons.push("hardcoded outstanding status subset");
      if (usesSentOrOverdueGate(code)) reasons.push('`status === "sent" || status === "overdue"` gate');
      if (reasons.length) offenders.push(`${rel} — ${reasons.join("; ")}`);
    }

    expect(
      offenders,
      offenders.length
        ? `Route these through OVERDUE_COLLECTABLE_STATUSES / OUTSTANDING_STATUSES ` +
            `(lib/invoices/overdue.ts, lib/invoices/schema.ts), or add a documented ` +
            `ALLOWLIST entry if genuinely legitimate:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("the authority files themselves still export the canonical names", () => {
    const overdue = readFileSync(resolve(ROOT, "lib/invoices/overdue.ts"), "utf8");
    const schema = readFileSync(resolve(ROOT, "lib/invoices/schema.ts"), "utf8");
    expect(overdue).toMatch(/export const OVERDUE_COLLECTABLE_STATUSES/);
    expect(overdue).toMatch(/export function isInvoiceOverdue/);
    expect(schema).toMatch(/export const OUTSTANDING_STATUSES/);
  });
});
