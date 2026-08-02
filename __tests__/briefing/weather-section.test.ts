import { describe, expect, it } from "vitest";
import {
  composeWeatherSection,
  type WeatherBriefingInput,
} from "@/lib/briefing/compose";

/**
 * Briefing weather section (pure). The honesty rule: it renders real readings
 * when present and an explicit "not available" line otherwise, and it NEVER
 * states conditions are clear unless jobs were actually assessed against data.
 */

function input(overrides: Partial<WeatherBriefingInput> = {}): WeatherBriefingInput {
  return {
    available: false,
    statusLine: "not connected",
    assessedJobs: 0,
    insufficientJobs: 0,
    risks: [],
    ...overrides,
  };
}

describe("composeWeatherSection", () => {
  it("DARK: not connected ⇒ unavailable, and the line explicitly denies it is an all-clear", () => {
    const s = composeWeatherSection(input({ available: false }));
    expect(s.status).toBe("unavailable");
    expect(s.line).toMatch(/not connected/i);
    expect(s.line).toMatch(/not a report that conditions are clear/i);
    expect(s.risks).toEqual([]);
  });

  it("ACTIVE but no readings yet ⇒ unavailable, still not a green all-clear", () => {
    const s = composeWeatherSection(input({ available: true, assessedJobs: 0 }));
    expect(s.status).toBe("unavailable");
    expect(s.line).not.toMatch(/no weather stoppages/i);
  });

  it("ACTIVE with real readings and no risk ⇒ a legitimate clear line naming the count", () => {
    const s = composeWeatherSection(input({ available: true, assessedJobs: 5 }));
    expect(s.status).toBe("clear");
    expect(s.line).toMatch(/5 scheduled jobs/i);
    expect(s.line).toMatch(/no weather stoppages/i);
  });

  it("ACTIVE with a blocking risk ⇒ a risk line that leads with the stoppage count", () => {
    const s = composeWeatherSection(
      input({
        available: true,
        assessedJobs: 4,
        risks: [
          { label: "Acme", day: "2026-07-10", district: "LS1", verdict: "not_viable", conditions: ["Gusts too high"] },
          { label: "Beta", day: "2026-07-11", district: "LS2", verdict: "caution", conditions: ["Marginal"] },
        ],
      }),
    );
    expect(s.status).toBe("risk");
    expect(s.line).toMatch(/1 scheduled job faces conditions that would stop/i);
    expect(s.risks).toHaveLength(2);
  });

  it("a clear line discloses jobs that could not be checked rather than hiding them", () => {
    const s = composeWeatherSection(input({ available: true, assessedJobs: 3, insufficientJobs: 2 }));
    expect(s.status).toBe("clear");
    expect(s.line).toMatch(/2 more had no reading/i);
  });
});
