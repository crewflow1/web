import { describe, it, expect } from "vitest";
import { summariseBriefing } from "@/lib/briefing/narrative";
import type { BriefingItem } from "@/lib/briefing/types";

const item = (key: string, title: string): BriefingItem => ({
  key,
  category: "money",
  severity: "high",
  title,
  detail: "…",
  amount: null,
  count: null,
  href: "/x",
  score: 1,
});

describe("summariseBriefing", () => {
  it("greets by time of day", () => {
    expect(summariseBriefing([], new Date("2026-07-26T09:00:00")).greeting).toBe("Good morning");
    expect(summariseBriefing([], new Date("2026-07-26T14:00:00")).greeting).toBe("Good afternoon");
    expect(summariseBriefing([], new Date("2026-07-26T20:00:00")).greeting).toBe("Good evening");
  });

  it("is a calm all-clear when nothing needs attention", () => {
    const s = summariseBriefing([], new Date("2026-07-26T09:00:00"));
    expect(s.headline).toMatch(/all caught up/i);
    expect(s.lead).toBeNull();
  });

  it("counts the items and points at the most urgent (items[0])", () => {
    const s = summariseBriefing(
      [item("overdue_invoices", "£18,400 overdue"), item("leads_cold", "2 leads")],
      new Date("2026-07-26T09:00:00"),
    );
    expect(s.headline).toBe("2 things need your attention today.");
    expect(s.lead).toBe("Start with: £18,400 overdue.");
  });

  it("uses the singular for one item", () => {
    const s = summariseBriefing([item("overdue_invoices", "£500 overdue")], new Date("2026-07-26T09:00:00"));
    expect(s.headline).toBe("1 thing needs your attention today.");
  });
});
