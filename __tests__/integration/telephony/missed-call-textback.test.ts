import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * G-6 — missed-call text-back: the terminal trigger's SERVICE semantics against
 * real Postgres (the route halves are pinned hermetically in
 * __tests__/telephony/twilio-voice-missed-call-trigger.test.ts).
 *
 * What a missed call actually does, end to end through the real ingestion:
 *   1. ORIGINATION ingests with the reply DEFERRED — enquiry + lead exist, no
 *      text-back attempt is made at call start (the call is live there).
 *   2. The TERMINAL trigger (processMissedCallTextback) re-enters the SAME
 *      ingestion idempotently on the CallSid — exactly ONE enquiry and ONE lead
 *      per missed call, however the two webhooks interleave or redeliver.
 *   3. GATES REFUSE DARK: with NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK unset
 *      (the default posture) the trigger's reply half reports `flag_off` — the
 *      eligibility authority, not a scattered flag check — and nothing is sent.
 *   4. A terminal arriving FIRST (origination lost — Twilio is at-least-once
 *      and unordered) still produces the enquiry + lead.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string } | null }> & {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<{
        data: unknown[] | null;
        error: { message: string } | null;
      }> & {
        eq: (k: string, v: unknown) => PromiseLike<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-missed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("missed-call text-back · terminal trigger semantics", () => {
  let orgId = "";
  let processInboundEnquiry: typeof import("@/server/services/receptionist").processInboundEnquiry;
  let processMissedCallTextback: typeof import("@/server/services/receptionist").processMissedCallTextback;

  const enquiriesFor = async (providerMessageId: string) => {
    const res = await db(serviceClient())
      .from("inbound_enquiries")
      .select("id, lead_id")
      .eq("org_id", orgId)
      .eq("provider_message_id", providerMessageId);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<{ id: string; lead_id: string | null }>;
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    const o = await svc
      .from("organizations")
      .insert({ name: "Missed Call Org", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(o.error, o.error?.message).toBeNull();
    orgId = o.data?.id as string;

    const mod = await import("@/server/services/receptionist");
    processInboundEnquiry = mod.processInboundEnquiry;
    processMissedCallTextback = mod.processMissedCallTextback;
  });

  afterEach(() => {
    // The default posture — every test that arms the flag re-sets it itself.
    delete process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK;
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
  });

  it("origination DEFERS the reply — ingestion happens, no text-back attempt at call start", async () => {
    // Arm the flag to prove it is the DEFER (not the flag) keeping call-start silent.
    process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK = "true";
    const sid = `CA-${TOKEN}-defer`;
    const res = await processInboundEnquiry(
      {
        org_id: orgId,
        channel: "phone",
        caller: "+447700900123",
        dedup_key: sid,
        provider_message_id: sid,
      },
      { textback: "defer" },
    );
    expect(res.textback).toEqual({ attempted: false, reason: "deferred_to_terminal" });
    const rows = await enquiriesFor(sid);
    expect(rows.length).toBe(1);
    expect(rows[0]!.lead_id).not.toBeNull();
  });

  it("origination then terminal: EXACTLY one enquiry + one lead; the gate refuses dark (flag_off)", async () => {
    const sid = `CA-${TOKEN}-full`;
    // 1. Origination (reply deferred).
    const origination = await processInboundEnquiry(
      {
        org_id: orgId,
        channel: "phone",
        caller: "+447700900123",
        dedup_key: sid,
        provider_message_id: sid,
      },
      { textback: "defer" },
    );
    // 2. The unanswered terminal fires the trigger. Flag unset ⇒ the ONE
    //    eligibility authority refuses with flag_off; nothing dispatched.
    const missed = await processMissedCallTextback({
      org_id: orgId,
      provider_call_id: sid,
      caller: "+447700900123",
    });
    expect(missed.textback).toEqual({ attempted: false, reason: "flag_off" });
    // Folded into the SAME enquiry/lead origination created.
    expect(missed.enquiry_id).toBe(origination.enquiry_id);
    expect(missed.lead_id).toBe(origination.lead_id);
    expect((await enquiriesFor(sid)).length).toBe(1);
  });

  it("a REDELIVERED terminal re-enters idempotently — still one enquiry, same ids, no second ingestion", async () => {
    const sid = `CA-${TOKEN}-retry`;
    const first = await processMissedCallTextback({
      org_id: orgId,
      provider_call_id: sid,
      caller: "+447700900456",
    });
    const second = await processMissedCallTextback({
      org_id: orgId,
      provider_call_id: sid,
      caller: "+447700900456",
    });
    expect(second.enquiry_id).toBe(first.enquiry_id);
    expect(second.lead_id).toBe(first.lead_id);
    expect((await enquiriesFor(sid)).length).toBe(1);
    // Dark posture: both attempts were refused by the flag gate — no send path ran.
    expect(first.textback).toEqual({ attempted: false, reason: "flag_off" });
    expect(second.textback).toEqual({ attempted: false, reason: "flag_off" });
  });

  it("a terminal arriving FIRST (origination lost) still produces the enquiry + lead", async () => {
    const sid = `CA-${TOKEN}-terminal-first`;
    const missed = await processMissedCallTextback({
      org_id: orgId,
      provider_call_id: sid,
      caller: "+447700900789",
    });
    expect(missed.enquiry_id).toBeTruthy();
    expect(missed.lead_id).not.toBeNull();
    const rows = await enquiriesFor(sid);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(missed.enquiry_id);
  });
});
