import { describe, it, expect } from "vitest";
import { maybeGenerateVoiceTurn } from "@/lib/telephony/ai-turn";
import { isInferenceTierActivated } from "@/lib/ai/governor/readiness";

/**
 * The voice AI turn seam is DARK: no generative tier is bound in this build, so
 * it returns null before the governor is reached. A caller hears the
 * deterministic TwiML. This is the whole "wiring the governor changed nothing"
 * property — a credential cannot make it speak; only a bound tier can.
 */

describe("maybeGenerateVoiceTurn — dark", () => {
  it("the build really is dark (otherwise the assertions are vacuous)", () => {
    expect(isInferenceTierActivated()).toBe(false);
  });

  it("returns null when no tier is bound", async () => {
    const out = await maybeGenerateVoiceTurn({
      orgId: "ORG-1",
      transcript: "Hi, my boiler is leaking",
    });
    expect(out).toBeNull();
  });

  it("returns null for an empty transcript", async () => {
    const out = await maybeGenerateVoiceTurn({ orgId: "ORG-1", transcript: "   " });
    expect(out).toBeNull();
  });
});
