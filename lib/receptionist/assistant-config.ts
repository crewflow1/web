/**
 * Per-organisation Vapi assistant configuration.
 *
 * Pure builder — no I/O, so it's trivially testable. The Vapi webhook
 * calls this with the org's receptionist setup (trade, hours, voice) and
 * returns the object Vapi expects in an `assistant-request` response.
 *
 * The assistant is a RECEPTIONIST: it greets the caller, captures the
 * enquiry, and reassures them. It NEVER quotes prices, books work, or
 * commits the business — the same AI-safety rule enforced in
 * server/services/receptionist.ts. The owner decides; the AI only listens
 * and records.
 */

export type ReceptionistSetup = {
  orgName: string;
  tradeType?: string | null;
  businessHours?: string | null;
  preferredVoice?: string | null;
};

export type VapiAssistantConfig = {
  name: string;
  firstMessage: string;
  model: {
    provider: "anthropic";
    model: string;
    temperature: number;
    messages: { role: "system"; content: string }[];
  };
  voice: { provider: string; voiceId: string };
  transcriber: { provider: string; model: string; language: string };
  endCallPhrases: string[];
};

// Matches the model used by the existing receptionist extraction pipeline.
const RECEPTIONIST_MODEL = "claude-haiku-4-5";
const DEFAULT_VOICE = "Elliot";

export function buildAssistantConfig(
  setup: ReceptionistSetup,
): VapiAssistantConfig {
  const org = setup.orgName?.trim() || "the company";
  const trade = setup.tradeType?.trim();
  const hours = setup.businessHours?.trim();

  const firstMessage = `Hello, you've reached ${org}. I'm the AI receptionist — how can I help you today?`;

  const systemPrompt = [
    `You are the AI receptionist for ${org}${
      trade ? `, a UK ${trade} business` : ", a UK trades business"
    }.`,
    "Your job: greet the caller, understand what they need, and capture their details so the team can call them back.",
    hours ? `Business hours: ${hours}.` : null,
    "Collect, naturally and one question at a time: the caller's name, a contact phone number, their postcode or area, and a short description of the work or problem.",
    "If it sounds like an emergency (leak, flood, no heat, electrical danger, gas), reassure them you'll flag it as urgent.",
    "STRICT RULES — these protect the business:",
    "- NEVER quote a price, give an estimate, or discuss cost.",
    "- NEVER book, schedule, or confirm an appointment, a date, or a time.",
    "- NEVER promise that someone will attend, or commit the business to anything.",
    "- If asked about price or booking, say a team member will confirm that when they call back.",
    "- Keep replies short and natural for a phone conversation.",
    "When you have their details, briefly summarise back to confirm, thank them, and let them know the team will be in touch.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name: `${org} Receptionist`,
    firstMessage,
    model: {
      provider: "anthropic",
      model: RECEPTIONIST_MODEL,
      temperature: 0.3,
      messages: [{ role: "system", content: systemPrompt }],
    },
    voice: {
      provider: "vapi",
      voiceId: setup.preferredVoice?.trim() || DEFAULT_VOICE,
    },
    transcriber: { provider: "deepgram", model: "nova-2", language: "en-GB" },
    endCallPhrases: ["goodbye", "bye", "thanks, bye"],
  };
}
