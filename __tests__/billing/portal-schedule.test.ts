import { describe, it, expect } from "vitest";
import { computePortalSchedule, type PortalScheduleInput } from "@/lib/customers/portal-schedule";

const stage = (o: Partial<PortalScheduleInput>): PortalScheduleInput => ({
  name: o.name ?? "Stage",
  amount: o.amount ?? 0,
  vatRate: o.vatRate ?? 20,
  dueDate: o.dueDate ?? null,
  status: o.status ?? "planned",
});

describe("computePortalSchedule (customer-safe)", () => {
  it("maps each stage status to a customer-facing label and grosses up the amount", () => {
    const s = computePortalSchedule({
      stages: [
        stage({ name: "Deposit", amount: 4000, vatRate: 20, status: "paid" }),
        stage({ name: "First fix", amount: 12_000, vatRate: 20, status: "invoiced" }),
        stage({ name: "Second fix", amount: 12_000, vatRate: 20, status: "part_paid" }),
        stage({ name: "On completion", amount: 10_000, vatRate: 20, status: "planned" }),
      ],
    });
    expect(s.stages.map((x) => x.status)).toEqual(["paid", "due", "part_paid", "upcoming"]);
    expect(s.stages[0]?.gross).toBe(4800); // 4000 + 20%
    expect(s.stages[3]?.gross).toBe(12_000); // 10000 + 20%
    expect(s.totalAgreed).toBe(4800 + 14_400 + 14_400 + 12_000);
    expect(s.hasSchedule).toBe(true);
  });

  it("maps an overdue stage invoice to 'overdue'", () => {
    const s = computePortalSchedule({ stages: [stage({ status: "overdue", amount: 1000 })] });
    expect(s.stages[0]?.status).toBe("overdue");
  });

  it("drops zero-amount stages (nothing to pay)", () => {
    const s = computePortalSchedule({ stages: [stage({ name: "Placeholder", amount: 0 })] });
    expect(s.stages).toHaveLength(0);
    expect(s.hasSchedule).toBe(false);
  });

  it("includes a retention line only when some is held, with its release date", () => {
    const withR = computePortalSchedule({
      stages: [stage({ amount: 1000, status: "paid" })],
      retention: { held: 2000, releaseDate: "2027-11-18" },
    });
    expect(withR.retention).toEqual({ held: 2000, releaseDate: "2027-11-18" });

    const noneHeld = computePortalSchedule({ stages: [stage({ amount: 1000 })], retention: { held: 0, releaseDate: null } });
    expect(noneHeld.retention).toBeNull();
  });

  it("only exposes customer-safe fields — no cost, margin, basis or percent", () => {
    const s = computePortalSchedule({ stages: [stage({ name: "Deposit", amount: 4000, status: "invoiced" })] });
    expect(Object.keys(s.stages[0]!).sort()).toEqual(["dueDate", "gross", "name", "status"]);
  });
});
