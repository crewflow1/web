import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendEmailResult } from "@/lib/email/send";

/**
 * Behavioural tests for the quote follow-up cron at
 * app/api/cron/quote-followup/route.ts.
 *
 * The route was reworked to send under bounded concurrency (away from a
 * strict serial loop) while keeping its idempotency contract: it stamps
 * followup_sent_at ONLY after a confirmed send, so the
 * `followup_sent_at IS NULL` query filter prevents a second send.
 *
 * We verify:
 *   1. a quote with an email → emailed once + stamped once
 *   2. a quote with no email → skipped, never emailed, never stamped
 *   3. a mixed batch → only the emailable quotes are sent + stamped
 *   4. a failed send → counted as failed and NOT stamped (so it retries)
 */

// -- Mock Supabase -------------------------------------------------------

type QueueEntry = { data?: unknown; error?: unknown };

function makeMockSupabase() {
  const queue = { candidates: [] as QueueEntry[], stamp: [] as QueueEntry[] };
  const stampUpdates: { id: unknown; payload: unknown }[] = [];

  function pop(key: keyof typeof queue): QueueEntry {
    const entry = queue[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

  const passthrough = ["select", "eq", "is", "not", "lt", "lte", "gt", "gte", "order", "in", "match"];

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of passthrough) chain[m] = () => chain;
    chain.limit = () => chain;

    Object.defineProperty(chain, "then", {
      value: (resolve: (v: QueueEntry) => unknown) => {
        if (table === "quotes") return resolve(pop("candidates"));
        return resolve({ data: [], error: null });
      },
    });

    // The telemetry wrapper writes a cron_runs row at the end of every run;
    // accept (and ignore) inserts on any other table so it succeeds quietly.
    chain.insert = () => {
      const insertChain: Record<string, unknown> = {};
      Object.defineProperty(insertChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve({ data: null, error: null }),
      });
      return insertChain;
    };

    chain.update = (payload: unknown) => {
      const updChain: Record<string, unknown> = {};
      let stampId: unknown;
      updChain.eq = (_col: string, val: unknown) => {
        stampId = val;
        return updChain;
      };
      Object.defineProperty(updChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => {
          if (table === "quotes") {
            stampUpdates.push({ id: stampId, payload });
            return resolve(pop("stamp"));
          }
          return resolve({ data: null, error: null });
        },
      });
      return updChain;
    };

    return chain;
  }

  return {
    client: { from: (table: string) => makeChain(table) },
    queue,
    stampUpdates,
    enqueue(key: keyof typeof queue, entry: QueueEntry) {
      queue[key].push(entry);
    },
  };
}

const mockAdmin = makeMockSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
}));

const sendEmailMock = vi.fn(
  async (): Promise<SendEmailResult> => ({ sent: true, id: "em-1" }),
);
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));

vi.mock("@/lib/email/templates/reminders", () => ({
  buildQuoteFollowup: () => ({ subject: "Following up", html: "<p>hi</p>", text: "hi" }),
}));

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised: () => true }));
vi.mock("@/lib/env", () => ({ env: { RESEND_API_KEY: "re_test", NODE_ENV: "test" } }));

const { GET } = await import("@/app/api/cron/quote-followup/route");

// -- Fixtures ------------------------------------------------------------

function makeQuote(opts: { id?: string; email?: string | null } = {}) {
  return {
    id: opts.id ?? "quote-1",
    org_id: "org-1",
    number: "Q-0001",
    total: 1200,
    sent_at: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    customer: { name: "Pat", email: opts.email === undefined ? "pat@example.com" : opts.email },
    org: { name: "Acme" },
  };
}

const fakeRequest = new Request("https://crewflow.uk/api/cron/quote-followup", {
  headers: { authorization: "Bearer test" },
});

beforeEach(() => {
  mockAdmin.queue.candidates.length = 0;
  mockAdmin.queue.stamp.length = 0;
  mockAdmin.stampUpdates.length = 0;
  sendEmailMock.mockClear();
  sendEmailMock.mockImplementation(async () => ({ sent: true, id: "em-1" }));
});

describe("quote-followup cron", () => {
  it("emails a fresh quote once and stamps followup_sent_at", async () => {
    const q = makeQuote();
    mockAdmin.enqueue("candidates", { data: [q], error: null });
    mockAdmin.enqueue("stamp", { data: null, error: null });

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.scanned).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "pat@example.com" }),
    );
    expect(mockAdmin.stampUpdates).toHaveLength(1);
    expect(mockAdmin.stampUpdates[0]!.id).toBe(q.id);
    expect(mockAdmin.stampUpdates[0]!.payload).toMatchObject({
      followup_sent_at: expect.any(String),
    });
  });

  it("skips a quote with no customer email — never emails, never stamps", async () => {
    mockAdmin.enqueue("candidates", { data: [makeQuote({ email: null })], error: null });

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.skipped_no_email).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mockAdmin.stampUpdates).toHaveLength(0);
  });

  it("mixed batch: only emailable quotes are sent + stamped", async () => {
    const withEmail = makeQuote({ id: "quote-a", email: "a@example.com" });
    const noEmail = makeQuote({ id: "quote-b", email: null });
    mockAdmin.enqueue("candidates", { data: [withEmail, noEmail], error: null });
    mockAdmin.enqueue("stamp", { data: null, error: null });

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.scanned).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.skipped_no_email).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(mockAdmin.stampUpdates).toHaveLength(1);
    expect(mockAdmin.stampUpdates[0]!.id).toBe("quote-a");
  });

  it("a failed send is counted as failed and NOT stamped (so it retries next run)", async () => {
    sendEmailMock.mockImplementationOnce(async () => ({
      sent: false as const,
      reason: "error" as const,
      error: "resend down",
    }));
    mockAdmin.enqueue("candidates", { data: [makeQuote()], error: null });

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(mockAdmin.stampUpdates).toHaveLength(0);
  });
});
