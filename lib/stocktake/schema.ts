import { z } from "zod";
import { round2, toPounds } from "@/lib/money";

/**
 * STOCKTAKE / CYCLE-COUNT — pure input validation, the session vocabulary, and
 * the deterministic variance maths. PURE: no I/O, no server-only imports,
 * unit-tested directly.
 *
 * THE ACCOUNTING BOUNDARY (see supabase/migrations/20261144000000 header): a
 * stocktake reconciles QUANTITIES. Nothing here carries a cost, a price or a
 * valuation — a variance is `counted − expected`, both quantities. Posting it
 * goes through the movement ledger's adjustment path, which posts no cost.
 * Stock valuation / a valuation report is CEO decision D1 and is OUT OF SCOPE.
 *
 * `supabase/migrations/20261144000000_stocktake_sessions.sql` and `…01…` are the
 * source of truth for bounds, statuses and the transition rules; everything here
 * mirrors them so a user sees a sentence, never a Postgres error.
 */

export const STOCKTAKE_REFERENCE_MAX = 120;

/** The session lifecycle, in the exact order it progresses. */
export const STOCKTAKE_STATUSES = ["open", "counting", "posted", "cancelled"] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

export function isStocktakeStatus(v: string): v is StocktakeStatus {
  return (STOCKTAKE_STATUSES as readonly string[]).includes(v);
}

export const STOCKTAKE_STATUS_LABELS: Record<StocktakeStatus, string> = {
  open: "Open",
  counting: "Counting",
  posted: "Posted",
  cancelled: "Cancelled",
};

export const STOCKTAKE_STATUS_CLASS: Record<StocktakeStatus, string> = {
  open: "bg-slate-100 text-slate-700",
  counting: "bg-sky-100 text-sky-800",
  posted: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-200 text-slate-600",
};

export function stocktakeStatusLabel(status: string): string {
  return isStocktakeStatus(status) ? STOCKTAKE_STATUS_LABELS[status] : status;
}

/** A session is live (can be counted / posted / cancelled) while open or counting. */
export function isStocktakeLive(status: string): boolean {
  return status === "open" || status === "counting";
}

export const stocktakeIdSchema = z.string().uuid();

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/** Open a session: pick a site, optionally name it and add a note. */
export const openStocktakeSchema = z.object({
  site_id: z.string().uuid("Pick where you are counting"),
  reference: optionalText(STOCKTAKE_REFERENCE_MAX),
  notes: optionalText(2000),
});
export type OpenStocktakeInput = z.infer<typeof openStocktakeSchema>;

/** A count: which item, and how many (blank clears the count). */
export const countLineSchema = z.object({
  stock_item_id: z.string().uuid("Pick an item"),
  counted_qty: z.preprocess(
    blankToUndefined,
    z.coerce
      .number({ invalid_type_error: "Enter a number" })
      .nonnegative("A count can't be negative")
      .max(9_999_999, "That's too big")
      .optional(),
  ),
});
export type CountLineInput = z.infer<typeof countLineSchema>;

/**
 * THE VARIANCE, in one place: counted − expected, at the same 2dp discipline as
 * every other stock quantity. Positive = found more than expected (an
 * adjustment_in on post); negative = short (an adjustment_out).
 */
export function computeVariance(
  expected: number | string | null | undefined,
  counted: number | string | null | undefined,
): number {
  return round2(round2(toPounds(counted)) - round2(toPounds(expected)));
}

/** How a single line stands, for the count UI. */
export type LineState = "uncounted" | "match" | "over" | "short";

export function lineState(
  expected: number | string | null | undefined,
  counted: number | string | null | undefined,
): LineState {
  if (counted === null || counted === undefined || counted === "") return "uncounted";
  const v = computeVariance(expected, counted);
  if (v === 0) return "match";
  return v > 0 ? "over" : "short";
}

/** One line as every surface reads it, plus its derived variance and state. */
export interface StocktakeLinePosition {
  id: string;
  stockItemId: string;
  name: string;
  unit: string;
  sku: string | null;
  barcode: string | null;
  expected: number;
  counted: number | null;
  variance: number | null;
  state: LineState;
  postedMovementId: string | null;
  postedVariance: number | null;
}

export interface StocktakeLineRowInput {
  id: string;
  stock_item_id: string;
  expected_qty: number | string | null;
  counted_qty: number | string | null;
  posted_movement_id: string | null;
  posted_variance: number | string | null;
}

export interface StocktakeItemRefInput {
  id: string;
  name: string;
  unit?: string | null;
  sku?: string | null;
  barcode?: string | null;
}

