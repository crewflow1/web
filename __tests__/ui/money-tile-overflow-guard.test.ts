import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

/**
 * MONEY TILES MUST NOT SCROLL THE WHOLE PAGE SIDEWAYS ON A PHONE — 375px.
 *
 * The sibling guard (money-table-overflow-guard.test.ts) covers hand-rolled
 * `<table>` money grids. It does NOT cover the OTHER shape of the same bug: a
 * KPI/stat TILE. A stat tile renders one big money figure ("£6,234,567.00") in
 * a card, and those cards are laid out 2-up (or denser) at mobile
 * (`grid grid-cols-2`/`grid-cols-3`). A comma-grouped GBP token has NO soft-wrap
 * opportunity, so it takes its full min-content width; in a ~90-133px tile that
 * width exceeds the box, and with nothing to clip it the tile pushes its grid
 * parent past the viewport and the ENTIRE document scrolls sideways.
 *
 * The proven fix is `truncate` on the value line + `min-w-0` on the grid item
 * (a grid track's default min-width is `min-content`, so `truncate` alone is
 * inert until the track is allowed to shrink). The dashboard `Kpi` and /cash
 * `Stat` carry it; this guard makes it a contract for every money tile.
 *
 * WHY THE DETECTOR IS CONTENT-DRIVEN (the C43 gap this rewrite closes):
 * the previous detector classified a value line as money ONLY when it was
 * `font-bold` AND `tabular-nums` AND `text-xl/2xl/3xl`. That is ONE money idiom
 * (the cash/dashboard Stat/Kpi). The far more common `text-lg font-semibold`
 * money tile (no `tabular-nums`) — the jobs, invoices and commercial tiles —
 * was NEVER scanned, so the "cannot be evaded" claim was false and three live
 * grid-cols-3 offenders shipped. This detector instead classifies a line as
 * MONEY by its FORMATTER/CONTENT signal — `formatGbp(` / `GBP.format` / a
 * literal `£` in the rendered value, or a bare `{value}`/`{amount}`/`{money}`
 * prop in a file that feeds it money — INDEPENDENT of font-bold vs font-semibold,
 * of `tabular-nums`, and of `text-lg` vs `text-xl/2xl/3xl`.
 *
 * TWO tile shapes are guarded, each by the tightest signal that keeps false
 * positives at ZERO (a flaky guard is worse than none):
 *
 *   1. A money-fed PRIMITIVE — a reusable `Stat`/`Kpi`/`Tile` whose value line
 *      renders a bare `{value}`/`{amount}`/`{money}` prop, in a file that also
 *      feeds it money (`value={formatGbp(…)}`). A primitive can land in ANY
 *      grid, so its value line must ALWAYS `truncate`.
 *
 *   2. An INLINE money tile — a value line that renders `formatGbp(…)` / a `£`
 *      figure directly. This overflows only when it is 2-up (or denser) at the
 *      mobile base, so it is flagged only when its nearest enclosing grid has a
 *      base (unprefixed) `grid-cols-N` with N ≥ 2. A `grid-cols-1` base tile is
 *      full-width at 375px and a 7-figure GBP fits — NOT flagged.
 *
 * A "value line" is anchored two ways so captions and prose never count:
 *   - it carries a `className` (it is a rendered element, not a JS line or a
 *     prop-feeder such as `<Tile value={formatGbp(x)} />`, which has none), and
 *   - it is PROMINENT: `text-base|text-lg|text-xl|text-2xl|text-3xl`. A money
 *     figure typeset at `text-xs`/`text-sm`/`text-[11px]` is a caption/sub or a
 *     dense list row that soft-wraps in flow — it is not a standalone tile
 *     value and is out of scope by construction. (This is the ONLY typographic
 *     gate; weight and `tabular-nums` do not gate, closing the C43 evasion.)
 *
 * NON-money tiles are out of scope by construction: a tile whose value is a
 * bounded count/percent/mpg ("40%", "12.3 mpg", "—") carries no money signal,
 * so it is never classified and never flagged.
 *
 * A SOURCE pin in the fast unit tier: it proves the structural contract holds
 * across the whole app surface at once. The per-surface e2e
 * (e2e/cash-position-mobile.spec.ts, e2e/money-tile-mobile.spec.ts) seed
 * 7-figure figures and add the pixel confirmation that truncate contains them.
 */

