import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";

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
 * WHERE CALL SITES LIVE — the CROSS-FILE blind spot this rewrite closes (C51).
 *
 * The in-file primitive rule only fires when a `Stat`/`Kpi`/`Tile` primitive is
 * defined AND handed money in the SAME file (the /cash and /dashboard idiom).
 * But a SHARED primitive is defined once (e.g. `Stat` in
 * `app/(app)/fleet/_components/ui.tsx`, which renders a bare `{value}`) and fed
 * money from OTHER files (`app/(app)/fleet/fuel/page.tsx` passes
 * `value={formatGbp(totals.spend)}`). The primitive's own file never contains a
 * `formatGbp(`, so the in-file rule is blind to it and a real 7-figure overflow
 * shipped. To see it we must trace prop-fed money ACROSS files: index every call
 * site in the repo that hands money to a component prop, then a primitive whose
 * value line renders that bare prop is money-fed even if its own file isn't.
 * Both the primitive definitions and their call sites live under `app/` and
 * `components/`, so those two trees are the call-site search space.
 */
const CALLSITE_DIRS = [resolve(ROOT, "app"), resolve(ROOT, "components")].filter(existsSync);

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
 * The bare prop a primitive's value line renders, WITH its name captured. The
 * name matters for cross-file tracing: a call site must feed money to the SAME
 * prop the value line prints (a primitive that prints `{value}` is money-fed
 * only when a caller writes `value={formatGbp(…)}`, not `hint={…}`).
 */
const BARE_VALUE_PROP_NAMED = /\{\s*(value|amount|money)\s*\}/;
/**
 * A file that hands money to a primitive tile: `value={formatGbp(…)}`,
 * `value={GBP.format(…)}` (the /dashboard idiom), or a `£` template literal.
 * `amount=`/`money=` are accepted too — some tiles name the money prop that.
 */
