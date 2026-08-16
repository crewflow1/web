import type { BriefingSeverity } from "@/lib/briefing/types";

/**
 * Fleet compliance — deterministic due / overdue detection (PURE).
 *
 * No LLM, no heuristics, no "roughly". Every judgement here is a date
 * comparison against a calendar day, and every one is unit-tested on its
 * boundary. The server reads the schedules (org-pinned) and hands the rows in;
 * this module decides what is late and how loudly to say so.
 *
 * THE SEVERITY RULE, and why it is not uniform:
 * `critical` is reserved across this codebase for a LIVE safety or legal
 * breach — lib/briefing/compose.ts spends its critical band on work without a
 * RAMS and on expired-but-active permits, and caps mere scheduling clashes at
 * `high` on purpose. Vehicle compliance divides on exactly that line:
 *
 *   Driving without a valid MOT      — Road Traffic Act 1988 s.47, an offence.
 *   Driving without insurance        — RTA 1988 s.143, strict liability, 6-8
 *                                      points and a possible disqualification.
 *   Driving untaxed on a public road — Vehicle Excise and Registration Act
 *                                      1994 s.29, an offence, but enforced as a
 *                                      DVLA penalty rather than a licence
 *                                      endorsement.
 *
 * So an expired MOT or insurance on a vehicle the company still has IN SERVICE
 * is a live legal breach and earns `critical` — and, like the permit breach,
 * cannot be dismissed off the briefing. Expired road tax earns `high`: still an
 * offence, still needs fixing today, but not the same exposure. And ANY of the
 * three on a vehicle that is off road or in the workshop is `high`, not
 * critical — an untaxed van on axle stands in the yard breaks no law. That
 * carve-out is what keeps `critical` meaning something.
 *
 * A lapsed TYRE check sits below the legal line on purpose. The offence is the
 * tread state (RTA 1988 / Construction & Use Regs — below 1.6mm), which a missed
 * inspection DATE does not prove; so an overdue tyre check is treated like
 * overdue road tax or service — `high`, needs doing today, but not a proven
 * driving offence. It is deliberately absent from LEGAL_COMPLIANCE_TYPES and
 * CRITICAL_WHEN_IN_SERVICE for exactly that reason.
 *
 * "In service" is `fleet_vehicles.operational_status = 'in_service'` on an
 * `active` asset — i.e. the company's own statement that the vehicle is
 * available to drive. It deliberately does NOT require an open custody
 * assignment: plenty of firms never formally check a van out, and gating the
 * breach on that would under-report the exposure to zero for those firms.
 */

/** The obligations Fleet tracks through `asset_service_schedules`. */
export const FLEET_COMPLIANCE_TYPES = [
  "mot",
  "insurance",
  "road_tax",
  "service",
  "tyres",
] as const;
export type FleetComplianceType = (typeof FLEET_COMPLIANCE_TYPES)[number];

export const FLEET_COMPLIANCE_LABELS: Record<FleetComplianceType, string> = {
  mot: "MOT",
  insurance: "Insurance",
  road_tax: "Road tax",
  service: "Service",
  tyres: "Tyres",
};

/** The three whose lapse is an offence in itself (service is not). */
export const LEGAL_COMPLIANCE_TYPES = ["mot", "insurance", "road_tax"] as const;

/** MOT and insurance — the two that make an in-service vehicle a live breach. */
const CRITICAL_WHEN_IN_SERVICE: readonly string[] = ["mot", "insurance"];

export function isFleetComplianceType(v: string): v is FleetComplianceType {
  return (FLEET_COMPLIANCE_TYPES as readonly string[]).includes(v);
}

export type ComplianceState = "overdue" | "due_soon" | "ok";

/** One schedule row, reduced to what the maths needs. */
export interface ComplianceScheduleInput {
  id: string;
  assetId: string;
  type: FleetComplianceType;
  /** YYYY-MM-DD. */
  nextDue: string;
  active: boolean;
  /** Booking lead time; drives the "due soon" window. */
  leadTimeDays: number;
  /** The vehicle is available to drive (see module header). */
  inService: boolean;
}

export interface ComplianceStatus extends ComplianceScheduleInput {
  state: ComplianceState;
  /** Whole days from today. Negative = that many days late. */
  daysUntilDue: number;
  severity: BriefingSeverity;
}

const DAY_MS = 86_400_000;

/**
 * Whole calendar days between two YYYY-MM-DD dates (b - a), UTC-anchored so a
 * BST/GMT boundary can never make a date "shift" by one and flip a legal
 * judgement. Returns null when either date is unparseable rather than
 * defaulting to 0 — a silent 0 would read as "due today".
 */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/**
 * Classify one due date against today.
 *
 * THE BOUNDARY, stated once: an MOT certificate is valid THROUGH its expiry
 * date — a test expiring today is legal today and illegal tomorrow. So
 * `nextDue === today` is "due today", NOT overdue. Only a due date strictly in
 * the past is a breach. The same convention holds for insurance and tax, and
 * the unit tests pin all three boundary days (-1, 0, +1).
 */