const ROOT = resolve(__dirname, "../..");
/**
 * EVERY route group that renders money tiles must be walked — the "cannot be
 * evaded" contract is a lie if it only covers `app/(app)`. The C43/C44 rewrites
 * closed the CONTENT-signal evasion (font weight / tabular-nums / text size);
 * this closes the DIRECTORY-SCOPE evasion. `app/customer-portal` and `app/q` are
 * token-scoped, customer-facing money surfaces with the SAME 2-up mobile stat
 * tiles and no owner auth — a 7-figure receivable there scrolls the page just as
 * it does inside `(app)`. Paths are stored relative to ROOT so a tile is
 * identified unambiguously across groups (e.g. `customer-portal/[token]/…`).
 */
const APP_DIRS = [
  resolve(ROOT, "app/(app)"),
  resolve(ROOT, "app/customer-portal"),
  resolve(ROOT, "app/q"),
].filter(existsSync);

/**
 * A value line is PROMINENT when it is at least `text-base` — the standalone
 * tile-figure sizes. `text-xs`/`text-sm`/`text-[11px]` captions and dense list
 * rows are excluded so a money figure inside prose is never flagged. Weight
 * (`font-bold` vs `font-semibold`) and `tabular-nums` do NOT gate — that is the
 * whole point of this rewrite.
 */
