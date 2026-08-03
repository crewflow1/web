import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Voice spoken-turn PERSISTENCE — the service seam that closes the hollow loop
 * (C29). The C28 loop generated a reply per turn and DISCARDED both the caller's
 * transcript and the AI's reply, so enquiries had EMPTY bodies and every turn was
 * amnesiac. These tests pin, against a hermetic fake admin client (no Supabase):
 *   - persistSpokenTurn appends a call_events row carrying the caller SpeechResult
 *     AND the reply, org-pinned, under an in_progress event with a spoken-turn
 *     marker (so lifecycle status events are never confused for turns),
 *   - persistSpokenTurn populates the enquiry raw_text with the RUNNING transcript
 *     (prior turns + this one), correlated by (org_id, provider_message_id=CallSid),
 *     mirroring SMS/WhatsApp,
 *   - loadRecentSpokenTurns reads the call's turns oldest-first, org-pinned, and
 *     filters to the spoken-turn marker,
 *   - a DB write error fails LOUD (the route wraps it best-effort).
 */

type Captured = {
  callEventInsert: Record<string, unknown> | null;
  enquiryUpdate: Record<string, unknown> | null;
  enquiryEqs: Array<[string, unknown]>;
  loadEqs: Array<[string, unknown]>;
  loadOrder: [string, { ascending: boolean }] | null;
  loadRows: Array<{ payload: unknown }>;
  insertError: { message: string } | null;
  enquiryUpdateError: { message: string } | null;
  loadError: { message: string } | null;
  callsStatus: string;
};

const cap: Captured = {
  callEventInsert: null,
  enquiryUpdate: null,
  enquiryEqs: [],
  loadEqs: [],
  loadOrder: null,
  loadRows: [],
  insertError: null,
  enquiryUpdateError: null,
  loadError: null,
  callsStatus: "in_progress",
};

function makeSelectChain(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {
    eq(k: string, v: unknown) {
      eqs.push([k, v]);
      if (table === "call_events") cap.loadEqs = eqs;
      return chain;
    },
    // calls status read
    maybeSingle: async () => ({ data: { status: cap.callsStatus }, error: null }),
    // call_events ordered history read
    order(col: string, opts: { ascending: boolean }) {
      cap.loadOrder = [col, opts];
      return {
        limit: async (_n: number) => ({ data: cap.loadRows, error: cap.loadError }),
      };
    },
  };
  return chain;
}

function makeUpdateChain(table: string, row: Record<string, unknown>) {
  const eqs: Array<[string, unknown]> = [];
  return {
    eq(k1: string, v1: unknown) {
      eqs.push([k1, v1]);
      return {
        eq(k2: string, v2: unknown) {
          eqs.push([k2, v2]);
          if (table === "inbound_enquiries") {
            cap.enquiryUpdate = row;
            cap.enquiryEqs = eqs;
            return Promise.resolve({ error: cap.enquiryUpdateError });
          }
          // calls status update — irrelevant to the assertions, resolves clean.
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const fakeAdmin = {
  from(table: string) {
    return {
      insert(row: Record<string, unknown>) {
        if (table === "call_events") cap.callEventInsert = row;
        const result = { error: table === "call_events" ? cap.insertError : null };
        // Awaitable AND supports .select().single() (recordInboundCall shape).
        return Object.assign(Promise.resolve(result), {
          select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }),
        });
      },
      select: (_cols: string) => makeSelectChain(table),
      update: (row: Record<string, unknown>) => makeUpdateChain(table, row),
    };
  },
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

async function svc() {
  return import("@/server/services/telephony");
}

describe("spoken-turn persistence", () => {
  beforeEach(() => {
    cap.callEventInsert = null;
    cap.enquiryUpdate = null;
    cap.enquiryEqs = [];
    cap.loadEqs = [];
    cap.loadOrder = null;
    cap.loadRows = [];
    cap.insertError = null;
    cap.enquiryUpdateError = null;
    cap.loadError = null;
    cap.callsStatus = "in_progress";
  });
  afterEach(() => vi.clearAllMocks());

  it("composeCallTranscript interleaves caller + receptionist, dropping empties", async () => {
    const { composeCallTranscript } = await svc();
    expect(
      composeCallTranscript([
        { transcript: "my boiler is leaking", reply: "Is it dripping?" },
        { transcript: "just dripping", reply: null },
        { transcript: "", reply: "" },
      ]),
    ).toBe("Caller: my boiler is leaking\nReceptionist: Is it dripping?\nCaller: just dripping");
  });

  it("persistSpokenTurn appends the SpeechResult + reply to call_events, org-pinned", async () => {
    const { persistSpokenTurn } = await svc();
    await persistSpokenTurn({
      orgId: "org-1",
      callId: "call-1",
      providerCallId: "CA-1",
      transcript: "my boiler is leaking",
      reply: "Is it dripping or fully leaking?",
      priorTurns: [],
    });

    expect(cap.callEventInsert).toMatchObject({
      call_id: "call-1",
      org_id: "org-1",
      event_type: "in_progress",
      provider_event_id: null,
      payload: {
        kind: "spoken_turn",
        speech_result: "my boiler is leaking",
        reply: "Is it dripping or fully leaking?",
      },
    });
  });

  it("persistSpokenTurn populates the enquiry raw_text with the RUNNING transcript", async () => {
    const { persistSpokenTurn } = await svc();
    await persistSpokenTurn({
      orgId: "org-1",
      callId: "call-1",
      providerCallId: "CA-1",
      transcript: "just dripping",
      reply: "Understood, someone will call you back.",
      priorTurns: [{ transcript: "my boiler is leaking", reply: "Is it dripping?" }],
    });

    // The body is the full conversation, not just the latest turn — no empty body.
    expect(cap.enquiryUpdate).toEqual({
      raw_text:
        "Caller: my boiler is leaking\nReceptionist: Is it dripping?\n" +
        "Caller: just dripping\nReceptionist: Understood, someone will call you back.",
    });
    // Correlated by (org_id, provider_message_id = CallSid) — the origination key.
    expect(cap.enquiryEqs).toEqual([
      ["org_id", "org-1"],
      ["provider_message_id", "CA-1"],
    ]);
  });

  it("loadRecentSpokenTurns reads oldest-first, org-pinned, filtered to spoken turns", async () => {
    cap.loadRows = [
      { payload: { kind: "spoken_turn", speech_result: "hello", reply: "Hi there" } },
      { payload: { kind: "status", event: "answered" } }, // a lifecycle event — must be ignored
      { payload: { kind: "spoken_turn", speech_result: "boiler leaking", reply: null } },
    ];
    const { loadRecentSpokenTurns } = await svc();
    const turns = await loadRecentSpokenTurns("org-1", "call-1");

    expect(turns).toEqual([
      { transcript: "hello", reply: "Hi there" },
      { transcript: "boiler leaking", reply: null },
    ]);
    expect(cap.loadOrder).toEqual(["occurred_at", { ascending: true }]);
    expect(cap.loadEqs).toEqual([
      ["org_id", "org-1"],
      ["call_id", "call-1"],
      ["event_type", "in_progress"],
    ]);
  });

  it("fails LOUD when the enquiry raw_text write errors (route wraps best-effort)", async () => {
    cap.enquiryUpdateError = { message: "enquiry write refused" };
    const { persistSpokenTurn } = await svc();
    await expect(
      persistSpokenTurn({
        orgId: "org-1",
        callId: "call-1",
        providerCallId: "CA-1",
        transcript: "boiler leaking",
        reply: "Noted.",
        priorTurns: [],
      }),
    ).rejects.toThrow(/updateEnquiryTranscript failed/);
  });
});
