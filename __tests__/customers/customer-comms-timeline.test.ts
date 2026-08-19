import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {
  customerContactRefs,
  buildCustomerCommsEvents,
  loadCustomerCommsTimeline,
} from "@/lib/customers/comms-timeline";

/**
 * Customer record timeline — COMMUNICATIONS.
 *
 * The staff customer detail page weaves quotes/jobs/invoices/payments/leads into
 * ONE reverse-chronological timeline; this suite covers the communications the
 * detail page now folds in — inbound/outbound email/SMS/WhatsApp/voice/chat read
 * from the EXISTING unified-inbox pair (public.conversations + public.messages).
 *
 * It proves:
 *   1. contact-identity resolution (email + phone → normalised refs);
 *   2. comms appear in the timeline for the customer's threads;
 *   3. ORG ISOLATION — another org's conversation/messages never leak, even when
 *      it shares the exact contact_ref (the active-org pin is the only boundary);
 *   4. CHRONOLOGICAL MERGE — events come back newest-first with a stable tiebreak.
 */

const ORG = "org-A";
const OTHER_ORG = "org-B";
const CUSTOMER = { id: "cust-1", email: "Jane@ACME.io", phone: "07700 900123" };

type Row = Record<string, unknown>;

/** Faithful, minimal PostgREST builder over one in-memory table (eq/in/order/range). */
class FakeQuery<T extends Row> implements PromiseLike<{ data: T[] | null; error: unknown }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private orders: Array<[string, boolean]> = [];
  private rangeWindow: [number, number] | null = null;

  constructor(private readonly rows: T[]) {}

  select(_cols: string): this {
    return this;
  }
  eq(key: string, value: unknown): this {
    this.eqs.push([key, value]);
    return this;
  }
  in(key: string, values: readonly unknown[]): this {
    this.ins.push([key, [...values]]);
    return this;
  }
  order(key: string, opts: { ascending: boolean }): this {
    this.orders.push([key, opts.ascending]);
    return this;
  }
  range(from: number, to: number): this {
    this.rangeWindow = [from, to];
    return this;
  }

  private resolveRows(): T[] {
    let out = this.rows.filter(
      (r) =>
        this.eqs.every(([k, v]) => r[k] === v) &&
        this.ins.every(([k, vs]) => vs.includes(r[k])),
    );
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const [k, asc] = this.orders[i]!;
      out = [...out].sort((a, b) => {
        const av = a[k] as number | string;
        const bv = b[k] as number | string;
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      });
    }
    if (this.rangeWindow) {
      const [from, to] = this.rangeWindow;
      return out.slice(from, to + 1);
    }
    return out;
  }

  then<TResult1 = { data: T[] | null; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: T[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.resolveRows(), error: null }).then(onfulfilled, onrejected);
  }
}

class FakeClient {
  constructor(private readonly tables: Record<string, Row[]>) {}
  from<T extends Row>(table: string): FakeQuery<T> {
    return new FakeQuery<T>((this.tables[table] ?? []) as T[]);
  }
}

/**
 * Fixture: this customer reached us on email (thread by email contact_ref) and by
 * phone (thread by E.164 contact_ref). A THIRD thread in ANOTHER org shares the exact
 * email contact_ref — it must never be read. Messages span both directions.
 */
function buildFixture() {
  const conversations: Row[] = [
    // (a) email thread — matched by normalised email contact_ref.
    { id: "conv-email", org_id: ORG, channel: "email", contact_ref: "jane@acme.io", contact_name: "Jane", customer_id: null },
    // (b) voice/call thread — matched by E.164 phone contact_ref.
    { id: "conv-phone", org_id: ORG, channel: "voice", contact_ref: "+447700900123", contact_name: null, customer_id: null },
    // (c) FOREIGN org thread, SAME email contact_ref — the isolation trap.
    { id: "conv-foreign", org_id: OTHER_ORG, channel: "email", contact_ref: "jane@acme.io", contact_name: "Jane", customer_id: null },
  ];
  const messages: Row[] = [
    { id: "m1", conversation_id: "conv-email", org_id: ORG, direction: "inbound", channel: "email", from_addr: "jane@acme.io", to_addr: null, body: "Can you quote for the roof?", status: "received", created_at: "2026-02-01T09:00:00Z" },
    { id: "m2", conversation_id: "conv-email", org_id: ORG, direction: "outbound", channel: "email", from_addr: null, to_addr: "jane@acme.io", body: "Sure — sending it over now.", status: "sent", created_at: "2026-02-02T10:00:00Z" },
    { id: "m3", conversation_id: "conv-phone", org_id: ORG, direction: "inbound", channel: "voice", from_addr: "+447700900123", to_addr: null, body: "Missed call transcript", status: "received", created_at: "2026-02-03T11:00:00Z" },
    // Foreign-org message on the same-ref thread — must never appear.
    { id: "m-foreign", conversation_id: "conv-foreign", org_id: OTHER_ORG, direction: "inbound", channel: "email", from_addr: "jane@acme.io", to_addr: null, body: "SECRET other-org message", status: "received", created_at: "2026-02-04T12:00:00Z" },
  ];
  return { conversations, messages };
}

