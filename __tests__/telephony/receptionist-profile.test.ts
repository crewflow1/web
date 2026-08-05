import { describe, it, expect } from "vitest";
import {
  DEFAULT_GREETING,
  DEFAULT_VAPI_VOICE_ID,
  buildReceptionistContext,
  buildReceptionistGreeting,
  mapPreferredVoiceToVapiVoiceId,
  type ReceptionistProfile,
} from "@/lib/telephony/receptionist-profile";
import { buildVapiAssistantConfig } from "@/lib/telephony/providers/vapi";
import { buildGatherTwiml } from "@/lib/telephony/providers/twilio";

/**
 * Voice Telephony (C35, GAP 5) — the per-org receptionist identity builders.
 *
 * Pure + hermetic (no admin client, no provider). Pins that a configured org
 * yields ITS business name/greeting/voice/context, a missing setup degrades to
 * the GENERIC anonymous behaviour (safe default, unchanged), and that identity
 * data stays DATA — never instructions, and always escaped into TwiML.
 */

const ACE: ReceptionistProfile = {
  businessName: "Ace Plumbing",
  preferredVoice: "female",
  businessHours: "Mon-Fri 8-6",
  tradeType: "Plumbing",
};

describe("buildReceptionistGreeting", () => {
  it("names the business when configured", () => {
    expect(buildReceptionistGreeting(ACE)).toBe(
      "Thank you for calling Ace Plumbing. How can I help you today?",
    );
  });
  it("falls back to the generic greeting with no profile / no name", () => {
    expect(buildReceptionistGreeting(null)).toBe(DEFAULT_GREETING);
    expect(buildReceptionistGreeting({ ...ACE, businessName: null })).toBe(DEFAULT_GREETING);
  });
});

describe("buildReceptionistContext", () => {
  it("assembles name/trade/hours as reference data", () => {
    expect(buildReceptionistContext(ACE)).toBe(
      "Business name: Ace Plumbing. Trade: Plumbing. Business hours: Mon-Fri 8-6",
    );
  });
  it("is null when there is nothing to add (generic fallback)", () => {
    expect(buildReceptionistContext(null)).toBeNull();
    expect(
      buildReceptionistContext({
        businessName: null,
        preferredVoice: null,
        businessHours: null,
        tradeType: null,
      }),
    ).toBeNull();
  });
});

describe("mapPreferredVoiceToVapiVoiceId", () => {
  it("uses a known Vapi voice id verbatim (case-insensitive)", () => {
    expect(mapPreferredVoiceToVapiVoiceId("Kylie")).toBe("Kylie");
    expect(mapPreferredVoiceToVapiVoiceId("paige")).toBe("Paige");
  });
  it("maps gender hints to a sensible default", () => {
    expect(mapPreferredVoiceToVapiVoiceId("female")).toBe("Paige");
    expect(mapPreferredVoiceToVapiVoiceId("male")).toBe("Elliot");
  });
  it("defaults to the generic voice for empty / unknown values", () => {
    expect(mapPreferredVoiceToVapiVoiceId(null)).toBe(DEFAULT_VAPI_VOICE_ID);
    expect(mapPreferredVoiceToVapiVoiceId("   ")).toBe(DEFAULT_VAPI_VOICE_ID);
    expect(mapPreferredVoiceToVapiVoiceId("something odd")).toBe(DEFAULT_VAPI_VOICE_ID);
  });
});

describe("buildVapiAssistantConfig — per-org identity", () => {
  it("threads business name/voice/context into the assistant config", () => {
    const cfg = buildVapiAssistantConfig({
      firstMessage: buildReceptionistGreeting(ACE),
      businessContext: buildReceptionistContext(ACE),
      voiceId: mapPreferredVoiceToVapiVoiceId(ACE.preferredVoice),
    }) as {
      assistant: {
        firstMessage: string;
        voice: { voiceId: string };
        model: { messages: Array<{ role: string; content: string }> };
      };
    };
    expect(cfg.assistant.firstMessage).toContain("Ace Plumbing");
    expect(cfg.assistant.voice.voiceId).toBe("Paige");
    const sys = cfg.assistant.model.messages.find((m) => m.role === "system")!.content;
    expect(sys).toContain("Ace Plumbing");
    // The identity is framed as reference data, NOT instructions (injection-safe).
    expect(sys).toMatch(/not instructions/i);
  });

  it("falls back to the generic anonymous config when unconfigured", () => {
    const cfg = buildVapiAssistantConfig() as {
      assistant: { firstMessage: string; voice: { voiceId: string } };
    };
    expect(cfg.assistant.firstMessage).toBe("Thank you for calling. How can I help you today?");
    expect(cfg.assistant.voice.voiceId).toBe("Elliot");
  });
});

describe("business identity stays DATA in the Twilio greeting", () => {
  it("XML-escapes a business name so it can never break (or inject) the TwiML", () => {
    const evil: ReceptionistProfile = {
      businessName: 'Bob & Sons </Say><Hangup/>',
      preferredVoice: null,
      businessHours: null,
      tradeType: null,
    };
    const twiml = buildGatherTwiml({ prompt: buildReceptionistGreeting(evil) });
    // The injected payload is ESCAPED inside the greeting — it becomes inert text,
    // never live TwiML verbs the caller-facing markup would execute.
    expect(twiml).toContain("&lt;/Say&gt;&lt;Hangup/&gt;");
    expect(twiml).toContain("Bob &amp; Sons");
    // The raw, unescaped injection never appears inside the spoken greeting.
    expect(twiml).not.toContain("Bob & Sons </Say><Hangup/>");
  });
});
