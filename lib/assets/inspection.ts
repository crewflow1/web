import { z } from "zod";

/**
 * Asset Management — Milestone 4a: inspection domain (pure).
 *
 * Imported by the server actions AND unit-tested directly. The DB CHECK
 * constraints + triggers in 20260927000000_asset_inspections.sql are the source
 * of truth; these mirror them. As with Site Reports, the DB enforces the
 * IMMUTABILITY of substance and this module enforces the STATE MACHINE.
 */

// ── Status ─────────────────────────────────────────────────────────────────────
export const INSPECTION_STATUSES = ["draft", "issued", "superseded", "archived"] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const INSPECTION_STATUS_LABELS: Record<InspectionStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  superseded: "Superseded",
  archived: "Archived",
};

// ── Outcome (the safety signal) ────────────────────────────────────────────────
export const INSPECTION_OUTCOMES = ["pass", "pass_with_defects", "fail"] as const;
export type InspectionOutcome = (typeof INSPECTION_OUTCOMES)[number];

export const INSPECTION_OUTCOME_LABELS: Record<InspectionOutcome, string> = {
  pass: "Pass",
  pass_with_defects: "Pass with defects",
  fail: "Fail",
};

// ── Kind ───────────────────────────────────────────────────────────────────────
export const INSPECTION_KINDS = [
  "pre_use",
  "loler",
  "puwer",
  "pat",
  "service",
  "safety",
  "other",
] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];

export const INSPECTION_KIND_LABELS: Record<InspectionKind, string> = {
  pre_use: "Pre-use check",
  loler: "LOLER",
  puwer: "PUWER",
  pat: "PAT",
  service: "Service",
  safety: "Safety",
  other: "Other",
};

// ── State machine ──────────────────────────────────────────────────────────────
// draft is the only editable state; issue freezes the record; a later inspection
// supersedes it; anything can be archived. Terminal states never transition back.
const TRANSITIONS: Record<InspectionStatus, readonly InspectionStatus[]> = {
  draft: ["issued", "archived"],
  issued: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

export function canTransition(from: InspectionStatus, to: InspectionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws `invalid_transition:<from>-><to>` when illegal (mirrors site-reports). */
export function assertTransition(from: InspectionStatus, to: InspectionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid_transition:${from}->${to}`);
  }
}

export function isEditable(status: InspectionStatus): boolean {
  return status === "draft";
}
export function isIssued(status: InspectionStatus): boolean {
  return status === "issued";
}
export function isTerminal(status: InspectionStatus): boolean {
  return status === "superseded" || status === "archived";
}

/**
 * THE SAFETY PREDICATE. A CURRENT (issued, not-yet-superseded) safety-critical
 * FAIL makes an asset unsafe to issue. The M4b DB guard trigger enforces this
 * server-side against the custody eligibility seam; this pure mirror gates the
 * UI and is unit-tested so the two can never silently drift.
 */
export function isSafetyBlocking(inspection: {
  safety_critical: boolean;
  status: InspectionStatus;
  outcome: InspectionOutcome | null;
}): boolean {
  return (
    inspection.safety_critical === true &&
    inspection.status === "issued" &&
    inspection.outcome === "fail"
  );
}

/** An issued inspection is only meaningful with an outcome (the DB requires it). */
export function issueRequiresOutcome(outcome: InspectionOutcome | null | undefined): outcome is InspectionOutcome {
  return outcome != null && (INSPECTION_OUTCOMES as readonly string[]).includes(outcome);
}

// ── Input validation ───────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optText = (max = 2000) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

/** Create a draft inspection against an asset. */
export const createInspectionSchema = z.object({
  asset_id: z.string().uuid(),
  title: z.preprocess(blankToUndefined, z.string().trim().min(1, "A title is required").max(200)),
  kind: z.preprocess(blankToUndefined, z.enum(INSPECTION_KINDS).optional()),
  safety_critical: z.coerce.boolean().default(false),
  notes: optText(),
  due_at: z.preprocess(blankToUndefined, z.string().datetime().optional()),
  /** M4d lineage: the failed inspection this one re-inspects (clears exactly it). */
  reinspection_of: z.preprocess(blankToUndefined, z.string().uuid().optional()),
});
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>;

/** Issue a draft — the outcome is mandatory here (freezes the record). */
export const issueInspectionSchema = z.object({
  outcome: z.enum(INSPECTION_OUTCOMES),
  inspected_at: z.preprocess(blankToUndefined, z.string().datetime().optional()),
  notes: optText(),
});
export type IssueInspectionInput = z.infer<typeof issueInspectionSchema>;

/**
 * The frozen record, materialised from the draft `content` + resolved meta at
 * issue time. Pure — the caller passes `issuedAt`, so no clock/IO here (mirrors
 * site-reports `materializeSnapshot`).
 */
export type InspectionSnapshot = {
  title: string;
  kind: InspectionKind | null;
  safety_critical: boolean;
  outcome: InspectionOutcome;
  content: Record<string, unknown>;
  asset: { id: string; name: string; asset_ref: string | null };
  inspected_at: string | null;
  issued_at: string;
  /** M4d: lineage is part of the frozen record. */
  reinspection_of: string | null;
};

export function materializeInspectionSnapshot(input: {
  title: string;
  kind: InspectionKind | null;
  safety_critical: boolean;
  outcome: InspectionOutcome;
  content: Record<string, unknown>;
  asset: { id: string; name: string; asset_ref: string | null };
  inspected_at: string | null;
  issuedAt: string;
  reinspection_of?: string | null;
}): InspectionSnapshot {
  return {
    title: input.title,
    kind: input.kind,
    safety_critical: input.safety_critical,
    outcome: input.outcome,
    content: input.content ?? {},
    asset: input.asset,
    inspected_at: input.inspected_at,
    issued_at: input.issuedAt,
    reinspection_of: input.reinspection_of ?? null,
  };
}
