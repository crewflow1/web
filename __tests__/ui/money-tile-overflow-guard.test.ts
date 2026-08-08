import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";

/**
 * MONEY TILES MUST NOT SCROLL THE WHOLE PAGE SIDEWAYS ON A PHONE — 375px.
 *
 * The sibling guard (money-table-overflow-guard.test.ts) covers hand-rolled
 * `<table>` money grids. It does NOT cover the OTHER shape of the same bug: a
 * KPI/stat TILE. A stat tile renders one big bold money figure
 * ("£6,234,567.00") in a card, and those cards are laid out 2-up at mobile
 * (`grid grid-cols-2`). A comma-grouped GBP token has NO soft-wrap opportunity,
 * so at `text-xl` it takes its full min-content width; in a ~133px half-width
 * tile that width exceeds the box, and with nothing to clip it the tile pushes
 * its grid parent past the viewport and the ENTIRE document scrolls sideways.
 *
 * The proven fix is one Tailwind class on the value line: `truncate`
 * (overflow-hidden + text-ellipsis + whitespace-nowrap). The dashboard `Kpi`
 * tile carries it; this guard makes it a contract for every money tile.
 *
 * TWO tile shapes are guarded, each by the tightest signal that keeps false
 * positives at ZERO (a flaky guard is worse than none):
 *
 *   1. A money-fed PRIMITIVE — a reusable `Stat`/`Kpi` component whose value
 *      line renders a bare `{value}`/`{amount}` prop, in a file that also feeds
 *      it money (`value={formatGbp(…)}`). A primitive can land in ANY grid, so
 *      its value line must ALWAYS `truncate`. (This is exactly the /cash `Stat`
 *      bug this guard was built for, and the /dashboard `Kpi` precedent.)
 *
 *   2. An INLINE money tile — a value line that renders `formatGbp(…)` / a `£`
 *      figure directly. This overflows only when it is 2-up (or denser) at the
 *      mobile base, so it is flagged only when its nearest enclosing grid has a
 *      base (unprefixed) `grid-cols-N` with N ≥ 2. A `grid-cols-1` base tile is
 *      full-width at 375px and a 7-figure GBP fits — NOT flagged (the /cash
 *      "Net position" `<dd>` tiles are this safe case).
 *
 * NON-money tiles are out of scope by construction: a tile whose value is a
 * bounded count/percent/mpg ("40%", "12.3 mpg", "—") cannot grow without bound,
 * so it is never classified as money and never flagged (fleet mpg, stock
 * quantities, job-progress percent, CIS deduction-rate all sit outside).
 *
 * A SOURCE pin in the fast unit tier: it proves the structural contract holds
 * across the whole app surface at once. The per-surface e2e
 * (e2e/cash-position-mobile.spec.ts) seeds a 7-figure receivable and adds the
 * pixel confirmation that truncate actually contains it at 375px.
 */

const ROOT = resolve(__dirname, "../..");
const APP_DIR = resolve(ROOT, "app/(app)");

