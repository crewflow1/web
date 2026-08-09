import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Voice terminal re-extraction — behavioural proof of the empty-transcript fix.
 *
 * THE DEFECT (verified by an independent red-team wave): the AI-receptionist
 * extraction runs at call ORIGINATION, when the caller has said nothing yet, so
 * `processInboundEnquiry` extracts over "" → the deterministic
 * "New enquiry — no transcript captured." sentinel summary with null job_type /
 * urgency / postcode, written to the lead AND the inbound_enquiries row. The
 * caller's words are captured LATER (into call_events / the enquiry raw_text) but
 * NOTHING re-ran extraction over that content — so the flagship voice channel
 * produced empty summaries + null triage permanently, though the full transcript
 * was available.
 *
 * THE FIX: on the TERMINAL call transition (Twilio status route + Vapi
 * end-of-call-report), the webhook now calls
 * `refreshVoiceExtractionFromTranscript` — the SAME GOVERNED extraction, re-run
 * over the captured transcript, refreshing the lead (ai_summary / urgency /
 * service / postcode) and the enquiry (ai_summary / ai_confidence / job_type /
 * urgency / postcode / budget_gbp), org-pinned by (org_id, provider_message_id).
 *
 * These tests EXECUTE the real service function against a chainable admin-client
 * mock — no DB, no network. Voice + the AI tier are DARK in the unit env, so
 * extraction degrades to the DETERMINISTIC path over the REAL transcript: that is
 * exactly what proves the fix lands even before activation (a real summary +
 * populated triage instead of the sentinel).
 *
 * RED on pre-fix code: `refreshVoiceExtractionFromTranscript` does not exist and
 * no terminal re-extraction path is wired, so the required lead/enquiry refresh
 * never happens and these assertions fail. GREEN after the fix.
 */

const SENTINEL = "New enquiry — no transcript captured.";

type DbResult = { data: unknown; error: unknown };
type DbOp = "select" | "update";
type OpRecord = {
  table: string;
  op: DbOp;
  row?: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
  single: boolean;
};