export function classifyDue(
  nextDueIso: string,
  todayIso: string,
  leadTimeDays: number,
): { state: ComplianceState; daysUntilDue: number } | null {
  const days = daysBetween(todayIso, nextDueIso);
  if (days == null) return null;
  const lead = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? Math.floor(leadTimeDays) : 0;
  if (days < 0) return { state: "overdue", daysUntilDue: days };
  if (days <= lead) return { state: "due_soon", daysUntilDue: days };
  return { state: "ok", daysUntilDue: days };
}

/** Severity for one classified obligation. See the module header for the rule. */
export function complianceSeverity(
  type: FleetComplianceType,
  state: ComplianceState,
  daysUntilDue: number,
  inService: boolean,
): BriefingSeverity {
  if (state === "ok") return "low";
  if (state === "overdue") {
    if (inService && CRITICAL_WHEN_IN_SERVICE.includes(type)) return "critical";
    // Overdue road tax in service, or anything overdue on an off-road vehicle:
    // needs fixing, is not a live breach of the driving offences above.
    return "high";
  }
  // Due soon — proximity only. Capped at "high": nothing upcoming outranks
  // something already in breach.
  return daysUntilDue <= 7 ? "high" : "medium";
}

/** Classify a whole set. Inactive schedules are excluded, never silently "ok". */
export function assessCompliance(
  schedules: readonly ComplianceScheduleInput[],
  todayIso: string,
): ComplianceStatus[] {
  const out: ComplianceStatus[] = [];
  for (const s of schedules) {
    if (!s.active) continue;
    const c = classifyDue(s.nextDue, todayIso, s.leadTimeDays);
    if (!c) continue;
    out.push({
      ...s,
      state: c.state,
      daysUntilDue: c.daysUntilDue,
      severity: complianceSeverity(s.type, c.state, c.daysUntilDue, s.inService),
    });
  }
  // Worst first: overdue before due_soon, and within each the most overdue /
  // soonest first. `id` breaks ties so the order is total and reproducible.
  const rank: Record<ComplianceState, number> = { overdue: 0, due_soon: 1, ok: 2 };
  return out.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      a.daysUntilDue - b.daysUntilDue ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The briefing-facing rollup. Three lines, not thirty: the Daily Briefing is
 * "the few things that need you", so individual vehicles are counted, and the
 * fleet pages carry the detail.
 */
export interface FleetComplianceRollup {
  /** In-service vehicles with an expired MOT or insurance — a live legal breach. */
  legalBreach: { count: number; vehicleCount: number; maxDaysOverdue: number };
  /** Everything else overdue: road tax, service, or a breach on an off-road vehicle. */
  otherOverdue: { count: number; vehicleCount: number; maxDaysOverdue: number };
  /** Inside the booking lead window and not yet late. */
  dueSoon: { count: number; vehicleCount: number; soonestDays: number | null };
}

export function rollupCompliance(statuses: readonly ComplianceStatus[]): FleetComplianceRollup {
  const breachAssets = new Set<string>();
  const otherAssets = new Set<string>();
  const soonAssets = new Set<string>();
  let breachCount = 0;
  let otherCount = 0;
  let soonCount = 0;
  let breachMax = 0;
  let otherMax = 0;
  let soonest: number | null = null;

  for (const s of statuses) {
    if (s.state === "overdue") {
      const late = Math.abs(s.daysUntilDue);
      if (s.severity === "critical") {
        breachCount += 1;
        breachAssets.add(s.assetId);
        breachMax = Math.max(breachMax, late);
      } else {
        otherCount += 1;
        otherAssets.add(s.assetId);
        otherMax = Math.max(otherMax, late);
      }
    } else if (s.state === "due_soon") {
      soonCount += 1;
      soonAssets.add(s.assetId);
      soonest = soonest == null ? s.daysUntilDue : Math.min(soonest, s.daysUntilDue);
    }
  }

  return {
    legalBreach: { count: breachCount, vehicleCount: breachAssets.size, maxDaysOverdue: breachMax },
    otherOverdue: { count: otherCount, vehicleCount: otherAssets.size, maxDaysOverdue: otherMax },
    dueSoon: { count: soonCount, vehicleCount: soonAssets.size, soonestDays: soonest },
  };
}

/** An empty rollup — the shape a failed or absent read degrades to. */
export function emptyComplianceRollup(): FleetComplianceRollup {
  return {
    legalBreach: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
    otherOverdue: { count: 0, vehicleCount: 0, maxDaysOverdue: 0 },
    dueSoon: { count: 0, vehicleCount: 0, soonestDays: null },
  };
}
