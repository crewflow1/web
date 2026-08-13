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
  loadOrders: Array<[string, { ascending: boolean }]>;
  loadRangeCalled: boolean;
  loadRows: Array<{ payload: unknown }>;
  loadCount: number | null;
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
  loadOrders: [],
  loadRangeCalled: false,
  loadRows: [],
  loadCount: 0,
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
    // call_events ordered history read — chainable so a SECOND .order (the `id`
    // tiebreaker on the PAGED loadAllSpokenTurns) is supported; records the first
    // order for the loadRecentSpokenTurns assertion + every order for loadAll.
    order(col: string, opts: { ascending: boolean }) {
      if (cap.loadOrder === null) cap.loadOrder = [col, opts];
      cap.loadOrders.push([col, opts]);
      return chain;
    },
    // loadRecentSpokenTurns terminal (bounded prompt-memory window).
    limit: async (_n: number) => ({ data: cap.loadRows, error: cap.loadError }),
    // loadAllSpokenTurns (fetchAllRows) terminal — a short first page returns the
    // complete set, so paging stops after one call.
    range: async (_from: number, _to: number) => {
      cap.loadRangeCalled = true;
      return { data: cap.loadRows, error: cap.loadError };
    },
    // countSpokenTurns terminal: a head/count query has NO explicit terminal method
    // — the chain (after its `.eq × n`) is awaited directly, so the chain is a
    // thenable resolving to { count, error }.
    then: (
      resolve: (v: { count: number | null; error: { message: string } | null }) => unknown,
    ) => resolve({ count: cap.loadCount, error: cap.loadError }),
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
    cap.loadOrders = [];
    cap.loadRangeCalled = false;
    cap.loadRows = [];
    cap.loadCount = 0;
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

  it("persistSpokenTurn folds the COMPLETE persisted conversation into the enquiry raw_text", async () => {
    // After appending this turn, persistSpokenTurn re-reads the COMPLETE turn set
    // (loadAllSpokenTurns, paged) as the raw_text source — NOT a bounded window
    // handed in by the caller. The mock returns the full post-append set here.
    cap.loadRows = [
      { payload: { kind: "spoken_turn", speech_result: "my boiler is leaking", reply: "Is it dripping?" } },
      {
        payload: {
          kind: "spoken_turn",
          speech_result: "just dripping",
          reply: "Understood, someone will call you back.",
        },
      },
    ];
    const { persistSpokenTurn } = await svc();
    await persistSpokenTurn({
      orgId: "org-1",
      callId: "call-1",
      providerCallId: "CA-1",
      transcript: "just dripping",
      reply: "Understood, someone will call you back.",
    });

    // The fold read the COMPLETE set via the PAGED (.range) reader, not .limit.
    expect(cap.loadRangeCalled).toBe(true);
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

  it("loadRecentSpokenTurns reads the LATEST N (DESC), reversed to oldest-first, org-pinned, filtered", async () => {
    // The read takes the most RECENT `limit` rows: it orders (occurred_at, id)
    // DESCENDING then `.limit`, so the DB returns them NEWEST-FIRST; the function
    // REVERSES to oldest-first so the folded prompt memory reads chronologically.
    // Rows are supplied here newest-first, exactly as the DESC read returns them.
    cap.loadRows = [
      { payload: { kind: "spoken_turn", speech_result: "boiler leaking", reply: null } }, // newest
      { payload: { kind: "status", event: "answered" } }, // a lifecycle event — must be ignored
      { payload: { kind: "spoken_turn", speech_result: "hello", reply: "Hi there" } }, // oldest
    ];
    const { loadRecentSpokenTurns } = await svc();
    const turns = await loadRecentSpokenTurns("org-1", "call-1");

    // Reversed back to oldest-first for the chronological fold.
    expect(turns).toEqual([
      { transcript: "hello", reply: "Hi there" },
      { transcript: "boiler leaking", reply: null },
    ]);
    // The LATEST-N cut: DESC on a STABLE, UNIQUE total order (occurred_at + id
    // tiebreaker), NOT the oldest-first ascending order the bug shipped.
    expect(cap.loadOrders).toEqual([
      ["occurred_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(cap.loadEqs).toEqual([
      ["org_id", "org-1"],
      ["call_id", "call-1"],
      ["event_type", "in_progress"],
    ]);
  });

  it("loadRecentSpokenTurns on a >20-turn call carries the MOST RECENT turns (turn 25 present, turn 1 dropped)", async () => {
    // The defect: ordering ASC then `.limit(20)` returned the OLDEST 20 turns, so a
    // long call's prompt memory was frozen on turns 1..20 and NEVER carried the
    // recent exchange. With the fix the DB (DESC + limit) returns the LATEST 20 rows
    // NEWEST-FIRST — here turns 25..6 — and the function reverses to 6..25. So turn
    // 25 (the most recent) is present and LAST, and turn 1 is dropped.
    cap.loadRows = Array.from({ length: 20 }, (_v, i) => {
      const turnNo = 25 - i; // 25, 24, ..., 6 (newest-first, as the DESC read returns)
      return {
        payload: { kind: "spoken_turn", speech_result: `turn ${turnNo}`, reply: null },
      };
    });
    const { loadRecentSpokenTurns } = await svc();
    const turns = await loadRecentSpokenTurns("org-1", "call-1");

    expect(turns).toHaveLength(20);
    const transcripts = turns.map((t) => t.transcript);
    // The MOST RECENT turn survives — and is last (chronological order).
    expect(transcripts).toContain("turn 25");
    expect(turns[turns.length - 1]).toEqual({ transcript: "turn 25", reply: null });
    // The oldest turns beyond the window are dropped — this is the recent window.
    expect(transcripts).not.toContain("turn 1");
    expect(transcripts).not.toContain("turn 5");
    // The window's own oldest is turn 6 (chronological first).
    expect(turns[0]).toEqual({ transcript: "turn 6", reply: null });
  });

  it("countSpokenTurns returns the COMPLETE per-call count (org-pinned, marker-filtered, head/count)", async () => {
    // The dedupe ORDINAL source: unlike the bounded recent window, this counts EVERY
    // spoken turn, so the ordinal strictly increases for the whole call and never
    // freezes at the window cap. A call past 20 turns reports its true count (here 37).
    cap.loadCount = 37;
    const { countSpokenTurns } = await svc();
    const n = await countSpokenTurns("org-1", "call-1");

    expect(n).toBe(37);
    // Org-pinned + call-scoped + event_type + filtered to the spoken-turn payload
    // marker (so a lifecycle in_progress status event is never counted as a turn).
    expect(cap.loadEqs).toEqual([
      ["org_id", "org-1"],
      ["call_id", "call-1"],
      ["event_type", "in_progress"],
      ["payload->>kind", "spoken_turn"],
    ]);
  });

  it("countSpokenTurns fails LOUD on a read error (the route wraps it best-effort)", async () => {
    cap.loadError = { message: "count refused" };
    const { countSpokenTurns } = await svc();
    await expect(countSpokenTurns("org-1", "call-1")).rejects.toThrow(/countSpokenTurns failed/);
  });

  it("fails LOUD when the enquiry raw_text write errors (route wraps best-effort)", async () => {
    // A non-empty completed set so the fold produces a real transcript and the
    // enquiry write (which errors) is actually reached.
    cap.loadRows = [{ payload: { kind: "spoken_turn", speech_result: "boiler leaking", reply: "Noted." } }];
    cap.enquiryUpdateError = { message: "enquiry write refused" };
    const { persistSpokenTurn } = await svc();
    await expect(
      persistSpokenTurn({
        orgId: "org-1",
        callId: "call-1",
        providerCallId: "CA-1",
        transcript: "boiler leaking",
        reply: "Noted.",
      }),
    ).rejects.toThrow(/updateEnquiryTranscript failed/);
  });

  it("loadAllSpokenTurns pages the COMPLETE set (org-pinned, occurred_at+id order) — the full-transcript source", async () => {
    // 25 turns: turns 1..20 are early chit-chat, turn 25 carries the callback
    // number spoken at the END of the call — exactly the tail the bounded
    // recent-window (loadRecentSpokenTurns default 20) drops. loadAllSpokenTurns
    // pages EVERY turn, so the callback survives into the transcript.
    cap.loadRows = Array.from({ length: 25 }, (_v, i) => ({
      payload: {
        kind: "spoken_turn",
        speech_result: i === 24 ? "Call me back on 07700 900456" : `turn ${i + 1}`,
        reply: null,
      },
    }));
    const { loadAllSpokenTurns } = await svc();
    const turns = await loadAllSpokenTurns("org-1", "call-1");

    // The COMPLETE set came back — all 25 turns, including the late callback number.
    expect(turns).toHaveLength(25);
    expect(turns[24]).toEqual({ transcript: "Call me back on 07700 900456", reply: null });
    // Read via the PAGED (.range) path — never a bounded .limit.
    expect(cap.loadRangeCalled).toBe(true);
    // Org-pinned + call-scoped + filtered to the spoken-turn discriminator.
    expect(cap.loadEqs).toEqual([
      ["org_id", "org-1"],
      ["call_id", "call-1"],
      ["event_type", "in_progress"],
    ]);
    // A STABLE, UNIQUE total order: occurred_at asc PLUS the id tiebreaker (the
    // fetchAllRows contract — without it a page edge can drop/repeat a turn).
    expect(cap.loadOrders).toEqual([
      ["occurred_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });
});
