import { describe, expect, it } from "vitest";
import { composeAssetTimeline, type AssetTimelineSources } from "@/lib/assets/timeline";

/**
 * Pure-composer proofs for the unified asset timeline (Train J). The render
 * layer sorts newest-first and caps; this module only interleaves + labels, so
 * these tests assert the FOLD, not ordering.
 */

describe("composeAssetTimeline", () => {
  it("returns nothing for empty sources", () => {
    expect(composeAssetTimeline({})).toEqual([]);
  });

  it("emits check-out and return events from a custody row", () => {
    const events = composeAssetTimeline({
      custody: [
        {
          assignment_type: "allocated_to_job",
          assigned_at: "2026-01-01T09:00:00Z",
          actual_return_at: "2026-01-05T17:00:00Z",
          location: "Site A",
        },
      ],
    });
    expect(events).toEqual([
      { at: "2026-01-01T09:00:00Z", kind: "custody", label: "Checked out (allocated to job — Site A)" },
      { at: "2026-01-05T17:00:00Z", kind: "custody", label: "Returned" },
    ]);
  });

  it("omits the return event for an open custody row", () => {
    const events = composeAssetTimeline({
      custody: [
        { assignment_type: "on_hire", assigned_at: "2026-02-01T00:00:00Z", actual_return_at: null, location: null },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ at: "2026-02-01T00:00:00Z", kind: "custody", label: "Checked out (on hire)" });
  });

  it("surfaces only issued / superseded inspections, never drafts", () => {
    const base = { title: "6-monthly LOLER", safety_critical: false, inspected_at: "2026-03-01T00:00:00Z", created_at: "2026-03-01T00:00:00Z" };
    const events = composeAssetTimeline({
      inspections: [
        { ...base, status: "issued", outcome: "pass" },
        { ...base, status: "draft", outcome: null },
        { ...base, status: "superseded", outcome: "pass_with_defects" },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "inspection")).toBe(true);
  });

  it("flags a safety-critical failed inspection as a safety block", () => {
    const events = composeAssetTimeline({
      inspections: [
        {
          title: "Pre-use check",
          status: "issued",
          outcome: "fail",
          safety_critical: true,
          inspected_at: null,
          created_at: "2026-04-01T00:00:00Z",
        },
      ],
    });
    expect(events[0]!.label).toContain("(safety block)");
    // Falls back to created_at when inspected_at is null.
    expect(events[0]!.at).toBe("2026-04-01T00:00:00Z");
  });

  it("emits override recorded + revoked", () => {
    const events = composeAssetTimeline({
      overrides: [{ created_at: "2026-05-01T00:00:00Z", revoked_at: "2026-05-10T00:00:00Z" }],
    });
    expect(events).toEqual([
      { at: "2026-05-01T00:00:00Z", kind: "override", label: "Operational override recorded" },
      { at: "2026-05-10T00:00:00Z", kind: "override", label: "Override revoked" },
    ]);
  });

  it("labels a maintenance case with its status", () => {
    const events = composeAssetTimeline({
      maintenanceCases: [{ title: "Hydraulic hose", status: "in_progress", created_at: "2026-06-01T00:00:00Z" }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("maintenance");
    expect(events[0]!.label).toContain("Hydraulic hose");
  });

  it("emits QR generated for a first identity and revoked for a deliberate revoke", () => {
    const events = composeAssetTimeline({
      qr: [
        { generated_at: "2026-07-01T00:00:00Z", revoked_at: "2026-07-20T00:00:00Z", revocation_reason: null, regenerated_from: null },
      ],
    });
    expect(events).toEqual([
      { at: "2026-07-01T00:00:00Z", kind: "qr", label: "QR identity generated" },
      { at: "2026-07-20T00:00:00Z", kind: "qr", label: "QR identity revoked" },
    ]);
  });

  it("distinguishes a regenerated identity from a fresh one and a supersede from a revoke", () => {
    const events = composeAssetTimeline({
      qr: [
        {
          generated_at: "2026-07-05T00:00:00Z",
          revoked_at: "2026-07-15T00:00:00Z",
          revocation_reason: "regenerated",
          regenerated_from: "00000000-0000-0000-0000-000000000001",
        },
      ],
    });
    expect(events[0]!.label).toBe("QR identity regenerated");
    expect(events[1]!.label).toBe("QR identity superseded (old label retired)");
  });

  it("interleaves every source into one list (count = sum of parts)", () => {
    const sources: AssetTimelineSources = {
      custody: [{ assignment_type: "allocated_to_job", assigned_at: "2026-01-01T00:00:00Z", actual_return_at: null, location: null }],
      inspections: [{ title: "T", status: "issued", outcome: "pass", safety_critical: false, inspected_at: "2026-02-01T00:00:00Z", created_at: "2026-02-01T00:00:00Z" }],
      overrides: [{ created_at: "2026-03-01T00:00:00Z", revoked_at: null }],
      maintenanceCases: [{ title: "M", status: "reported", created_at: "2026-04-01T00:00:00Z" }],
      qr: [{ generated_at: "2026-05-01T00:00:00Z", revoked_at: null, revocation_reason: null, regenerated_from: null }],
    };
    const events = composeAssetTimeline(sources);
    // 1 custody + 1 inspection + 1 override + 1 maintenance + 1 qr = 5.
    expect(events).toHaveLength(5);
    expect(new Set(events.map((e) => e.kind))).toEqual(
      new Set(["custody", "inspection", "override", "maintenance", "qr"]),
    );
  });
});
