import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Call-completion ENRICHMENT (C35c) — the service seam + the Vapi report parser.
 *
 * The confirmed gap: a completed call's durable artifacts (recording, transcript,
 * structured transcript, AI summary, duration, ended-at) had no write path. These
 * tests pin, against a hermetic fake admin client (no Supabase):
 *   - updateCallCompletion issues an UPDATE on `calls` keyed on the provider call
 *     id AND org-pinned (defence in depth over the RLS-bypassing admin client);
 *   - only fields PRESENT in the report are written (a partial report never nulls
 *     already-captured data);
 *   - the write is an UPDATE (never an insert) ⇒ redelivery is idempotent;
 *   - a DB error fails LOUD (the webhook wraps it best-effort);
 * and, against the pure parser:
 *   - parseVapiEndOfCallReport extracts recording/transcript/structured/summary/
 *     duration/ended-at defensively, and returns null for a non-report / no call id.
 */

// ── service: updateCallCompletion against a fake admin client ─────────────────

type Cap = {
  updateRow: Record<string, unknown> | null;
  updateEqs: Array<[string, unknown]>;
  updateError: { message: string } | null;
  insertCalled: boolean;
  // select() capture — used by loadEnquirySummary's read path.
  selectCols: string | null;
  selectEqs: Array<[string, unknown]>;
  selectData: Record<string, unknown> | null;
  selectError: { message: string } | null;
};
const cap: Cap = {
  updateRow: null,
  updateEqs: [],
  updateError: null,
  insertCalled: false,
  selectCols: null,
  selectEqs: [],
  selectData: null,
  selectError: null,
};

const fakeAdmin = {
  from(_table: string) {
    return {
      insert() {
        cap.insertCalled = true;
        return Object.assign(Promise.resolve({ error: null }), {
          select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }),
        });
      },
      update(row: Record<string, unknown>) {
        cap.updateRow = row;
        const eqs: Array<[string, unknown]> = [];
        return {
          eq(k1: string, v1: unknown) {
            eqs.push([k1, v1]);
            return {
              eq(k2: string, v2: unknown) {
                eqs.push([k2, v2]);
                cap.updateEqs = eqs;
                return Promise.resolve({ error: cap.updateError });
              },
            };
          },
        };
      },
      select(cols: string) {
        cap.selectCols = cols;
        const eqs: Array<[string, unknown]> = [];
        const chain = {
          eq(k: string, v: unknown) {
            eqs.push([k, v]);
            cap.selectEqs = eqs;
            return chain;
          },
          maybeSingle: async () => ({ data: cap.selectData, error: cap.selectError }),
        };
        return chain;
      },
    };
  },
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

async function svc() {
  return import("@/server/services/telephony");
}

describe("updateCallCompletion — the enrichment write door", () => {
  beforeEach(() => {
    cap.updateRow = null;
    cap.updateEqs = [];
    cap.updateError = null;
    cap.insertCalled = false;
  });
  afterEach(() => vi.clearAllMocks());

  it("UPDATES calls with every field, keyed on provider_call_id AND org-pinned", async () => {
    const { updateCallCompletion } = await svc();
    await updateCallCompletion("org-1", "vapi-call-1", {
      recordingUrl: "https://rec/abc.mp3",
      transcript: "Caller: hi\nReceptionist: hello",
      transcriptJson: [{ role: "user", message: "hi" }],
      aiSummary: "Caller said hi.",
      durationSec: 42,
      endedAt: "2026-08-01T10:00:00.000Z",
    });

    expect(cap.insertCalled).toBe(false); // an UPDATE, never an insert
    expect(cap.updateRow).toEqual({
      recording_url: "https://rec/abc.mp3",
      transcript: "Caller: hi\nReceptionist: hello",
      transcript_json: [{ role: "user", message: "hi" }],
      ai_summary: "Caller said hi.",
      duration_sec: 42,
      ended_at: "2026-08-01T10:00:00.000Z",
    });
    expect(cap.updateEqs).toEqual([
      ["provider_call_id", "vapi-call-1"],
      ["org_id", "org-1"],
    ]);
  });

  it("writes ONLY the fields present — a partial report never nulls captured data", async () => {
    const { updateCallCompletion } = await svc();
    await updateCallCompletion("org-1", "vapi-call-1", {
      transcript: "just this",
      // recordingUrl / transcriptJson / aiSummary / durationSec / endedAt omitted
    });
    expect(cap.updateRow).toEqual({ transcript: "just this" });
  });

  it("is a NO-OP when there is nothing to write (never an empty UPDATE)", async () => {
    const { updateCallCompletion } = await svc();
    await updateCallCompletion("org-1", "vapi-call-1", {});
    expect(cap.updateRow).toBeNull();
    expect(cap.insertCalled).toBe(false);
  });

  it("REDELIVERY drives the SAME idempotent UPDATE (no insert, no duplicate)", async () => {
    const { updateCallCompletion } = await svc();
    const fields = { recordingUrl: "https://rec/abc.mp3", durationSec: 10 };
    await updateCallCompletion("org-1", "vapi-call-1", fields);
    const firstRow = cap.updateRow;
    const firstEqs = cap.updateEqs;
    await updateCallCompletion("org-1", "vapi-call-1", fields);
    expect(cap.insertCalled).toBe(false);
    expect(cap.updateRow).toEqual(firstRow);
    expect(cap.updateEqs).toEqual(firstEqs);
  });

  it("fails LOUD when the UPDATE errors (the route wraps it best-effort)", async () => {
    cap.updateError = { message: "calls update refused" };
    const { updateCallCompletion } = await svc();
    await expect(
      updateCallCompletion("org-1", "vapi-call-1", { transcript: "x" }),
    ).rejects.toThrow(/updateCallCompletion failed/);
  });
});

