import { describe, expect, it } from "vitest";
import {
  computeStaffPerformance,
  MIN_ONTIME_SAMPLE,
  type PerformanceJobRow,
} from "@/lib/staff/performance";
import {
  qualificationExpiryStatus,
  daysUntil,
  addDaysIso,
  staffQualificationFormSchema,
  QUALIFICATION_TYPES,
} from "@/lib/staff/qualifications";

/**
 * Staff performance read-model + qualification expiry classifier — pure logic.
 * Every figure is exact arithmetic over records, and the module refuses to
 * invent an on-time verdict it cannot evidence.
 */

function job(over: Partial<PerformanceJobRow> & { id: string }): PerformanceJobRow {
  return {
    id: over.id,
    status: over.status ?? "completed",
    scheduled_date: over.scheduled_date ?? null,
    scheduled_end_date: over.scheduled_end_date ?? null,
    practical_completion_date: over.practical_completion_date ?? null,
  };
}

describe("computeStaffPerformance — jobs", () => {
  it("counts assigned, completed and classifies on-time vs late", () => {
    const jobs: PerformanceJobRow[] = [
      job({ id: "a", scheduled_end_date: "2026-06-10", practical_completion_date: "2026-06-09" }), // on time
      job({ id: "b", scheduled_end_date: "2026-06-10", practical_completion_date: "2026-06-10" }), // on time (same day)
      job({ id: "c", scheduled_end_date: "2026-06-10", practical_completion_date: "2026-06-15" }), // late
      job({ id: "d", status: "in-progress" }), // not completed
    ];
    const p = computeStaffPerformance({ jobs, ncrs: [], recordedHours: 0, rosteredHours: 0, windowDays: 90 });
    expect(p.jobs.assigned).toBe(4);
    expect(p.jobs.completed).toBe(3);
    expect(p.jobs.measurable).toBe(3);
    expect(p.jobs.onTime).toBe(2);
    expect(p.jobs.late).toBe(1);
    expect(p.jobs.onTimeRate).toBe(67); // round(2/3*100)
    expect(p.jobs.onTimeRated).toBe(true);
  });

  it("falls back to scheduled_date when no scheduled_end_date is set", () => {
    const p = computeStaffPerformance({
      jobs: [
        job({ id: "a", scheduled_date: "2026-06-10", practical_completion_date: "2026-06-12" }),
      ],
      ncrs: [],
      recordedHours: 0,
      rosteredHours: 0,
      windowDays: 90,
    });
    expect(p.jobs.measurable).toBe(1);
    expect(p.jobs.late).toBe(1);
  });

  it("never judges a completed job that lacks a target or a completion date", () => {
    const jobs = [
      job({ id: "a", scheduled_end_date: "2026-06-10" }), // no completion date
      job({ id: "b", practical_completion_date: "2026-06-10" }), // no target
    ];
    const p = computeStaffPerformance({ jobs, ncrs: [], recordedHours: 0, rosteredHours: 0, windowDays: 90 });
    expect(p.jobs.completed).toBe(2);
    expect(p.jobs.measurable).toBe(0);
    expect(p.jobs.notMeasurable).toBe(2);
    expect(p.jobs.onTime).toBe(0);
    expect(p.jobs.late).toBe(0);
  });

  it("withholds the on-time rate below the sample floor", () => {
    const jobs = Array.from({ length: MIN_ONTIME_SAMPLE - 1 }, (_, i) =>
      job({ id: `j${i}`, scheduled_end_date: "2026-06-10", practical_completion_date: "2026-06-09" }),
    );
    const p = computeStaffPerformance({ jobs, ncrs: [], recordedHours: 0, rosteredHours: 0, windowDays: 90 });
    expect(p.jobs.measurable).toBe(MIN_ONTIME_SAMPLE - 1);
    expect(p.jobs.onTimeRate).toBeNull();
    expect(p.jobs.onTimeRated).toBe(false);
  });
});

describe("computeStaffPerformance — quality + utilisation", () => {
  it("splits open vs total responsible NCRs by status", () => {
    const ncrs = [
      { status: "open" },
      { status: "corrective_action_proposed" },
      { status: "closed" },
      { status: "cancelled" },
      { status: "completed" },
    ];
    const p = computeStaffPerformance({ jobs: [], ncrs, recordedHours: 0, rosteredHours: 0, windowDays: 90 });
    expect(p.quality.responsibleTotal).toBe(5);
    expect(p.quality.responsibleOpen).toBe(2);
  });

  it("computes coverage and withholds the % below the rostered-hours floor", () => {
    const rated = computeStaffPerformance({ jobs: [], ncrs: [], recordedHours: 30, rosteredHours: 40, windowDays: 90 });
    expect(rated.utilisation.coverage.pct).toBe(75);
    const tooSmall = computeStaffPerformance({ jobs: [], ncrs: [], recordedHours: 2, rosteredHours: 3, windowDays: 90 });
    expect(tooSmall.utilisation.coverage.pct).toBeNull();
    expect(tooSmall.utilisation.coverage.recorded).toBe(2);
  });
});

describe("qualificationExpiryStatus", () => {
  const today = "2026-08-15";
  it("classifies expired / expiring / valid / no_expiry", () => {
    expect(qualificationExpiryStatus("2026-08-14", today)).toBe("expired");
    expect(qualificationExpiryStatus("2026-08-15", today)).toBe("expiring"); // today = 0 days
    expect(qualificationExpiryStatus("2026-09-10", today)).toBe("expiring"); // within 30d
    expect(qualificationExpiryStatus("2026-12-01", today)).toBe("valid");
    expect(qualificationExpiryStatus(null, today)).toBe("no_expiry");
    expect(qualificationExpiryStatus("", today)).toBe("no_expiry");
  });

  it("daysUntil + addDaysIso are consistent UTC calendar arithmetic", () => {
    expect(daysUntil("2026-08-20", today)).toBe(5);
    expect(daysUntil("2026-08-10", today)).toBe(-5);
    expect(addDaysIso(today, 30)).toBe("2026-09-14");
  });
});

describe("staffQualificationFormSchema", () => {
  it("accepts a minimal valid entry and normalises blanks to null", () => {
    const r = staffQualificationFormSchema.safeParse({
      qualification_type: "cscs",
      title: "CSCS Blue",
      reference_no: "",
      issued_on: "",
      expires_on: "",
      notes: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reference_no).toBeNull();
      expect(r.data.issued_on).toBeNull();
      expect(r.data.expires_on).toBeNull();
      expect(r.data.notes).toBeNull();
    }
  });

  it("rejects an unknown type and an expiry before issue", () => {
    expect(
      staffQualificationFormSchema.safeParse({ qualification_type: "wizardry", title: "x" }).success,
    ).toBe(false);
    const bad = staffQualificationFormSchema.safeParse({
      qualification_type: "cscs",
      title: "x",
      issued_on: "2026-06-10",
      expires_on: "2026-06-01",
    });
    expect(bad.success).toBe(false);
  });

  it("its type vocabulary is the shared constant", () => {
    expect(QUALIFICATION_TYPES).toContain("cscs");
    expect(QUALIFICATION_TYPES).toContain("other");
  });
});