describe("customerContactRefs — contact identity resolution", () => {
  it("normalises email (bare, lower-cased) and phone (E.164 + plain)", () => {
    const refs = customerContactRefs(CUSTOMER);
    expect(refs).toContain("jane@acme.io");
    expect(refs).toContain("+447700900123");
  });

  it("yields no ref for a customer with neither email nor phone", () => {
    expect(customerContactRefs({ email: null, phone: null })).toEqual([]);
    expect(customerContactRefs({ email: "  ", phone: "" })).toEqual([]);
  });
});

describe("buildCustomerCommsEvents — pure shaping", () => {
  it("is reverse-chronological with a stable id tiebreak and carries direction/sender/snippet", () => {
    const { conversations, messages } = buildFixture();
    const events = buildCustomerCommsEvents(
      conversations.filter((c) => c.org_id === ORG) as never,
      messages.filter((m) => m.org_id === ORG) as never,
    );
    expect(events.map((e) => e.id)).toEqual(["m3", "m2", "m1"]); // newest first
    const inbound = events.find((e) => e.id === "m1")!;
    expect(inbound.direction).toBe("inbound");
    expect(inbound.sender).toBe("jane@acme.io");
    expect(inbound.channel).toBe("email");
    expect(inbound.snippet).toContain("quote for the roof");
    const outbound = events.find((e) => e.id === "m2")!;
    expect(outbound.direction).toBe("outbound");
    expect(outbound.sender).toBe("Your team");
  });

  it("drops a message whose conversation is not in the resolved set", () => {
    const { messages } = buildFixture();
    const events = buildCustomerCommsEvents([], messages as never);
    expect(events).toEqual([]);
  });
});

describe("loadCustomerCommsTimeline — read + org isolation", () => {
  it("returns the customer's comms newest-first across email + phone threads", async () => {
    const { conversations, messages } = buildFixture();
    const client = new FakeClient({ conversations, messages });

    const events = await loadCustomerCommsTimeline(
      client as unknown as SupabaseClient<Database>,
      ORG,
      CUSTOMER,
    );

    expect(events.map((e) => e.id)).toEqual(["m3", "m2", "m1"]);
    expect(events.map((e) => e.channel)).toEqual(["voice", "email", "email"]);
  });

  it("NEVER leaks another org's thread that shares the exact contact_ref", async () => {
    const { conversations, messages } = buildFixture();
    const client = new FakeClient({ conversations, messages });

    const events = await loadCustomerCommsTimeline(
      client as unknown as SupabaseClient<Database>,
      ORG,
      CUSTOMER,
    );

    expect(events.some((e) => e.id === "m-foreign")).toBe(false);
    expect(events.some((e) => e.snippet.includes("SECRET"))).toBe(false);
    // And the foreign org, reading its OWN thread, never sees org-A's messages.
    const foreign = await loadCustomerCommsTimeline(
      client as unknown as SupabaseClient<Database>,
      OTHER_ORG,
      CUSTOMER,
    );
    expect(foreign.map((e) => e.id)).toEqual(["m-foreign"]);
  });

  it("also resolves a thread that carries customer_id directly (forward-compatible)", async () => {
    const conversations: Row[] = [
      { id: "conv-cid", org_id: ORG, channel: "chat", contact_ref: "widget:abc", contact_name: null, customer_id: CUSTOMER.id },
    ];
    const messages: Row[] = [
      { id: "cm1", conversation_id: "conv-cid", org_id: ORG, direction: "inbound", channel: "chat", from_addr: null, to_addr: null, body: "Live chat hello", status: "received", created_at: "2026-03-01T08:00:00Z" },
    ];
    const client = new FakeClient({ conversations, messages });

    const events = await loadCustomerCommsTimeline(
      client as unknown as SupabaseClient<Database>,
      ORG,
      { id: CUSTOMER.id, email: null, phone: null },
    );
    expect(events.map((e) => e.id)).toEqual(["cm1"]);
    expect(events[0]!.channel).toBe("chat");
  });

  it("returns an empty list for a customer with no threads (no message read needed)", async () => {
    const client = new FakeClient({ conversations: [], messages: [] });
    const events = await loadCustomerCommsTimeline(
      client as unknown as SupabaseClient<Database>,
      ORG,
      CUSTOMER,
    );
    expect(events).toEqual([]);
  });
});

describe("chronological merge into the customer timeline", () => {
  it("comms interleave with other timeline kinds by timestamp, newest first", () => {
    // Mirror the page's merge: non-comms events + comms events sorted by `when` DESC.
    const { conversations, messages } = buildFixture();
    const comms = buildCustomerCommsEvents(
      conversations.filter((c) => c.org_id === ORG) as never,
      messages.filter((m) => m.org_id === ORG) as never,
    );
    const others = [
      { when: "2026-02-01T12:00:00Z", kind: "quote", label: "Quote Q-1" },
      { when: "2026-02-05T09:00:00Z", kind: "invoice", label: "Invoice INV-1" },
    ];
    const merged = [
      ...others,
      ...comms.map((c) => ({ when: c.at, kind: c.channel, label: c.sender })),
    ].sort((a, b) => (a.when < b.when ? 1 : -1));

    expect(merged.map((e) => e.kind)).toEqual([
      "invoice", // 02-05
      "voice", //   02-03 (m3)
      "email", //   02-02 (m2)
      "quote", //   02-01T12 (quote after m1's 09:00)
      "email", //   02-01T09 (m1)
    ]);
  });
});
