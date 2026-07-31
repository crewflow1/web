import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The two ledger reports must be READABLE ON A PHONE — 375px, one hand, on site.
 *
 * These are the widest tables in the product: aged debtors is a party plus five
 * money columns plus a total. The design-system `Table` primitive documents the
 * exact bug this guards:
 *
 *   "A hidden column MUST be hidden on both the `<th>` and every matching `<td>`
 *    at the same breakpoint, which is the bug this prop exists to make hard."
 *
 * A half-hidden column is not a cosmetic defect on a money report. If the `<th>`
 * hides at `md` and the `<td>` does not, every cell after it shifts one column
 * left and a reader sees "31–60 days" figures under the "1–30 days" heading —
 * silently, with no error, on the report they use to decide who to chase.
 *
 * The second rule is about honesty rather than layout: the bucket columns
 * collapse ALL TOGETHER, never partially, because a subset of the columns no
 * longer sums to the Total printed beside them and nothing tells the reader a
 * column is missing. The collapsed layout must therefore carry the full
 * breakdown as text.
 *
 * A SOURCE pin, not a render test, so it stays in the fast unit tier. What it can
 * prove is that the responsive contract holds structurally; a browser check would
 * add pixel confirmation, not correctness.
 */

const ROOT = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const AGEING = src("app/(app)/reports/ageing/page.tsx");
const RETENTION = src("app/(app)/reports/retention/page.tsx");

describe("aged debtors / creditors at 375px", () => {
  it("all five bucket columns share ONE breakpoint constant, so none can half-hide", () => {
    // The same identifier on the <TH> and the <TD> is what makes the pair
    // impossible to desynchronise — a literal on either side could drift.
    expect(AGEING).toMatch(/const BUCKET_HIDE = "md" as const;/);
    expect(AGEING).toMatch(/<TH key=\{b\} numeric hideBelow=\{BUCKET_HIDE\}>/);
    const tdUses = (AGEING.match(/hideBelow=\{BUCKET_HIDE\}/g) ?? []).length;
    // One header + one body cell + one totals cell.
    expect(tdUses).toBe(3);
    // No hard-coded breakpoint anywhere in the bucket columns.
    expect(AGEING).not.toMatch(/hideBelow="(sm|md|lg)"/);
  });

  it("the collapsed layout carries the FULL breakdown, on rows and on the total", () => {
    // Two call sites: the party row and the totals row. A total whose breakdown
    // vanished on mobile would be the same lie in a different place.
    const uses = (AGEING.match(/<BucketBreakdown/g) ?? []).length;
    expect(uses).toBe(2);
    expect(AGEING).toMatch(/md:hidden/);
    // The breakdown must list every non-zero bucket, not a hand-picked subset.
    expect(AGEING).toMatch(/AGEING_BUCKETS\.filter\(\(b\) => buckets\[b\] > 0\)/);
  });

  it("the party column and the total NEVER hide — the two figures that must survive", () => {
    expect(AGEING).toMatch(/<TH>\{partyLabel\}<\/TH>/);
    expect(AGEING).toMatch(/<TH numeric>Total<\/TH>/);
  });
});

describe("the retention register at 375px", () => {
  it("each hidden column's TH and TD agree on the breakpoint", () => {
    for (const bp of ["md", "lg"] as const) {
      const ths = (RETENTION.match(new RegExp(`<TH[^>]*hideBelow="${bp}"`, "g")) ?? []).length;
      const tds = (RETENTION.match(new RegExp(`<TD[^>]*hideBelow="${bp}"`, "g")) ?? []).length;
      // One <TH>, one body <TD>, one totals-row <TD> per hidden column.
      expect(ths, `${bp}: header count`).toBe(1);
      expect(tds, `${bp}: cell count`).toBe(2);
    }
  });

  it("the release stage and the entitling date reappear when their column is hidden", () => {
    // Hiding a column is only acceptable if the fact survives somewhere: the
    // moiety label and the entitling date are the whole argument for a release.
    expect(RETENTION).toMatch(/md:hidden[\s\S]{0,60}\{line\.moietyLabel\}/);
    expect(RETENTION).toMatch(/lg:hidden[^>]*>\s*<DateCell line=\{line\} \/>/);
  });

  it("the EVIDENCE survives the phone layout — same helper, both breakpoints", () => {
    // The certificate number is what a client meeting turns on, and a builder on
    // site is the likeliest reader of the narrow layout. One helper renders it in
    // both places so the two can never disagree about what backs a date.
    expect(RETENTION).toMatch(/function evidenceNote\(line: RetentionRegisterLine\): string/);
    const uses = (RETENTION.match(/evidenceNote\(line\)/g) ?? []).length;
    expect(uses, "evidence must render in the wide column AND the lg:hidden fallback").toBe(2);
    // And it must only claim certification when a certificate actually governs.
    expect(RETENTION).toMatch(
      /line\.completionSource === "certificate" && line\.certificateNumber/,
    );
  });

  it("the money column and the state badge never hide", () => {
    expect(RETENTION).toMatch(/<TH numeric>Outstanding<\/TH>/);
    expect(RETENTION).toMatch(/<TH>State<\/TH>/);
  });
});

describe("both reports use the design-system table chrome", () => {
  it("neither hand-rolls a scroll wrapper or a header band", () => {
    for (const [name, source] of [
      ["ageing", AGEING],
      ["retention", RETENTION],
    ] as const) {
      // `Table` owns `overflow-x-auto`, which is what stops a wide table from
      // scrolling the whole document sideways on a phone.
      expect(source, `${name} must import the primitives`).toMatch(
        /from "@\/components\/ui"/,
      );
      expect(source, `${name} must not hand-roll the wrapper`).not.toContain("overflow-x-auto");
      expect(source, `${name} must not hand-roll the header band`).not.toContain(
        "bg-slate-50 text-left text-xs font-semibold uppercase",
      );
    }
  });
});
