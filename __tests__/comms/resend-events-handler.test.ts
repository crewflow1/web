import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Resend delivery-events handler — attribute -> record (mocked Supabase).
 *
 * Proves: a matched event stamps the org + message and records once; a redelivery
 * (23505 on the unique (provider, provider_event_id)) folds to a duplicate no-op;
 * an unattributable event is still recorded, org-less; an id-less/typeless event
 * is rejected untouched.
 */

type Insert = Record<string, unknown>;
let messageMatch: { id: string; org_id: string } | null = { id: "msg-1", org_id: "org-1" };
let insertResult: { error: { message: string; code?: string } | null } = { error: null };
const inserts: Insert[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "messages") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: messageMatch ? [messageMatch] : [],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "comm_events") {
        return {
          insert: async (row: Insert) => {
            inserts.push(row);
            return insertResult;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { processResendEvent } from "@/server/services/resend-events-handler";

const body = (o: Record<string, unknown>) => JSON.stringify(o);

beforeEach(() => {
  messageMatch = { id: "msg-1", org_id: "org-1" };
  insertResult = { error: null };
  inserts.length = 0;
});

describe("processResendEvent", () => {
  it("records an attributed event with the matched org + message", async () => {
    const res = await processResendEvent({
      providerEventId: "svix-1",
      rawBody: body({ type: "email.opened", data: { email_id: "re_1", to: ["c@e.com"] } }),
    });
    expect(res).toEqual({
      event_type: "opened",
      recorded: true,
      duplicate: false,
      attributed: true,
      rejected: false,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      org_id: "org-1",
      message_id: "msg-1",
      provider: "resend",
      provider_event_id: "svix-1",
      provider_message_id: "re_1",
      event_type: "opened",
      recipient: "c@e.com",
    });
  });

  it("folds a redelivery to a duplicate no-op (unique-violation)", async () => {
    insertResult = { error: { message: "duplicate key value", code: "23505" } };
    const res = await processResendEvent({
      providerEventId: "svix-1",
      rawBody: body({ type: "email.opened", data: { email_id: "re_1" } }),
    });
    expect(res).toMatchObject({ recorded: false, duplicate: true });
  });

  it("records an unattributable event org-less (no matching message)", async () => {
    messageMatch = null;
    const res = await processResendEvent({
      providerEventId: "svix-2",
      rawBody: body({ type: "email.delivered", data: { email_id: "re_unknown" } }),
    });
    expect(res).toMatchObject({ attributed: false, recorded: true });
    expect(inserts[0]).toMatchObject({ org_id: null, message_id: null });
  });

  it("rejects an event with no email id (undedupable) without inserting", async () => {
    const res = await processResendEvent({
      providerEventId: "svix-3",
      rawBody: body({ type: "email.delivered", data: {} }),
    });
    expect(res).toMatchObject({ rejected: true, recorded: false });
    expect(inserts).toHaveLength(0);
  });

  it("returns null for an unparseable body", async () => {
    const res = await processResendEvent({ providerEventId: "svix-4", rawBody: "{bad" });
    expect(res).toBeNull();
  });
});