const h = vi.hoisted(() => {
  const dbCalls: OpRecord[] = [];
  const cfg: {
    enquiry: { id: string; lead_id: string | null } | null;
    enquiryLookupError: unknown;
    enquiryUpdateError: unknown;
    leadUpdateError: unknown;
  } = {
    enquiry: { id: "enq-1", lead_id: "lead-1" },
    enquiryLookupError: null,
    enquiryUpdateError: null,
    leadUpdateError: null,
  };

  function respond(rec: OpRecord): DbResult {
    if (rec.table === "inbound_enquiries") {
      if (rec.op === "update") return { data: null, error: cfg.enquiryUpdateError };
      return { data: cfg.enquiry, error: cfg.enquiryLookupError };
    }
    if (rec.table === "leads") {
      return { data: null, error: cfg.leadUpdateError };
    }
    return { data: null, error: null };
  }

  interface Builder extends PromiseLike<DbResult> {
    select(cols: string): Builder;
    eq(col: string, val: unknown): Builder;
    update(row: Record<string, unknown>): Builder;
    maybeSingle(): Builder;
  }

  function makeBuilder(table: string): Builder {
    const rec: OpRecord = { table, op: "select", eqs: [], single: false };
    dbCalls.push(rec);
    const builder: Builder = {
      select() {
        return builder;
      },
      eq(col, val) {
        rec.eqs.push([col, val]);
        return builder;
      },
      update(row) {
        rec.op = "update";
        rec.row = row;
        return builder;
      },
      maybeSingle() {
        rec.single = true;
        return builder;
      },
      then(onfulfilled, onrejected) {
        return Promise.resolve(respond(rec)).then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  return {
    dbCalls,
    cfg,
    makeAdmin: () => ({ from: (table: string) => makeBuilder(table) }),
    reset() {
      dbCalls.length = 0;
      cfg.enquiry = { id: "enq-1", lead_id: "lead-1" };
      cfg.enquiryLookupError = null;
      cfg.enquiryUpdateError = null;
      cfg.leadUpdateError = null;
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => h.makeAdmin(),
}));

const { refreshVoiceExtractionFromTranscript } = await import(
  "@/server/services/receptionist"
);

const ORG = "org-1";
const CALLSID = "CA-terminal-1";

const enquiryUpdate = () =>
  h.dbCalls.find((c) => c.table === "inbound_enquiries" && c.op === "update");
const enquiryLookup = () =>
  h.dbCalls.find((c) => c.table === "inbound_enquiries" && c.op === "select");
const leadUpdate = () => h.dbCalls.find((c) => c.table === "leads" && c.op === "update");

beforeEach(() => {
  h.reset();
});

describe("refreshVoiceExtractionFromTranscript — terminal re-extraction over the captured transcript", () => {
  it("a transcript with extractable signal refreshes the lead AND the enquiry off the sentinel, with populated triage", async () => {
    // A real captured conversation — the words the origination extraction never saw.
    const transcript =
      "Caller: Hi, my boiler has a bad leak, it's an emergency and there's no heat.\n" +
      "Receptionist: I'm sorry to hear that. Where are you based?\n" +
      "Caller: I'm at SW1A 1AA.";

    const result = await refreshVoiceExtractionFromTranscript({
      orgId: ORG,
      providerCallId: CALLSID,
      transcript,
    });

    expect(result.refreshed).toBe(true);

    // The enquiry was located org-pinned by (org_id, provider_message_id = CallSid).
    const lookup = enquiryLookup();
    expect(lookup).toBeTruthy();
    expect(lookup!.eqs).toEqual(
      expect.arrayContaining([
        ["org_id", ORG],
        ["provider_message_id", CALLSID],
      ]),
    );

    // The enquiry row is UPDATED off the sentinel with populated triage, org-pinned.
    const enq = enquiryUpdate();
    expect(enq, "the enquiry row must be re-extracted and updated").toBeTruthy();
    expect(enq!.row!.ai_summary).not.toBe(SENTINEL);
    expect(String(enq!.row!.ai_summary)).toContain("boiler");
    expect(enq!.row!.urgency).toBe("urgent"); // leak / emergency / no heat
    expect(enq!.row!.postcode).toBe("SW1A 1AA");
    // The full triage set the origination path left null is present.
    expect(enq!.row).toHaveProperty("ai_confidence");
    expect(enq!.row).toHaveProperty("job_type");
    expect(enq!.row).toHaveProperty("budget_gbp");
    expect(enq!.eqs).toEqual(
      expect.arrayContaining([
        ["id", "enq-1"],
        ["org_id", ORG],
      ]),
    );

    // The lead is refreshed too (ai_summary / urgency / service / postcode), org-pinned.
    const lead = leadUpdate();
    expect(lead, "the linked lead must be re-extracted and updated").toBeTruthy();
    expect(lead!.row!.ai_summary).not.toBe(SENTINEL);
    expect(lead!.row!.urgency).toBe("urgent");
    expect(lead!.row!.postcode).toBe("SW1A 1AA");
    expect(lead!.row).toHaveProperty("service");
    expect(lead!.eqs).toEqual(
      expect.arrayContaining([
        ["id", "lead-1"],
        ["org_id", ORG],
      ]),
    );
  });

  it("an EMPTY transcript is a deliberate no-op — the origination summary is never overwritten", async () => {
    const result = await refreshVoiceExtractionFromTranscript({
      orgId: ORG,
      providerCallId: CALLSID,
      transcript: "   \n  ",
    });
    expect(result.refreshed).toBe(false);
    // No lookup, no enquiry update, no lead update — nothing touched.
    expect(enquiryLookup()).toBeUndefined();
    expect(enquiryUpdate()).toBeUndefined();
    expect(leadUpdate()).toBeUndefined();
  });

  it("an enquiry with no linked lead still refreshes the enquiry (and issues no lead write)", async () => {
    h.cfg.enquiry = { id: "enq-2", lead_id: null };
    const result = await refreshVoiceExtractionFromTranscript({
      orgId: ORG,
      providerCallId: CALLSID,
      transcript: "Caller: I need a quote for a bathroom refit at M1 1AE.",
    });
    expect(result.refreshed).toBe(true);
    expect(enquiryUpdate()).toBeTruthy();
    expect(enquiryUpdate()!.row!.postcode).toBe("M1 1AE");
    // No lead row exists to refresh — the lead update must be skipped.
    expect(leadUpdate()).toBeUndefined();
  });

  it("no enquiry under the CallSid ⇒ a benign no-op (nothing to refresh)", async () => {
    h.cfg.enquiry = null;
    const result = await refreshVoiceExtractionFromTranscript({
      orgId: ORG,
      providerCallId: "CA-unknown",
      transcript: "Caller: emergency leak at SW1A 1AA.",
    });
    expect(result.refreshed).toBe(false);
    expect(enquiryUpdate()).toBeUndefined();
    expect(leadUpdate()).toBeUndefined();
  });
});