/** A tile value line is a big, bold, tabular figure — the stat/KPI idiom. */
const TILE_SIZES = ["text-xl", "text-2xl", "text-3xl"];
/** Money reaches a tile either literally on the line, or via a fed prop. */
const INLINE_MONEY = /formatGbp\(|GBP\.format|£/;
const BARE_VALUE_PROP = /\{\s*(?:value|amount)\s*\}/;
/**
 * A file that hands money to a primitive tile: `value={formatGbp(…)}`,
 * `value={GBP.format(…)}` (the /dashboard idiom), or a `£` template literal.
 * `amount=` is accepted too — some tiles name the money prop `amount`.
 */
const FILE_FEEDS_MONEY = /(?:value|amount)=\{\s*(?:formatGbp\(|GBP\.format)|(?:value|amount)=\{`[^`]*£/;

/**
 * Documented, legitimate exceptions — a money tile that defends 375px by a
 * strategy the automatic rules don't model. Each entry must say why, and the
 * test asserts the justification still holds so an entry can't rot into cover
 * for a plain unclipped tile. (Empty today: the two automatic rules cover every
 * shipped money tile, so nothing needs a manual pass.)
 */
const ALLOWLIST: Record<string, { reason: string; mustContain: string[] }> = {};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Is this className line a tile value line (big + bold + tabular)? */
function isTileValueLine(line: string): boolean {
  return (
    line.includes("font-bold") &&
    line.includes("tabular-nums") &&
    TILE_SIZES.some((s) => line.includes(s))
  );
}

/**
 * The element body: this line plus the next few, up to the first close tag.
 * The window (7 lines) spans a multi-line `className={` template + the value
 * on a following line (the /cash "Net position" tile), while the `</…>` cut
 * keeps it from bleeding into the next sibling element.
 */
function elementBody(lines: string[], i: number): string {
  const win = lines.slice(i, i + 7).join("\n");
  const cut = win.indexOf("</");
  return cut === -1 ? win : win.slice(0, cut);
}

/**
 * Base (unprefixed) column count of the nearest enclosing grid, scanning upward.
 * A `grid-cols-N` token with a breakpoint prefix (`sm:`/`md:`/…) is NOT the base.
 * Returns 1 when the nearest grid is single-column at mobile, or 0 when no grid
 * encloses the line within the lookback window.
 */
function enclosingBaseGridCols(lines: string[], i: number): number {
  for (let j = i; j >= Math.max(0, i - 40); j--) {
    const ln = lines[j] ?? "";
    if (!ln.includes("grid-cols-")) continue;
    const m = ln.match(/(?<![a-z0-9]:)grid-cols-(\d+)/g);
    if (!m || m.length === 0) continue;
    // The first UNPREFIXED grid-cols on this line is the mobile base.
    const n = Number(m[0].replace("grid-cols-", ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

type MoneyTile = {
  rel: string;
  line: number;
  kind: "primitive" | "inline";
  truncated: boolean;
  baseCols: number;
};

function classifyLine(
  fileText: string,
  lines: string[],
  i: number,
  rel: string,
): MoneyTile | null {
  const line = lines[i] ?? "";
  if (!isTileValueLine(line)) return null;
  const body = elementBody(lines, i);
  const truncated = body.includes("truncate");

  if (INLINE_MONEY.test(body)) {
    return {
      rel,
      line: i + 1,
      kind: "inline",
      truncated,
      baseCols: enclosingBaseGridCols(lines, i),
    };
  }
  // A money-FED primitive: bare {value}/{amount} in a file that hands it money.
  if (BARE_VALUE_PROP.test(body) && FILE_FEEDS_MONEY.test(fileText)) {
    return { rel, line: i + 1, kind: "primitive", truncated, baseCols: 0 };
  }
  return null;
}

function scan(): MoneyTile[] {
  const found: MoneyTile[] = [];
  for (const file of tsxFiles(APP_DIR)) {
    const rel = relative(APP_DIR, file);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = classifyLine(text, lines, i, rel);
      if (t) found.push(t);
    }
  }
  return found;
}

/** A tile that scrolls the page: money, not clipped, and NOT a safe layout. */
function isViolation(t: MoneyTile): boolean {
  if (t.truncated) return false;
  if (t.rel in ALLOWLIST) return false;
  // A money-fed primitive can land in any grid → it must always clip.
  if (t.kind === "primitive") return true;
  // An inline money tile overflows only when it is 2-up (or denser) at mobile.
  return t.baseCols >= 2;
}

describe("money stat/KPI tiles are clipped against 375px horizontal overflow", () => {
  const tiles = scan();

  it("finds money tiles to guard (the scanner is not silently matching nothing)", () => {
    // A guard that scans zero files would pass vacuously forever; pin that the
    // walker reaches the app surface and the money heuristic still fires.
    expect(tiles.length).toBeGreaterThan(3);
  });

  it("every money tile clips its value (truncate), or is a documented exception", () => {
    const unguarded = tiles.filter(isViolation);
    expect(
      unguarded,
      `these money tiles scroll the whole page sideways at 375px — add \`truncate\` ` +
        `to the value line (the fix on /cash Stat and /dashboard Kpi):\n` +
        unguarded
          .map((t) => `  ${t.rel}:${t.line} [${t.kind}${t.kind === "inline" ? ` grid-cols-${t.baseCols}` : ""}]`)
          .join("\n"),
    ).toEqual([]);
  });

  it("the /cash Stat tile — the instance this guard was built for — is a guarded money primitive and is clipped", () => {
    const cash = tiles.filter((t) => t.rel === "cash/page.tsx" && t.kind === "primitive");
    expect(cash.length).toBe(1);
    expect(cash[0]!.truncated).toBe(true);
  });

  it("CALIBRATION: the classifier flags a money primitive value line WITHOUT truncate, and clears it WITH truncate", () => {
    // Pin the guard's teeth in-code so it can never rot into a vacuous pass:
    // reconstruct the /cash Stat value line and prove the rule turns on truncate.
    const fed = `<p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{value}</p>`;
    const feeder = `value={formatGbp(x)}`;
    const withTruncate = fed.replace("mt-1 ", "mt-1 truncate ");

    const flagged = classifyLine(`${fed}\n${feeder}`, [fed], 0, "probe.tsx");
    expect(flagged, "a money primitive line should be classified").not.toBeNull();
    expect(isViolation(flagged!)).toBe(true);

    const cleared = classifyLine(`${withTruncate}\n${feeder}`, [withTruncate], 0, "probe.tsx");
    expect(cleared, "a truncated money primitive line should still be classified").not.toBeNull();
    expect(isViolation(cleared!)).toBe(false);
  });

  it("CALIBRATION: a single-column (grid-cols-1 base) inline money tile is SAFE, a grid-cols-2 one is not", () => {
    const value = `<dd className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">{formatGbp(x)}</dd>`;
    const safe = [`<dl className="grid grid-cols-1 sm:grid-cols-3">`, value];
    const risky = [`<section className="grid grid-cols-2 lg:grid-cols-3">`, value];

    const safeTile = classifyLine(safe.join("\n"), safe, 1, "probe.tsx");
    expect(safeTile?.kind).toBe("inline");
    expect(isViolation(safeTile!)).toBe(false);

    const riskyTile = classifyLine(risky.join("\n"), risky, 1, "probe.tsx");
    expect(riskyTile?.kind).toBe("inline");
    expect(isViolation(riskyTile!)).toBe(true);
  });

  it("every allowlist exception is real, still present, and still justified", () => {
    for (const [rel, { mustContain }] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(resolve(APP_DIR, rel), "utf8");
      for (const marker of mustContain) {
        expect(
          source,
          `${rel}: allowlist justification no longer holds — missing "${marker}"`,
        ).toContain(marker);
      }
    }
  });
});
