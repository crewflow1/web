import { describe, it, expect } from "vitest";
import { buildAssistantConfig } from "@/lib/receptionist/assistant-config";

/**
 * Per-org Vapi assistant config.
 *
 * Pins the safety contract (no pricing, no booking, no commitments — the
 * same rule as the existing receptionist pipeline) and that each org gets
 * a personalised greeting, prompt, and voice.
 */

describe("buildAssistantConfig", () => {
  const cfg = buildAssistantConfig({
    orgName: "Acme Roofing",
    tradeType: "roofing",
    businessHours: "Mon–Fri 8am–6pm",
    preferredVoice: "Paige",
  });

  it("uses the Anthropic haiku model that the receptionist pipeline uses", () => {
    expect(cfg.model.provider).toBe("anthropic");
    expect(cfg.model.model).toBe("claude-haiku-4-5");
  });

  it("personalises the greeting and system prompt with the org + trade", () => {
    expect(cfg.firstMessage).toContain("Acme Roofing");
    const system = cfg.model.messages[0]?.content ?? "";
    expect(system).toContain("Acme Roofing");
    expect(system).toMatch(/roofing/i);
    expect(system).toContain("Mon–Fri 8am–6pm");
  });

  it("encodes the hard safety rules: never price, book, or commit", () => {
    const system = (cfg.model.messages[0]?.content ?? "").toLowerCase();
    expect(system).toMatch(/never (quote|give) a price|never.*price/);
    expect(system).toMatch(/never book|never.*appointment/);
    expect(system).toMatch(/never promise|commit the business/);
  });

  it("collects the lead essentials (name, phone, postcode, problem)", () => {
    const system = (cfg.model.messages[0]?.content ?? "").toLowerCase();
    expect(system).toContain("name");
    expect(system).toContain("phone");
    expect(system).toContain("postcode");
  });

  it("uses the org's preferred voice", () => {
    expect(cfg.voice.voiceId).toBe("Paige");
  });

  it("falls back to sane defaults when optional fields are missing", () => {
    const bare = buildAssistantConfig({ orgName: "" });
    expect(bare.firstMessage).toContain("the company");
    expect(bare.voice.voiceId).toBeTruthy(); // default voice
    expect(bare.model.messages[0]?.content ?? "").toMatch(/trades business/i);
  });

  it("transcribes in en-GB (UK-only product)", () => {
    expect(cfg.transcriber.language).toBe("en-GB");
  });
});