const PROMINENT_SIZES = ["text-base", "text-lg", "text-xl", "text-2xl", "text-3xl"];
/** Money reaches a tile either literally in its body, or via a fed prop. */
const INLINE_MONEY = /formatGbp\(|GBP\.format|£/;
const BARE_VALUE_PROP = /\{\s*(?:value|amount|money)\s*\}/;
/**
 * A file that hands money to a primitive tile: `value={formatGbp(…)}`,
 * `value={GBP.format(…)}` (the /dashboard idiom), or a `£` template literal.
 * `amount=`/`money=` are accepted too — some tiles name the money prop that.
 */
const FILE_FEEDS_MONEY =
  /(?:value|amount|money)=\{\s*(?:formatGbp\(|GBP\.format)|(?:value|amount|money)=\{`[^`]*£/;

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

/**
 * Is this a candidate tile value line: a rendered element (`className`) typeset
 * at a prominent, standalone size? This deliberately does NOT look at weight or
 * `tabular-nums` — the money signal is decided from the element body below.
 */
function isProminentValueLine(line: string): boolean {
  if (!line.includes("className")) return false;
  return PROMINENT_SIZES.some((s) => line.includes(s));
}

/**
 * Block-level tile value tags: a stat/KPI/tile figure is a stacked BLOCK value
 * (`<div>`/`<dd>`/`<p>`/heading) under a label. An INLINE `<span>` amount in a
 * flex ROW is a different, safe shape — it sits opposite a `min-w-0` sibling
 * that absorbs the squeeze inside a full-width row, so it never scrolls the
 * page (e.g. the /cash `OutlookRow` `<span className="shrink-0 …">{amount}`).
 * Excluding it is not an evasion hole: `flex-shrink` has no effect on a GRID
 * item, so a real grid money tile can never legitimately carry `shrink-0`.
 */
const BLOCK_VALUE_TAG = /^(?:div|dd|dt|p|h[1-6]|li|section|article)$/;

/**
 * True when the element whose opening spans line `i` is a block-level value
 * element. The tag name may sit on the `className` line (`<dd className=…>`) or
 * up to two lines above it (a multi-line `<p>\n  className={…}` opening).
 */
function isBlockValueElement(lines: string[], i: number): boolean {
  for (let j = i; j >= Math.max(0, i - 2); j--) {
    const tags = (lines[j] ?? "").match(/<([a-zA-Z][\w]*)/g);
    if (tags && tags.length > 0) {
      return BLOCK_VALUE_TAG.test(tags[tags.length - 1]!.slice(1));
    }
  }
  return false;
}

/**
 * The element body: this line plus the next few, up to the first close tag.
 * The window (7 lines) spans a multi-line `className={` template + the value on
 * a following line (the jobs/invoices `<dd>` renders `{GBP.format(x)}` on the
 * next line), while the `</…>` cut keeps it from bleeding into the next sibling.
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
  if (!isProminentValueLine(line)) return null;
  // A tile value is a BLOCK figure, not an inline flex-row `<span>` amount.
  if (!isBlockValueElement(lines, i)) return null;
  const body = elementBody(lines, i);
  const truncated = body.includes("truncate");

  // A money-FED primitive: bare {value}/{amount}/{money} in a file that hands
  // it money. Decided FIRST so a `<Tile>` whose body also happens to mention a
  // `£`-bearing prop is scored as the primitive it is (must always clip).
  if (BARE_VALUE_PROP.test(body) && FILE_FEEDS_MONEY.test(fileText)) {
    return { rel, line: i + 1, kind: "primitive", truncated, baseCols: 0 };
  }
  // An inline money tile: the value line renders formatGbp(…)/£ directly.
  if (INLINE_MONEY.test(body)) {
    return {
      rel,
      line: i + 1,
      kind: "inline",
      truncated,
      baseCols: enclosingBaseGridCols(lines, i),
    };
  }
  return null;
}

function scan(): MoneyTile[] {
  const found: MoneyTile[] = [];
  for (const dir of APP_DIRS) {
    for (const file of tsxFiles(dir)) {
      // ROOT-relative so a tile is named unambiguously across route groups
      // (`(app)/cash/page.tsx` vs `customer-portal/[token]/invoices/page.tsx`).
      const rel = relative(ROOT, file);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = classifyLine(text, lines, i, rel);
        if (t) found.push(t);
      }
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
        `to the value line and \`min-w-0\` to the grid item (the fix on /cash Stat, ` +
        `/dashboard Kpi, jobs/invoices/commercial tiles):\n` +
        unguarded
          .map((t) => `  ${t.rel}:${t.line} [${t.kind}${t.kind === "inline" ? ` grid-cols-${t.baseCols}` : ""}]`)
          .join("\n"),
    ).toEqual([]);
  });

  it("the /cash Stat tile — the instance the sibling guard was built for — is a guarded money primitive and is clipped", () => {
    const cash = tiles.filter((t) => t.rel === "app/(app)/cash/page.tsx" && t.kind === "primitive");
    expect(cash.length).toBeGreaterThanOrEqual(1);
    expect(cash.every((t) => t.truncated)).toBe(true);
  });

  it("the /dashboard Kpi tile (text-xl primitive shape) is still caught and clipped", () => {
    // Regression pin: the previous detector's ONE recognised idiom must not
    // regress. The Kpi is a money-fed primitive and carries truncate.
    const kpi = tiles.filter((t) => t.rel === "app/(app)/dashboard/page.tsx" && t.kind === "primitive");
    expect(kpi.length).toBeGreaterThanOrEqual(1);
    expect(kpi.every((t) => t.truncated)).toBe(true);
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

  it("CALIBRATION (the C43 evasion): a `text-lg font-semibold` inline money tile (NO tabular-nums, NOT text-xl) is flagged in a grid-cols-3, and cleared by truncate", () => {
    // This is EXACTLY the shape the previous detector could not see. Prove the
    // rewrite has teeth on it: an inline GBP value line typeset text-lg
    // font-semibold, inside a base grid-cols-3, must fail without truncate.
    const value = `<dd className="mt-0.5 text-lg font-semibold text-slate-900">{GBP.format(x)}</dd>`;
    const risky = [`<dl className="grid grid-cols-3 gap-3 text-sm">`, value];
    const safe = [`<dl className="grid grid-cols-3 gap-3 text-sm">`, value.replace("mt-0.5 ", "mt-0.5 truncate ")];

    const flagged = classifyLine(risky.join("\n"), risky, 1, "probe.tsx");
    expect(flagged?.kind).toBe("inline");
    expect(flagged?.baseCols).toBe(3);
    expect(isViolation(flagged!)).toBe(true);

    const cleared = classifyLine(safe.join("\n"), safe, 1, "probe.tsx");
    expect(cleared?.kind).toBe("inline");
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

  it("CALIBRATION: a text-xs money CAPTION (not a standalone tile value) is NOT classified — false positives stay at zero", () => {
    // The jobs "Job value" grid carries a `text-xs` sub-caption that embeds
    // `${GBP.format(committed.remaining)}` in prose. It soft-wraps in flow and
    // is NOT a tile value — the prominence gate must exclude it.
    const caption = `<p className="text-xs text-slate-500">{committed.count} orders · ${"${GBP.format(committed.remaining)}"} still to come</p>`;
    const t = classifyLine(caption, [caption], 0, "probe.tsx");
    expect(t, "a text-xs money caption must not be classified as a tile value").toBeNull();
  });

  it("every allowlist exception is real, still present, and still justified", () => {
    for (const [rel, { mustContain }] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(resolve(ROOT, rel), "utf8");
      for (const marker of mustContain) {
        expect(
          source,
          `${rel}: allowlist justification no longer holds — missing "${marker}"`,
        ).toContain(marker);
      }
    }
  });
});
