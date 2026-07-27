import { z } from "zod";
import type { InspectionOutcome, InspectionStatus } from "@/lib/assets/inspection";

/**
 * Asset Management — Milestone 4d: safety-override domain (pure).
 *
 * The DB (20261001) owns the invariants (one live override per fail, immutable
 * audit record, write-once revocation, target validation) and the custody
 * guard's three-arm clearing predicate. THIS module mirrors that predicate for
 * the UI (unit-tested so the two can never drift), validates inputs and
 * translates errors. Callers pass the clock (house style) — no Date.now here.
 */

export type OverrideRow = {
  id: string;
  inspection_id: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
};

/** Live = un-revoked and un-expired at `nowIso` (the guard's arm-3 predicate). */
export function isOverrideActive(
  o: { revoked_at: string | null; expires_at: string | null },
  nowIso: string,
): boolean {
  if (o.revoked_at != null) return false;
  return o.expires_at == null || o.expires_at > nowIso;
}

export type BlockableInspection = {
  id: string;
  title: string;
  status: InspectionStatus;
  outcome: InspectionOutcome | null;
  safety_critical: boolean;
  inspected_at: string | null;
  created_at: string;
  reinspection_of: string | null;
};

export type SafetyBlock = {
  inspection: BlockableInspection;
  /** The live override bypassing this fail right now, if any. */
  activeOverride: OverrideRow | null;
};

/**
 * The UI mirror of the DB clearing predicate (asset_inspection_fail_is_cleared):
 * a fail blocks unless (1) an issued safety-critical pass is EXPLICITLY linked
 * to it, or (2) a LATER issued safety-critical pass exists (M4c fallback).
 * Arm 3 (an active override) doesn't clear the block — it bypasses it, so the
 * fail is still returned WITH its override for honest display ("operational
 * override recorded", never "cleared").
 */
export function currentSafetyBlocks(
  inspections: BlockableInspection[],
  overrides: OverrideRow[],
  nowIso: string,
): SafetyBlock[] {
  const at = (i: BlockableInspection) => i.inspected_at ?? i.created_at;
  const passes = inspections.filter(
    (i) =>
      i.safety_critical &&
      i.status === "issued" &&
      (i.outcome === "pass" || i.outcome === "pass_with_defects"),
  );

  return inspections
    .filter((i) => i.safety_critical && i.status === "issued" && i.outcome === "fail")
    .filter((f) => !passes.some((p) => p.reinspection_of === f.id)) // arm 1
    .filter((f) => !passes.some((p) => at(p) > at(f))) // arm 2 (M4c fallback)
    .map((f) => ({
      inspection: f,
      activeOverride:
        overrides.find((o) => o.inspection_id === f.id && isOverrideActive(o, nowIso)) ?? null,
    }));
}

/** Does anything actually stop issue right now? (blocks with no live override) */
export function hasUnbypassedBlock(blocks: SafetyBlock[]): boolean {
  return blocks.some((b) => b.activeOverride == null);
}

// ── Validation ────────────────────────────────────────────────────────────────
const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const createOverrideSchema = z.object({
  asset_id: z.string().uuid(),
  inspection_id: z.string().uuid(),
  reason: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .min(10, "Give a real reason (at least 10 characters)")
      .max(2000),
  ),
  expires_at: z.preprocess(blankToUndefined, z.string().datetime().optional()),
});
export type CreateOverrideInput = z.infer<typeof createOverrideSchema>;

export const revokeOverrideSchema = z.object({
  override_id: z.string().uuid(),
  revoke_reason: z.preprocess(blankToUndefined, z.string().trim().max(2000).optional()),
});

// ── Error translation ─────────────────────────────────────────────────────────
export function friendlyOverrideError(
  code: string | undefined,
  message: string | undefined,
): string {
  if (code === "23505") {
    return "That inspection already has a live override. Revoke it before recording a new one.";
  }
  if (code === "23503") return "That inspection no longer exists.";
  if (code === "23514" || code === "check_violation") {
    if (message && /not an issued safety-critical fail/.test(message)) {
      return "Overrides apply only to a current failed safety inspection.";
    }
    if (message && /not in org|not for asset/.test(message)) {
      return "That inspection isn't on this asset.";
    }
    if (message && /immutable|revoked and can no longer change/.test(message)) {
      return "An override can't be edited — revoke it and record a new one.";
    }
    return "That override isn't allowed.";
  }
  return "Couldn't save the override. Try again.";
}
