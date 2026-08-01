import { describe, expect, it } from "vitest";
import {
  computeDueReminders,
  REMINDER_LEAD_DAYS,
  type LoggedReminder,
  type WarrantyForReminder,
} from "@/lib/maintenance/reminders";

/**
 * Maintenance-reminder PURE-layer unit tests (Phase 7).
 *
 * These prove the WHAT-is-due logic without a database, an email, or the wall
 * clock — `today` is injected in every case. The DARK guarantee (nothing is
 * sent while the flag is off) is a SERVICE-layer property, proven separately in
 * the integration + security tiers; this file proves the cadence, the
 * idempotency, and that the pure layer is exactly that — pure.
 */

// A warranty whose completion certificate was issued on 2025-01-15, running 24
// months, serviced every 12 months. Service occurrences fall on 2026-01-15 and
// 2026-... (capped at expiry 2027-01-15). Expiry is 2027-01-15.
function baseWarranty(over: Partial<WarrantyForReminder> = {}): WarrantyForReminder {
  return {
    warrantyId: "w1",
    orgId: "org1",
    jobId: "job1",
    periodMonths: 24,
    serviceIntervalMonths: 12,
    certificateCompletionDate: "2025-01-15",
    ...over,
  };
}

describe("computeDueReminders — cadence", () => {
  it("the default lead-time cadence is 30 days, documented as the config seam", () => {
    expect(REMINDER_LEAD_DAYS).toBe(30);
  });

  it("a service occurrence is DUE once today is within the lead window", () => {
    // First service is 2026-01-15. 30 days before = 2025-12-16.
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing: [],
      today: "2025-12-20", // 26 days before the 2026-01-15 service
    });
    const service = due.filter((d) => d.kind === "service");
    expect(service).toHaveLength(1);
    expect(service[0]?.dueDate).toBe("2026-01-15");
    expect(service[0]?.scheduledFor).toBe("2025-12-16"); // due − 30 days
    expect(service[0]?.channel).toBe("email");
    expect(service[0]?.orgId).toBe("org1");
  });

  it("nothing is due BEFORE the lead window opens", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing: [],
      today: "2025-12-10", // 36 days before the 2026-01-15 service — outside 30d
    });
    expect(due.filter((d) => d.dueDate === "2026-01-15")).toHaveLength(0);
  });

  it("an OVERDUE occurrence (past its due date) is not re-reminded", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing: [],
      today: "2026-01-20", // 5 days AFTER the 2026-01-15 service
    });
    expect(due.filter((d) => d.dueDate === "2026-01-15")).toHaveLength(0);
  });

  it("a custom leadDays override moves the whole window", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing: [],
      today: "2025-11-20", // 56 days before — outside 30d, inside 60d
      leadDays: 60,
    });
    expect(due.filter((d) => d.dueDate === "2026-01-15")).toHaveLength(1);
  });

  it("the warranty EXPIRY produces its own reminder inside the window", () => {
    // Expiry 2027-01-15. 20 days before.
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing: [],
      today: "2026-12-28",
    });
    const expiry = due.filter((d) => d.kind === "expiry");
    expect(expiry).toHaveLength(1);
    expect(expiry[0]?.dueDate).toBe("2027-01-15");
  });
});

describe("computeDueReminders — no honest clock ⇒ no reminders", () => {
  it("a warranty with no completion certificate yields nothing", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty({ certificateCompletionDate: null })],
      existing: [],
      today: "2025-12-20",
    });
    expect(due).toHaveLength(0);
  });

  it("a voided warranty yields nothing", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty({ voided: true })],
      existing: [],
      today: "2025-12-20",
    });
    expect(due).toHaveLength(0);
  });

  it("a warranty with no service interval yields no service reminders", () => {
    const due = computeDueReminders({
      warranties: [baseWarranty({ serviceIntervalMonths: null })],
      existing: [],
      today: "2025-12-20",
    });
    expect(due.filter((d) => d.kind === "service")).toHaveLength(0);
  });
});

describe("computeDueReminders — idempotency / no duplicates", () => {
  it("a reminder already logged is NOT produced again", () => {
    const existing: LoggedReminder[] = [
      { warrantyId: "w1", kind: "service", dueDate: "2026-01-15" },
    ];
    const due = computeDueReminders({
      warranties: [baseWarranty()],
      existing,
      today: "2025-12-20",
    });
    expect(due.filter((d) => d.dueDate === "2026-01-15" && d.kind === "service")).toHaveLength(0);
  });

  it("running twice, feeding the first run's output back as existing, converges", () => {
    const w = [baseWarranty()];
    const first = computeDueReminders({ warranties: w, existing: [], today: "2025-12-20" });
    expect(first.length).toBeGreaterThan(0);

    const asLogged: LoggedReminder[] = first.map((d) => ({
      warrantyId: d.warrantyId,
      kind: d.kind,
      dueDate: d.dueDate,
    }));
    const second = computeDueReminders({ warranties: w, existing: asLogged, today: "2025-12-20" });
    expect(second).toHaveLength(0); // nothing new — idempotent
  });

  it("does not emit the same (warranty, kind, due) twice within a single run", () => {
    // Two identical warranties would each try to log the same key only if they
    // shared an id; distinct ids each get their own reminder (the real case).
    const due = computeDueReminders({
      warranties: [baseWarranty({ warrantyId: "w1" }), baseWarranty({ warrantyId: "w2" })],
      existing: [],
      today: "2025-12-20",
    });
    const w1 = due.filter((d) => d.warrantyId === "w1" && d.kind === "service");
    const w2 = due.filter((d) => d.warrantyId === "w2" && d.kind === "service");
    expect(w1).toHaveLength(1);
    expect(w2).toHaveLength(1);
  });
});

describe("computeDueReminders — purity", () => {
  it("is a pure function: identical inputs give identical, clock-independent output", () => {
    const a = computeDueReminders({ warranties: [baseWarranty()], existing: [], today: "2025-12-20" });
    const b = computeDueReminders({ warranties: [baseWarranty()], existing: [], today: "2025-12-20" });
    expect(a).toEqual(b);
  });
});