// ── service: loadEnquirySummary — reuse the GOVERNED summary (no new AI call) ──

describe("loadEnquirySummary — reuses the governed enquiry summary, org-pinned by CallSid", () => {
  beforeEach(() => {
    cap.selectCols = null;
    cap.selectEqs = [];
    cap.selectData = null;
    cap.selectError = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("returns the enquiry's ai_summary, org-pinned + keyed on provider_message_id", async () => {
    cap.selectData = { ai_summary: "Caller reports a leaking boiler." };
    const { loadEnquirySummary } = await svc();
    const out = await loadEnquirySummary("org-1", "CA-1");
    expect(out).toBe("Caller reports a leaking boiler.");
    expect(cap.selectCols).toBe("ai_summary");
    expect(cap.selectEqs).toEqual([
      ["org_id", "org-1"],
      ["provider_message_id", "CA-1"],
    ]);
  });

  it("returns null when no enquiry row matches (benign no-op, not an error)", async () => {
    cap.selectData = null;
    const { loadEnquirySummary } = await svc();
    expect(await loadEnquirySummary("org-1", "CA-missing")).toBeNull();
  });

  it("returns null for a blank / whitespace summary (never folds an empty string)", async () => {
    cap.selectData = { ai_summary: "   " };
    const { loadEnquirySummary } = await svc();
    expect(await loadEnquirySummary("org-1", "CA-1")).toBeNull();
  });

  it("fails LOUD when the read errors (the webhook wraps it best-effort)", async () => {
    cap.selectError = { message: "enquiry read refused" };
    const { loadEnquirySummary } = await svc();
    await expect(loadEnquirySummary("org-1", "CA-1")).rejects.toThrow(/loadEnquirySummary failed/);
  });
});

// ── parser: parseVapiEndOfCallReport (pure) ──────────────────────────────────

describe("parseVapiEndOfCallReport — defensive, pure", () => {
  async function parser() {
    return (await import("@/lib/telephony/providers/vapi")).parseVapiEndOfCallReport;
  }

  it("extracts recording, transcript (text + structured), summary, duration, ended-at", async () => {
    const parse = await parser();
    const out = parse(
      JSON.stringify({
        message: {
          type: "end-of-call-report",
          call: { id: "c1", customer: { number: "+4477" }, phoneNumber: { number: "+4412" } },
          recordingUrl: "https://rec/x.mp3",
          transcript: "AI: hi\nUser: hello",
          messages: [{ role: "user", message: "hello" }],
          analysis: { summary: "the summary" },
          durationSeconds: 42.6,
          endedAt: "2026-08-01T10:00:00.000Z",
        },
      }),
    );
    expect(out).toEqual({
      callId: "c1",
      to: "+4412",
      from: "+4477",
      recordingUrl: "https://rec/x.mp3",
      transcript: "AI: hi\nUser: hello",
      transcriptJson: [{ role: "user", message: "hello" }],
      summary: "the summary",
      durationSec: 43, // rounded
      endedAt: "2026-08-01T10:00:00.000Z",
    });
  });

  it("falls back to artifact fields and durationMs, and epoch-ms timestamp", async () => {
    const parse = await parser();
    const out = parse(
      JSON.stringify({
        message: {
          type: "end-of-call-report",
          call: { id: "c2", phoneNumber: { number: "+4412" } },
          artifact: {
            recordingUrl: "https://rec/from-artifact.mp3",
            transcript: "artifact transcript",
            messages: [{ role: "assistant", message: "hi" }],
          },
          summary: "top-level summary",
          durationMs: 5000,
          timestamp: 1754042400000,
        },
      }),
    );
    expect(out?.recordingUrl).toBe("https://rec/from-artifact.mp3");
    expect(out?.transcript).toBe("artifact transcript");
    expect(out?.transcriptJson).toEqual([{ role: "assistant", message: "hi" }]);
    expect(out?.summary).toBe("top-level summary");
    expect(out?.durationSec).toBe(5);
    expect(out?.endedAt).toBe(new Date(1754042400000).toISOString());
  });

  it("returns null for a non-report type, a missing call id, or bad JSON", async () => {
    const parse = await parser();
    expect(parse(JSON.stringify({ message: { type: "status-update", call: { id: "c1" } } }))).toBeNull();
    expect(parse(JSON.stringify({ message: { type: "end-of-call-report", call: {} } }))).toBeNull();
    expect(parse("not json")).toBeNull();
  });

  it("nulls absent enrichment fields rather than inventing them", async () => {
    const parse = await parser();
    const out = parse(
      JSON.stringify({
        message: { type: "end-of-call-report", call: { id: "c3", phoneNumber: { number: "+4412" } } },
      }),
    );
    expect(out).toEqual({
      callId: "c3",
      to: "+4412",
      from: null,
      recordingUrl: null,
      transcript: null,
      transcriptJson: null,
      summary: null,
      durationSec: null,
      endedAt: null,
    });
  });
});
