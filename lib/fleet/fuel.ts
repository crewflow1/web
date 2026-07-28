import { round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Fleet fuel + operating cost — aggregation that REFUSES to guess (PURE).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: fuel consumption is only knowable
 * tank-to-tank. Between two brim-full fills you know exactly how far the
 * vehicle went (odometer difference) and exactly how much fuel that took (the
 * litres it accepted to get back to full). Across a PARTIAL fill you do not:
 * an unknown amount was left in the tank, so any "MPG" derived from it is
 * arithmetic performed on a number nobody measured.
 *
 * So `computeConsumption` returns segments ONLY where every precondition holds,
 * and `null` — not 0, not an estimate, not a smoothed average — when none do.
 * A fleet page showing "—" because the data cannot support a figure is honest;
 * one showing "31.4 mpg" derived from half-known tanks is not, and a builder
 * would make purchasing decisions on it.
 *
 * Money is GBP via lib/money.ts (2dp, round2 at every step). Distance is MILES
 * and volume is LITRES, matching how a UK forecourt actually prices and how the
 * DB stores it — so consumption is reported in the unit a UK operator reads,
 * miles per IMPERIAL gallon, converted at the exact statutory 4.54609 L.
 */

/** UK gallon — Weights and Measures Act, exactly 4.54609 litres. */
export const LITRES_PER_IMPERIAL_GALLON = 4.54609;

export interface FuelLogInput {
  id: string;
  assetId: string;
  /** YYYY-MM-DD. */
  filledOn: string;
  odometerMiles: number | null;
  litres: number | string | null;
  cost: number | string | null;
  isFullFill: boolean;
}

/**
 * Order fuel logs into the sequence the vehicle actually experienced: by date,
 * then by odometer, then by id. The id tiebreaker makes the order TOTAL — two
 * fills on the same day at the same reading must not swap between runs, or a
 * consumption segment could appear and disappear across page loads.
 */
export function orderLogs(logs: readonly FuelLogInput[]): FuelLogInput[] {
  return [...logs].sort(
    (a, b) =>
      a.filledOn.localeCompare(b.filledOn) ||
      (a.odometerMiles ?? 0) - (b.odometerMiles ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export interface ConsumptionSegment {
  fromLogId: string;
  toLogId: string;
  fromOdometer: number;
  toOdometer: number;
  miles: number;
  litres: number;
  mpg: number;
  costPerMile: number | null;
}

export interface ConsumptionResult {
  segments: ConsumptionSegment[];
  /**
   * Fleet/vehicle MPG over every valid segment: total valid miles ÷ total
   * valid gallons. Null when no segment qualifies — see the module header.
   */
  mpg: number | null;
  /** Miles covered inside valid segments only (NOT lifetime mileage). */
  measuredMiles: number;
  /**
   * Entries that could not contribute, and why — surfaced in the UI so the
   * absence of a figure is explained rather than mysterious.
   */
  skipped: number;
}

/**
 * Tank-to-tank consumption. A segment between logs[i-1] and logs[i] counts only
 * when ALL of these hold:
 *
 *   1. both are FULL fills                — the tank level is known at each end;
 *   2. they are ADJACENT in the log       — nothing unrecorded in between. A
 *                                           partial fill between two full fills
 *                                           breaks the chain here deliberately:
 *                                           including it would assume the log is
 *                                           complete, which we cannot verify;
 *   3. both carry an odometer reading     — no distance without two readings;
 *   4. the odometer strictly INCREASES    — a lower reading is a replaced clock
 *                                           or a typo, never negative travel;
 *   5. logs[i] has a positive litres      — an EV charge has no litres, and a
 *                                           missing quantity cannot be inferred.
 *
 * Anything failing these is counted in `skipped`, never quietly averaged in.
 */
export function computeConsumption(logs: readonly FuelLogInput[]): ConsumptionResult {
  const ordered = orderLogs(logs);
  const segments: ConsumptionSegment[] = [];
  let skipped = 0;

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const litres = cur.litres == null ? null : Number(cur.litres);

    const usable =
      prev.isFullFill &&
      cur.isFullFill &&
      prev.odometerMiles != null &&
      cur.odometerMiles != null &&
      cur.odometerMiles > prev.odometerMiles &&
      litres != null &&
      Number.isFinite(litres) &&
      litres > 0;

    if (!usable) {
      skipped += 1;
      continue;
    }

    const miles = cur.odometerMiles! - prev.odometerMiles!;
    const gallons = litres! / LITRES_PER_IMPERIAL_GALLON;
    const cost = cur.cost == null ? null : toPounds(cur.cost);
    segments.push({
      fromLogId: prev.id,
      toLogId: cur.id,
      fromOdometer: prev.odometerMiles!,
      toOdometer: cur.odometerMiles!,
      miles,
      litres: round2(litres!),
      mpg: round2(miles / gallons),
      costPerMile: cost != null && cost > 0 ? round2(cost / miles) : null,
    });
  }

  if (segments.length === 0) {
    return { segments: [], mpg: null, measuredMiles: 0, skipped };
  }

  const totalMiles = segments.reduce((a, s) => a + s.miles, 0);
  const totalLitres = segments.reduce((a, s) => a + s.litres, 0);
  const gallons = totalLitres / LITRES_PER_IMPERIAL_GALLON;
  return {
    segments,
    mpg: gallons > 0 ? round2(totalMiles / gallons) : null,
    measuredMiles: totalMiles,
    skipped,
  };
}

export interface FuelTotals {
  /** Total spend across every entry — always valid, needs no odometer. */
  spend: number;
  /** Total litres where recorded. EV charges contribute cost but no litres. */
  litres: number;
  entries: number;
}

export function sumFuel(logs: readonly FuelLogInput[]): FuelTotals {
  return {
    spend: sumMoney(logs.map((l) => l.cost)),
    litres: round2(
      logs.reduce((a, l) => a + (l.litres == null ? 0 : Number(l.litres) || 0), 0),
    ),
    entries: logs.length,
  };
}

export interface VehicleFuelSummary {
  assetId: string;
  spend: number;
  litres: number;
  entries: number;
  /** Null unless a valid tank-to-tank segment exists for THIS vehicle. */
  mpg: number | null;
  /** Highest odometer reading seen in the logs; null when never recorded. */
  latestOdometer: number | null;
}

/** Per-vehicle rollup. Each vehicle's MPG is judged on its OWN segments only. */
export function summariseByVehicle(logs: readonly FuelLogInput[]): VehicleFuelSummary[] {
  const byAsset = new Map<string, FuelLogInput[]>();
  for (const l of logs) {
    const list = byAsset.get(l.assetId);
    if (list) list.push(l);
    else byAsset.set(l.assetId, [l]);
  }

  const out: VehicleFuelSummary[] = [];
  for (const [assetId, list] of byAsset) {
    const totals = sumFuel(list);
    const odos = list
      .map((l) => l.odometerMiles)
      .filter((v): v is number => v != null && Number.isFinite(v));
    out.push({
      assetId,
      spend: totals.spend,
      litres: totals.litres,
      entries: totals.entries,
      mpg: computeConsumption(list).mpg,
      latestOdometer: odos.length > 0 ? Math.max(...odos) : null,
    });
  }
  // Biggest spender first; assetId keeps the order total.
  return out.sort((a, b) => b.spend - a.spend || a.assetId.localeCompare(b.assetId));
}

/**
 * Distance covered over the logged period, per vehicle — the honest version of
 * a "mileage trend". It is the span between the LOWEST and HIGHEST recorded
 * readings, which is a real measured distance, and is null when fewer than two
 * readings exist. It is explicitly NOT extrapolated to a rate per month: a
 * handful of fills spread unevenly cannot support that, and labelling a guess
 * as a trend is the failure mode this module exists to avoid.
 */
export function mileageSpan(logs: readonly FuelLogInput[]): {
  miles: number;
  fromIso: string;
  toIso: string;
} | null {
  const withOdo = orderLogs(logs).filter(
    (l) => l.odometerMiles != null && Number.isFinite(l.odometerMiles),
  );
  if (withOdo.length < 2) return null;
  const first = withOdo[0]!;
  const last = withOdo[withOdo.length - 1]!;
  const miles = (last.odometerMiles ?? 0) - (first.odometerMiles ?? 0);
  if (miles <= 0) return null;
  return { miles, fromIso: first.filledOn, toIso: last.filledOn };
}

/**
 * Operating cost = fuel + maintenance. Both are real recorded outgoings, so the
 * sum is real. It is NOT a total cost of ownership: finance payments,
 * insurance premiums, depreciation and tyres are not all captured here, so the
 * UI labels this exactly as what it sums and never as "cost to run".
 */
export function operatingCost(fuelSpend: number, maintenanceSpend: number): number {
  return round2(toPounds(fuelSpend) + toPounds(maintenanceSpend));
}
