import { describe, it, expect } from "vitest";
import {
  FLEET_COMPLIANCE_TYPES,
  LEGAL_COMPLIANCE_TYPES,
} from "@/lib/fleet/compliance";
import {
  COMPLIANCE_MAINTENANCE_TYPES,
  MAINTENANCE_TYPE_LABELS,
  SCHEDULABLE_MAINTENANCE_TYPES,
} from "@/lib/assets/maintenance";

/**
 * The drift guard for the tyres class.
 *
 * There are TWO parallel constant sets describing fleet compliance obligations:
 *   - lib/fleet/compliance.ts FLEET_COMPLIANCE_TYPES — what the fleet board
 *     tracks and classifies (mot, insurance, road_tax, service, tyres).
 *   - lib/assets/maintenance.ts COMPLIANCE_MAINTENANCE_TYPES — the subset the
 *     asset-maintenance GENERATOR keys `isCompliance` off to pick the fleet deep
 *     link + high priority + fleet copy.
 *
 * When tyres was first added it was widened in the fleet set only; the generator
 * set was missed, so a cron-generated tyre reminder silently degraded to generic
 * workshop treatment (medium priority, /assets link, blank label). These
 * assertions tie the two sets together so a FUTURE addition to
 * FLEET_COMPLIANCE_TYPES can't ship without a deliberate decision here — the
 * exact regression that slipped through, made impossible to repeat.
 *
 * The invariant, stated once: the generator's compliance set is the fleet set
 * MINUS 'service' (service is a genuine workshop booking, not a fleet-link /
 * high-priority obligation), and every generatable compliance type must carry a
 * human label.
 */
describe("fleet compliance constant parity (tyres drift guard)", () => {
  const SERVICE_IS_GENERIC = "service";

  it("COMPLIANCE_MAINTENANCE_TYPES == FLEET_COMPLIANCE_TYPES minus 'service'", () => {
    const expected = FLEET_COMPLIANCE_TYPES.filter((t) => t !== SERVICE_IS_GENERIC).sort();
    const actual = [...COMPLIANCE_MAINTENANCE_TYPES].sort();
    expect(actual).toEqual(expected);
  });

  it("every generator compliance type is also a fleet compliance type", () => {
    for (const t of COMPLIANCE_MAINTENANCE_TYPES) {
      expect(FLEET_COMPLIANCE_TYPES as readonly string[]).toContain(t);
    }
  });

  it("every generatable compliance type has a non-empty maintenance label", () => {
    // The generator titles a compliance case `${MAINTENANCE_TYPE_LABELS[type]} due`
    // — a missing key rendered a blank/lowercase label pre-fix.
    for (const t of COMPLIANCE_MAINTENANCE_TYPES) {
      const label = MAINTENANCE_TYPE_LABELS[t];
      expect(label, `missing label for compliance type ${t}`).toBeTruthy();
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("every schedulable maintenance type has a label (Record completeness)", () => {
    for (const t of SCHEDULABLE_MAINTENANCE_TYPES) {
      expect(MAINTENANCE_TYPE_LABELS[t], `missing label for ${t}`).toBeTruthy();
    }
  });

  it("tyres is compliance but NOT a legal offence (severity carve-out holds)", () => {
    // The generator's offence wording keys off LEGAL_COMPLIANCE_TYPES; tyres must
    // stay out of it so the "driving is an offence" line never applies to a
    // missed tyre check, while still getting fleet compliance treatment.
    expect(COMPLIANCE_MAINTENANCE_TYPES as readonly string[]).toContain("tyres");
    expect(LEGAL_COMPLIANCE_TYPES as readonly string[]).not.toContain("tyres");
  });
});
