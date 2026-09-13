import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * WhatsApp auto-send posture (activation-hardening P2-9) — unit tier.
 *
 * The guardrail's §9 A1 exception (a clean ≤320-char draft auto-sends) was
 * calibrated on the missed-call SMS text-back and CONTRADICTS the standing
 * draft-first / no-autonomous-customer-comms posture for WhatsApp. These tests
 * pin the hold and its exact scope:
 *
 *   • WHATSAPP_AUTO_SEND is FALSE — a build constant (the
 *     CHAT_AUTO_REPLY_GENERATIVE idiom), so flipping it is a reviewed diff.
 *   • On the WhatsApp channels, a clean `allow` is DOWNGRADED to a held
 *     `review` BEFORE the audit is written — the ledger records the verdict
 *     that actually governed, with provenance in metadata.
 *   • review/block verdicts pass through untouched (deny-by-default is only
 *     ever tightened), and NON-WhatsApp channels are byte-for-byte unchanged —
 *     the phone/SMS deterministic text-back (a separate CEO decision) still
 *     auto-sends its clean acknowledgement.
 */

const auditState = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "record_ai_reply_audit") {
        auditState.audits.push(args);
        return { data: `audit-${auditState.audits.length}`, error: null };
      }
      throw new Error(`unexpected rpc in this suite: ${fn}`);
    },
    from: () => {
      throw new Error("no table access expected: a held reply never reaches transport");
    },
  }),
}));

import {
  enforceAndAuditReply,
  enforceReceptionistReply,
  WHATSAPP_AUTO_SEND,
} from "@/server/services/receptionist";

const CLEAN_ACK = "Thanks for your message — a member of the team will get back to you shortly.";
const PRICE_DRAFT = "Sure, that'll cost £450 including VAT.";
const BLOCK_DRAFT = "Don't worry, your gas boiler is completely safe.";

afterEach(() => {
  auditState.audits = [];
});

describe("WHATSAPP_AUTO_SEND — the build-constant hold", () => {
  it("is FALSE: WhatsApp is draft-first by standing decision; flipping this is a reviewed CEO diff", () => {
    expect(WHATSAPP_AUTO_SEND).toBe(false);
  });

  it("the PURE policy still classifies the clean ack as `allow` — the downgrade is channel-scoped enforcement, not a policy rewrite", () => {
    expect(enforceReceptionistReply(CLEAN_ACK).verdict).toBe("allow");
  });
});

describe("enforceAndAuditReply — the WhatsApp downgrade", () => {
  it("whatsapp_msg: a clean `allow` is DOWNGRADED to a held `review` and audited that way", async () => {
    const outcome = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "whatsapp_msg",
      draft: CLEAN_ACK,
    });
    expect(outcome.decision.verdict).toBe("review");
    expect(outcome.decision.allowed).toBe(false);
    expect(outcome.decision.safeText, "nothing may ride the wire from a held reply").toBeNull();
    expect(outcome.decision.reason).toMatch(/WHATSAPP_AUTO_SEND=false/);

    // The audit records the GOVERNING verdict, with provenance.
    const audit = auditState.audits[0]!;
    expect(audit.p_verdict).toBe("review");
    expect(audit.p_allowed).toBe(false);
    const meta = audit.p_metadata as Record<string, unknown>;
    expect(meta.whatsapp_auto_send_downgraded).toBe(true);
    expect(meta.automatic_verdict).toBe("allow");
  });

  it("whatsapp_call is scoped in too (same transport channel)", async () => {
    const outcome = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "whatsapp_call",
      draft: CLEAN_ACK,
    });
    expect(outcome.decision.verdict).toBe("review");
    expect(outcome.decision.allowed).toBe(false);
  });

  it("phone (the SMS text-back, a separate CEO decision) is byte-for-byte unchanged — clean ack still allows", async () => {
    const outcome = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "phone",
      draft: CLEAN_ACK,
    });
    expect(outcome.decision.verdict).toBe("allow");
    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.decision.safeText).toBe(CLEAN_ACK);
    const meta = auditState.audits[0]!.p_metadata as Record<string, unknown>;
    expect(meta.whatsapp_auto_send_downgraded).toBeUndefined();
  });

  it("a WhatsApp `review` (commitment) and `block` (prohibition) pass through UNTOUCHED — the hold only tightens", async () => {
    const review = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "whatsapp_msg",
      draft: PRICE_DRAFT,
    });
    expect(review.decision.verdict).toBe("review");
    expect(review.decision.reason).toMatch(/customer commitment/);
    expect(
      (auditState.audits[0]!.p_metadata as Record<string, unknown>).whatsapp_auto_send_downgraded,
    ).toBeUndefined();

    const block = await enforceAndAuditReply({
      org_id: crypto.randomUUID(),
      channel: "whatsapp_msg",
      draft: BLOCK_DRAFT,
    });
    expect(block.decision.verdict).toBe("block");
  });
});