const FILE_FEEDS_MONEY =
  /(?:value|amount|money)=\{\s*(?:formatGbp\(|GBP\.format)|(?:value|amount|money)=\{`[^`]*£/;
/**
 * ONE call-site money feed, WITH the fed prop name captured (group 1 for the
 * `formatGbp(`/`GBP.format` form, group 2 for the `£` template-literal form).
 * This is the per-occurrence twin of FILE_FEEDS_MONEY, used to build the
 * repo-wide {component → money-fed props} index for cross-file tracing.
 */
const MONEY_PROP_FEED =
  /(?:(value|amount|money)=\{\s*(?:formatGbp\(|GBP\.format)|(value|amount|money)=\{`[^`]*£)/;

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

/**
 * The component tag a prop on line `i` belongs to — the nearest opening
 * `<Capitalised` at or above the prop. On the prop's own line the opening tag is
 * the FIRST capitalised tag (attributes, incl. a nested `icon={<Icon/>}`, follow
 * it); a standalone prop line has none, so we walk up to the `<Stat` opener.
 */
function openingComponentAbove(lines: string[], i: number): string | null {
  for (let j = i; j >= Math.max(0, i - 12); j--) {
    const tags = (lines[j] ?? "").match(/<([A-Z]\w*)/);
    if (tags) return tags[1]!;
  }
  return null;
}

/**
 * localName → import specifier for every component a file brings in. Both a
 * default import (`import Foo from "…"`) and named imports (`import { Bar, Baz
 * as Qux } from "…"`) are captured; `type`-only names are irrelevant (they are
 * never rendered) and harmless if included.
 */
function importMap(fileText: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileText))) {
    const [, def, named, spec] = m;
    if (def && spec) map.set(def, spec);
    if (named && spec) {
      for (const raw of named.split(",")) {
        const part = raw.trim().replace(/^type\s+/, "");
        if (!part) continue;
        const asM = part.match(/^(\w+)\s+as\s+(\w+)$/);
        map.set(asM ? asM[2]! : part, spec);
      }
    }
  }
  return map;
}

/** Capitalised component names DEFINED in this file (function or const). */
function componentDefsInFile(fileText: string): Set<string> {
  const names = new Set<string>();
  const fn = /(?:export\s+)?function\s+([A-Z]\w*)/g;
  const cn = /(?:export\s+)?const\s+([A-Z]\w*)\s*[:=]/g;
  let m: RegExpExecArray | null;
  while ((m = fn.exec(fileText))) names.add(m[1]!);
  while ((m = cn.exec(fileText))) names.add(m[1]!);
  return names;
}

/**
 * Resolve a relative/`@/`-aliased import specifier to an absolute source file.
 * Bare (node_modules) specifiers resolve to null — a third-party tile is not a
 * primitive we own or scan. Tries `.tsx`/`.ts` and an `index.*` folder entry.
 */
function resolveImportPath(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const cands = [`${base}.tsx`, `${base}.ts`, resolve(base, "index.tsx"), resolve(base, "index.ts")];
  return cands.find(existsSync) ?? null;
}

/**
 * Repo-wide index: absolute DEFINITION-FILE path → the set of props some call
 * site hands money. Keyed by the file the component is DEFINED in (resolved
 * through imports), NOT by bare name — so the money-fed fleet `Stat`
 * (fleet/_components/ui.tsx) is never conflated with an unrelated LOCAL `Stat`
 * that renders a count in dashboard/_insights.tsx or assets/inspections. A
 * `<Stat value={formatGbp(x)} />` in fleet/fuel/page.tsx records
 * `fleet/_components/ui.tsx → {value}`; scanning that file's `{value}` line then
 * sees it as money-fed even though the file itself never mentions `formatGbp`.
 */
function moneyFedDefIndex(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const dir of CALLSITE_DIRS) {
    for (const file of tsxFiles(dir)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      const imports = importMap(text);
      const localDefs = componentDefsInFile(text);
      for (let i = 0; i < lines.length; i++) {
        const m = (lines[i] ?? "").match(MONEY_PROP_FEED);
        if (!m) continue;
        const prop = m[1] ?? m[2];
        const comp = openingComponentAbove(lines, i);
        if (!prop || !comp) continue;
        // Resolve the component to the file it is DEFINED in.
        const defPath = imports.has(comp)
          ? resolveImportPath(file, imports.get(comp)!)
          : localDefs.has(comp)
            ? file
            : null;
        if (!defPath) continue;
        if (!idx.has(defPath)) idx.set(defPath, new Set());
        idx.get(defPath)!.add(prop);
      }
    }
  }
  return idx;
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
  moneyIndex?: Map<string, Set<string>>,
  absPath?: string,
): MoneyTile | null {
  const line = lines[i] ?? "";
  if (!isProminentValueLine(line)) return null;
  // A tile value is a BLOCK figure, not an inline flex-row `<span>` amount.
  if (!isBlockValueElement(lines, i)) return null;
  const body = elementBody(lines, i);
  const truncated = body.includes("truncate");

  // A money-FED primitive: bare {value}/{amount}/{money} whose money arrives
  // EITHER in the same file (`value={formatGbp(…)}` — the /cash & /dashboard
  // idiom) OR from a call site ANYWHERE in the repo that hands money to the
  // SAME prop of the primitive DEFINED IN THIS FILE (a shared `Stat` defined
  // once, fed money elsewhere — the C51 cross-file blind spot). The cross-file
  // index is keyed by definition-file path, so an unrelated LOCAL `Stat`/`Tile`
  // that renders a count is never conflated with the money-fed one. Decided
  // FIRST so a `<Tile>` whose body also mentions a `£`-bearing prop is scored as
  // the primitive it is (always clips).
  if (BARE_VALUE_PROP.test(body)) {
    const inFileFed = FILE_FEEDS_MONEY.test(fileText);
    const named = body.match(BARE_VALUE_PROP_NAMED);
    const crossFileFed =
      !inFileFed &&
      named != null &&
      absPath != null &&
      (moneyIndex?.get(absPath)?.has(named[1]!) ?? false);
    if (inFileFed || crossFileFed) {
      return { rel, line: i + 1, kind: "primitive", truncated, baseCols: 0 };
    }
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
  // Built once and threaded through every classification so a primitive fed
  // money from another file is caught (the C51 cross-file rule).
  const moneyIndex = moneyFedDefIndex();
  const found: MoneyTile[] = [];
  for (const dir of APP_DIRS) {
    for (const file of tsxFiles(dir)) {
      // ROOT-relative so a tile is named unambiguously across route groups
      // (`(app)/cash/page.tsx` vs `customer-portal/[token]/invoices/page.tsx`).
      const rel = relative(ROOT, file);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const t = classifyLine(text, lines, i, rel, moneyIndex, file);
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

  it("the fleet Stat — a SHARED primitive fed money from OTHER files — is caught cross-file and is clipped", () => {
    // The C51 blind spot: `Stat` is defined in fleet/_components/ui.tsx (which
    // never contains `formatGbp`) and fed money from fleet/{page,fuel,vehicles}
    // via `value={formatGbp(…)}`. The in-file rule was blind to it; the
    // cross-file index catches it. Post-fix it carries `truncate`.
    const fleet = tiles.filter(
      (t) => t.rel === "app/(app)/fleet/_components/ui.tsx" && t.kind === "primitive",
    );
    expect(fleet.length).toBeGreaterThanOrEqual(1);
    expect(fleet.every((t) => t.truncated)).toBe(true);
  });

  it("CALIBRATION (the C51 cross-file evasion): a shared primitive whose value line is a bare {value}, fed money ONLY from another file, is flagged without truncate and cleared with it", () => {
    // Reconstruct the fleet `Stat` EXACTLY as it shipped pre-fix: a bare
    // `{value}` value line in a file that itself has NO `formatGbp(`. The
    // in-file rule (fileText) can NOT see money here — only the cross-file index
    // can. Key the index by this file's PATH (as a call site in another file,
    // resolving its import, would).
    const DEF_PATH = "/repo/fleet/_components/ui.tsx";
    const def = [
      `export function Stat({ label, value }: { label: string; value: string }) {`,
      `  return (`,
      `    <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{value}</p>`,
      `  );`,
      `}`,
    ];
    const idx = new Map<string, Set<string>>([[DEF_PATH, new Set(["value"])]]);
    const fileText = def.join("\n"); // deliberately contains NO formatGbp(.
    expect(FILE_FEEDS_MONEY.test(fileText)).toBe(false); // in-file rule is blind.

    // Without the index the line is NOT classified (proves it was a real hole).
    expect(classifyLine(fileText, def, 2, "fleet/ui.tsx")).toBeNull();

    // With the cross-file index it IS classified as a money primitive and,
    // un-truncated, it is a violation.
    const flagged = classifyLine(fileText, def, 2, "fleet/ui.tsx", idx, DEF_PATH);
    expect(flagged?.kind, "cross-file money primitive should be classified").toBe("primitive");
    expect(isViolation(flagged!)).toBe(true);

    // The truncate fix clears it — the line is still classified (still a money
    // primitive) but no longer a violation.
    const fixed = [...def];
    fixed[2] = fixed[2]!.replace("mt-1 ", "mt-1 truncate ");
    const cleared = classifyLine(fixed.join("\n"), fixed, 2, "fleet/ui.tsx", idx, DEF_PATH);
    expect(cleared?.kind).toBe("primitive");
    expect(isViolation(cleared!)).toBe(false);
  });

  it("CALIBRATION: the cross-file rule does NOT fire on a bare-{value} primitive that no call site feeds money, nor on a same-NAMED count primitive in another file (no new false positives)", () => {
    const DEF_PATH = "/repo/misc/card.tsx";
    const def = [
      `export function Card({ value }: { value: string }) {`,
      `  return <p className="text-xl font-bold">{value}</p>;`,
      `}`,
    ];
    // A generic primitive rendering `{value}` that only ever receives
    // counts/percentages (never `value={formatGbp(…)}`) is absent from the
    // index, so it must NOT be classified — the rule traces MONEY, not any prop.
    const emptyIdx = new Map<string, Set<string>>();
    expect(classifyLine(def.join("\n"), def, 1, "misc/card.tsx", emptyIdx, DEF_PATH)).toBeNull();

    // The KEY anti-collision guarantee: the index is keyed by definition-file
    // PATH, not name. Money fed to a DIFFERENT file's `value` (a same-named
    // primitive elsewhere) must NOT leak onto this file's tile.
    const otherFileFed = new Map<string, Set<string>>([
      ["/repo/fleet/_components/ui.tsx", new Set(["value"])],
    ]);
    expect(classifyLine(def.join("\n"), def, 1, "misc/card.tsx", otherFileFed, DEF_PATH)).toBeNull();

    // And a mismatched prop on THIS file must not fire: the value line prints
    // `{value}` but the only money feed is to `amount` — no match.
    const wrongProp = new Map<string, Set<string>>([[DEF_PATH, new Set(["amount"])]]);
    expect(classifyLine(def.join("\n"), def, 1, "misc/card.tsx", wrongProp, DEF_PATH)).toBeNull();
  });

  it("the repo money-fed index links the fleet Stat's DEFINITION FILE to `value` via its real call sites", () => {
    // Prove the index (not a stub) actually resolves the shipped call sites
    // THROUGH IMPORTS: fleet pages `import { Stat } from "../_components/ui"` and
    // pass `value={formatGbp(…)}`, so the fleet ui.tsx path → {value}. A local
    // count-only `Stat` (dashboard/_insights.tsx) must NOT appear.
    const idx = moneyFedDefIndex();
    const fleetUi = resolve(ROOT, "app/(app)/fleet/_components/ui.tsx");
    expect(
      idx.get(fleetUi)?.has("value"),
      "fleet _components/ui.tsx must be recorded as money-fed on `value`",
    ).toBe(true);
    const insights = resolve(ROOT, "app/(app)/dashboard/_insights.tsx");
    expect(
      idx.get(insights)?.has("value") ?? false,
      "the count-only local Stat in _insights.tsx must NOT be recorded as money-fed",
    ).toBe(false);
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
