import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INBOX_CHANNELS,
  isInboxChannel,
  inboxChannelForEnquiry,
  transportForInboxChannel,
  canSendOnChannel,
} from "@/lib/inbox/channels";

/**
 * P3 Inbox — channel vocabulary + mapping pins. The TypeScript mapping
 * `inboxChannelForEnquiry` MUST agree with the SQL `inbox_channel_for_enquiry`
 * (projection migration), or an enquiry would land on a different inbox channel
 * than the trigger recorded it under. Also pins the outbound-transport rules.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = readFileSync(
  resolve(ROOT, "supabase/migrations/20261135000001_inbound_enquiry_inbox_projection.sql"),
  "utf8",
);

describe("inbox channel vocabulary", () => {
  it("is exactly the five canonical channels", () => {
    expect([...INBOX_CHANNELS]).toEqual(["email", "sms", "whatsapp", "voice", "chat"]);
  });

  it("narrows only known channels", () => {
    expect(isInboxChannel("email")).toBe(true);
    expect(isInboxChannel("phone")).toBe(false);
    expect(isInboxChannel(null)).toBe(false);
  });
});

describe("inboxChannelForEnquiry mirrors the SQL mapping", () => {
  const cases: Array<[string, string]> = [
    ["phone", "voice"],
    ["whatsapp_call", "voice"],
    ["sms", "sms"],
    ["whatsapp_msg", "whatsapp"],
    ["email", "email"],
    ["instagram_dm", "chat"],
    ["facebook_dm", "chat"],
    ["manual", "chat"],
    ["something_new", "chat"],
  ];

  it.each(cases)("maps inbound %s → inbox %s", (inbound, inbox) => {
    expect(inboxChannelForEnquiry(inbound)).toBe(inbox);
  });

  it("every non-default TS mapping appears verbatim in the SQL function", () => {
    // The SQL uses `when '<inbound>' then '<inbox>'`; assert the explicit arms match.
    for (const [inbound, inbox] of cases) {
      if (inbox === "chat") continue; // chat is the SQL `else` fallthrough
      expect(MIGRATION).toContain(`when '${inbound}'`);
      expect(MIGRATION).toContain(`then '${inbox}'`);
    }
  });
});

describe("outbound transport eligibility", () => {
  it("routes each channel to the right seam (whatsapp never borrows sms)", () => {
    expect(transportForInboxChannel("email")).toBe("email");
    expect(transportForInboxChannel("sms")).toBe("sms");
    expect(transportForInboxChannel("whatsapp")).toBe("whatsapp");
    expect(transportForInboxChannel("voice")).toBeNull();
    expect(transportForInboxChannel("chat")).toBeNull();
  });

  it("canSendOnChannel is true only for the three wired transports", () => {
    expect(canSendOnChannel("email")).toBe(true);
    expect(canSendOnChannel("sms")).toBe(true);
    expect(canSendOnChannel("whatsapp")).toBe(true);
    expect(canSendOnChannel("voice")).toBe(false);
    expect(canSendOnChannel("chat")).toBe(false);
  });
});
