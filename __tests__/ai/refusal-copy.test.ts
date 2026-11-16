import { describe, it, expect } from "vitest";
import { aiRefusalMessage } from "@/lib/ai/governor/refusal-copy";

/**
 * The refusal copy a governed surface shows must state the TRUE reason. Only an
 * org-ceiling refusal may show the org's spend/ceiling figures; a CrewFlow-wide,
 * per-employee, rate-limit or infrastructure refusal must not claim the
 * company's budget is used up (the old quote-writer copy showed
 * "used up (£0.00 of £100.00)" for all of them).
 */
const FIG = { spentPence: 10, ceilingPence: 10_000 };
const FALLBACK = "Write the quote as usual.";

describe("aiRefusalMessage", () => {
  it("org ceiling: says the company budget is used up, with the figures, then the fallback", () => {
    const m = aiRefusalMessage("ceiling", { spentPence: 9_990, ceilingPence: 10_000 }, FALLBACK);
    expect(m).toMatch(/^Your company's AI budget for this month is used up \(£99\.90 of £100\.00\)\./);
    expect(m.endsWith(FALLBACK)).toBe(true);
  });

  it.each(["platform_ceiling", "employee_limit", "rate_limited", "reservation_unavailable", "tier_dark_provider_live", "something_new", null])(
    "%s: never claims the company budget is used up and never shows the org figures",
    (reason) => {
      const m = aiRefusalMessage(reason, FIG, FALLBACK);
      expect(m).not.toMatch(/budget for this month is used up/);
      expect(m).not.toMatch(/£0\.10|£100\.00/);
      expect(m.endsWith(FALLBACK)).toBe(true);
    },
  );

  it("CrewFlow-wide refusal says AI is paused across CrewFlow", () => {
    expect(aiRefusalMessage("platform_ceiling", FIG, "")).toBe(
      "AI features are paused across CrewFlow for the rest of this month. CrewFlow has been alerted.",
    );
  });

  it("an unknown reason gets the neutral message", () => {
    expect(aiRefusalMessage("x", FIG, FALLBACK)).toBe(`AI is temporarily unavailable. ${FALLBACK}`);
  });
});

describe("ai_disabled (per-company AI off switch)", () => {
  it("says AI is switched off and where to change it, never a budget claim", async () => {
    const { aiRefusalMessage } = await import("@/lib/ai/governor/refusal-copy");
    const msg = aiRefusalMessage("ai_disabled", { spentPence: 10, ceilingPence: 10000 }, "Write it as usual.");
    expect(msg).toContain("switched off for your company");
    expect(msg).toContain("Settings");
    expect(msg).not.toMatch(/budget|£/i);
    expect(msg.endsWith("Write it as usual.")).toBe(true);
  });
});