const numOrNull = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : round2(toPounds(v));

/**
 * Join count lines to the catalogue and derive the variance/state for each.
 *
 * Sort: variances first (short worst, then over), then still-uncounted, then
 * matches, then by name — the order a person reconciling wants, worst first.
 * `id` is the final tiebreaker so the render is stable for any read permutation
 * (the lib/operations/compose.ts ordering discipline).
 */
const STATE_RANK: Record<LineState, number> = { short: 0, over: 1, uncounted: 2, match: 3 };

export function buildLinePositions(
  lines: readonly StocktakeLineRowInput[],
  items: ReadonlyMap<string, StocktakeItemRefInput>,
): StocktakeLinePosition[] {
  return lines
    .map((line): StocktakeLinePosition => {
      const item = items.get(line.stock_item_id);
      const expected = round2(toPounds(line.expected_qty));
      const counted = numOrNull(line.counted_qty);
      const variance = counted === null ? null : computeVariance(expected, counted);
      return {
        id: line.id,
        stockItemId: line.stock_item_id,
        name: item?.name ?? "Item",
        unit: item?.unit?.trim() || "ea",
        sku: item?.sku?.trim() || null,
        barcode: item?.barcode?.trim() || null,
        expected,
        counted,
        variance,
        state: lineState(expected, counted),
        postedMovementId: line.posted_movement_id,
        postedVariance: numOrNull(line.posted_variance),
      };
    })
    .sort(
      (a, b) =>
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
}

/** The headline tiles on a session. Every number is a real count. */
export interface StocktakeSummary {
  totalLines: number;
  counted: number;
  uncounted: number;
  variances: number;
  /** Signed sum of the counted lines' variances — net quantity change on post. */
  netVariance: number;
}

export function summariseLines(positions: readonly StocktakeLinePosition[]): StocktakeSummary {
  let counted = 0;
  let variances = 0;
  let net = 0;
  for (const p of positions) {
    if (p.counted !== null) {
      counted += 1;
      if (p.variance !== null && p.variance !== 0) {
        variances += 1;
        net = round2(net + p.variance);
      }
    }
  }
  return {
    totalLines: positions.length,
    counted,
    uncounted: positions.length - counted,
    variances,
    netVariance: net,
  };
}

/** Match a scanned/typed code against an item's barcode or sku (case-insensitive). */
export function normaliseScanCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Translate a Postgres refusal from the stocktake RPCs into a sentence. The
 * DATABASE is the enforcement boundary (20261144000000/01); this only decides
 * wording, and an unmapped code still falls back loudly rather than silently.
 */
export function friendlyStocktakeError(
  code: string | undefined,
  message: string | undefined,
): string {
  const m = (message ?? "").trim();

  if (code === "23505" || /duplicate key/i.test(m)) {
    if (/stock_items_org_barcode_unique/.test(m)) {
      return "You already have an item with that barcode. Barcodes are matched ignoring capitals.";
    }
    if (/stocktake_lines_session_item_uniq/.test(m)) {
      return "That item is already on this stocktake.";
    }
    return "That already exists.";
  }
  if (/only an owner or admin can post/.test(m)) {
    return "Only an owner or admin can post a stocktake. Ask one of them to post the count.";
  }
  if (/only an owner or admin can adjust stock/.test(m)) {
    return "Only an owner or admin can post the variances. Ask one of them to post the count.";
  }
  if (/cannot write off /.test(m)) {
    // record_stock_adjustment's floor message, surfaced during posting.
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}. Some stock moved since the count — recount and try again.`;
  }
  if (/count at least one item/.test(m)) return "Count at least one item before posting.";
  if (/not open for counting/.test(m)) return "This stocktake isn't open for counting.";
  if (/was not part of this stocktake/.test(m)) {
    return "That item wasn't part of this stocktake — it may have been added after the count started.";
  }
  if (/is final/.test(m)) return "This stocktake is already finished and can't be changed.";
  if (/cannot be posted/.test(m)) return "This stocktake can't be posted right now.";
  if (/cannot be cancelled/.test(m)) return "This stocktake can't be cancelled.";
  if (/cannot be reopened/.test(m)) return "This stocktake can't be reopened for counting.";
  if (/stocktake not found/.test(m)) return "That stocktake isn't in the company you're working in.";
  if (/site not found/.test(m)) return "That site isn't in the company you're working in.";
  if (/count cannot be negative/.test(m)) return "A count can't be negative.";
  if (code === "23514" || code === "check_violation") {
    return "That isn't allowed as entered. Check the details and try again.";
  }
  return "Couldn't record that. Try again.";
}
