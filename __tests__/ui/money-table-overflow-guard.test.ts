import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";

/**
 * MONEY TABLES MUST NOT SCROLL THE WHOLE PAGE SIDEWAYS ON A PHONE — 375px.
 *
 * This is the guardrail for a class of bug the team has now fixed four times
 * instance-by-instance: a hand-rolled `<table>` that renders money
 * (C30b purchase-orders list, C36 jobs/[id]/billing, C37 purchase-orders detail,
 * and /insights company-health). The mechanism is always the same. A comma-
 * grouped GBP token ("£1,234,567.89") has NO soft-wrap opportunity, so an
 * auto-layout money column takes its full min-content width; with no
 * `overflow-x-auto` ancestor to absorb it the table stretches its grid/flex
 * parent past the viewport and the ENTIRE document scrolls sideways.
 *
 * The design-system `Table` primitive (`@/components/ui`) owns `overflow-x-auto`
 * for the tables built on it — those render `<Table>` (capital T) in source and
 * are not matched here. This guard covers the HAND-ROLLED lowercase `<table>`
 * elements, where the scroll wrapper is the author's responsibility. For each
 * one that renders money it asserts an `overflow-x-auto` (or `-auto`/`-scroll`)
 * wrapper appears in the handful of lines immediately before the tag — in every
 * shipped money table today the wrapper is the immediately-enclosing `<div>`, one
 * line up.
 *
 * A SOURCE pin, deliberately in the fast unit tier: it proves the structural
 * contract holds across the whole app surface at once, which no per-page e2e can.
 * The per-surface e2e specs (e2e/*-mobile.spec.ts) add the pixel confirmation
 * that the wrapper actually contains the overflow at 375px.
 *
 * KEEP IT CLEAN: the money signal and the wrapper window are tuned so that today
 * every hand-rolled money table passes except the one documented exception below,
 * and no NON-money table is flagged. If this guard ever becomes noisy, fix the
 * heuristic — a flaky guard is worse than none.
 */

const ROOT = resolve(__dirname, "../..");
const APP_DIR = resolve(ROOT, "app/(app)");

/** How a money value reaches the DOM in the hand-rolled tables (all real idioms). */
const MONEY_TOKENS = ["formatGbp", "GBP.format", "tabular-nums", "£"];
/** Any of these on an ancestor line absorbs the overflow instead of the page. */
const WRAP_TOKENS = ["overflow-x-auto", "overflow-auto", "overflow-x-scroll"];
/** The wrapper is the immediately-enclosing element; a small margin for formatting. */
const LOOKBACK_LINES = 4;

/**
 * Documented, legitimate exceptions — a money `<table>` that defends 375px by a
 * strategy OTHER than a scroll wrapper. Each entry must say why, and the test
 * asserts the justification still holds so an entry can't rot into cover for a
 * plain unwrapped table.
 */
const ALLOWLIST: Record<string, { reason: string; mustContain: string[] }> = {
  "expenses/page.tsx": {
    reason:
      "Responsive column-hiding: the money columns are `hidden sm:table-cell`, so " +
      "they are not rendered at 375px at all, and the section is `overflow-hidden` " +
      "(clips rather than pushing the document). No scroll wrapper is needed.",
    mustContain: ["hidden sm:table-cell", "overflow-hidden"],
  },
};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

type MoneyTable = { rel: string; line: number; wrapped: boolean };

function scan(): MoneyTable[] {
  const found: MoneyTable[] = [];
  for (const file of tsxFiles(APP_DIR)) {
    const rel = relative(APP_DIR, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.includes("<table")) continue;
      // This table's body: from the opening tag to its own closing tag.
      const rest = lines.slice(i).join("\n");
      const end = rest.indexOf("</table>");
      const body = end === -1 ? rest : rest.slice(0, end);
      if (!MONEY_TOKENS.some((t) => body.includes(t))) continue;
      const back = lines.slice(Math.max(0, i - LOOKBACK_LINES), i + 1).join("\n");
      const wrapped = WRAP_TOKENS.some((w) => back.includes(w));
      found.push({ rel, line: i + 1, wrapped });
    }
  }
  return found;
}

describe("hand-rolled money tables are wrapped against 375px horizontal overflow", () => {
  const tables = scan();

  it("finds money tables to guard (the scanner is not silently matching nothing)", () => {
    // A guard that scans zero files would pass vacuously forever; pin that the
    // walker actually reaches the app surface and the money heuristic still fires.
    expect(tables.length).toBeGreaterThan(5);
  });

  it("every hand-rolled money <table> has an overflow-x-auto wrapper (or a documented exception)", () => {
    const unguarded = tables.filter((t) => !t.wrapped && !(t.rel in ALLOWLIST));
    expect(
      unguarded,
      `these money tables scroll the whole page sideways at 375px — wrap each in ` +
        `<div className="overflow-x-auto"> (the pattern in invoices/[id], purchase-orders/[id], ` +
        `jobs/[id]/billing):\n` +
        unguarded.map((t) => `  ${t.rel}:${t.line}`).join("\n"),
    ).toEqual([]);
  });

  it("the /insights company-health tables — the instance this guard was built for — are wrapped", () => {
    const insights = tables.filter((t) => t.rel === "insights/_company-health.tsx");
    // CustomerLtvPanel + SubcontractorPanel.
    expect(insights.length).toBe(2);
    expect(insights.every((t) => t.wrapped)).toBe(true);
  });

  it("every allowlist exception is real, still present, and still justified", () => {
    for (const [rel, { mustContain }] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(resolve(APP_DIR, rel), "utf8");
      expect(source, `${rel}: allowlisted but has no <table>`).toContain("<table");
      // The exception is only valid while its stated defence is still in place.
      for (const marker of mustContain) {
        expect(
          source,
          `${rel}: allowlist justification no longer holds — missing "${marker}"`,
        ).toContain(marker);
      }
    }
  });
});
