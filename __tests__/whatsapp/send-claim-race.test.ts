import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Double-approve wire race (activation-hardening P2-6) — unit tier.
 *
 * The audit's finding: the partial-unique `(dedup_key) where status='sent'`
 * index is written AFTER provider.send, so two CONCURRENT approvals of one
 * held reply both passed the dedup probe and both hit the wire — the customer
 * got the message twice; only the second RECORD failed. The fix claims the
 * send slot (ai_reply_send_claims, PK org+dedup_key) BEFORE the provider call.
 *
 * This suite drives the REAL dispatchHumanReviewedReply concurrently against a
 * stateful in-memory database mock whose INSERT honours the primary key —
 * exactly the atomicity Postgres provides — and a provider that records every
 * wire contact. THE assertion: one wire send, an honest duplicate for the
 * loser. Plus: a FAILED send releases the claim so a retry may attempt again,
 * and a sequential second approve reports the sent transport as its duplicate.
 */

const state = vi.hoisted(() => ({
  claims: new Map<string, { claimed_at: number }>(),
  sentTransports: [] as Array<{ id: string; org_id: string; dedup_key: string | null }>,
  transportRpcs: [] as Array<Record<string, unknown>>,
  auditSeq: 0,
  transportSeq: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "record_ai_reply_audit") {
        state.auditSeq += 1;
        return { data: `audit-${state.auditSeq}`, error: null };
      }
      if (fn === "record_ai_reply_transport") {
        state.transportRpcs.push(args);
        state.transportSeq += 1;
        const id = `transport-${state.transportSeq}`;
        if (args.p_status === "sent") {
          state.sentTransports.push({
            id,
            org_id: String(args.p_org_id),
            dedup_key: (args.p_dedup_key as string | null) ?? null,
          });
        }
        return { data: id, error: null };
      }
      throw new Error(`unexpected rpc: ${fn}`);
    },
    from: (table: string) => {
      if (table === "whatsapp_optouts") {
        const chain = {
          eq: () => chain,
          limit: async () => ({ data: [], error: null }),
          select: () => chain,
        };
        return { select: () => chain };
      }
      if (table === "ai_reply_transports") {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq: (k: string, v: unknown) => {
            filters[k] = v;
            return chain;
          },
          limit: async () => ({
            data: state.sentTransports
              .filter((t) => t.org_id === filters.org_id && t.dedup_key === filters.dedup_key)
              .map((t) => ({ id: t.id })),
            error: null,
          }),
        };
        return { select: () => chain };
      }
      if (table === "ai_reply_send_claims") {
        return {
          // THE ATOMIC CLAIM: honours the (org_id, dedup_key) primary key the
          // migration declares — a second insert collides with 23505.
          insert: async (row: { org_id: string; dedup_key: string }) => {
            const key = `${row.org_id}:${row.dedup_key}`;
            if (state.claims.has(key)) {
              return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
            }
            state.claims.set(key, { claimed_at: Date.now() });
            return { error: null };
          },
          update: () => {
            const filters: Record<string, unknown> = {};
            let cutoffMs = 0;
            const chain = {
              eq: (k: string, v: unknown) => {
                filters[k] = v;
                return chain;
              },
              lt: (_k: string, v: unknown) => {
                cutoffMs = Date.parse(String(v));
                return chain;
              },
              select: async () => {
                const key = `${filters.org_id}:${filters.dedup_key}`;
                const row = state.claims.get(key);
                if (!row || row.claimed_at >= cutoffMs) return { data: [], error: null };
                row.claimed_at = Date.now();
                return { data: [{ dedup_key: String(filters.dedup_key) }], error: null };
              },
            };
            return chain;
          },
          delete: () => {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq: (k: string, v: unknown) => {
                filters[k] = v;
                const done =
                  filters.org_id !== undefined && filters.dedup_key !== undefined;
                if (done) {
                  state.claims.delete(`${filters.org_id}:${filters.dedup_key}`);
                  return Promise.resolve({ error: null }) as never;
                }
                return chain as never;
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const provider = vi.hoisted(() => ({
  info: { provider: "meta", channel: "whatsapp" as const },
  send: vi.fn(),
}));
vi.mock("@/lib/comms", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getTransportProvider: () => provider,
    smsCostUsd: () => null,
  };
});

import { dispatchHumanReviewedReply } from "@/server/services/receptionist";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const CLEAN = "Thanks — a member of the team will get back to you shortly.";

function approveHeldReply(reviewAuditId: string) {
  return dispatchHumanReviewedReply({
    org_id: ORG,
    channel: "whatsapp_msg",
    draft: CLEAN,
    review_audit_id: reviewAuditId,
    reviewed_by: "reviewer-1",
    destination: "+447700900123",
  });
}

afterEach(() => {
  state.claims.clear();
  state.sentTransports = [];
  state.transportRpcs = [];
  state.auditSeq = 0;
  state.transportSeq = 0;
  provider.send.mockReset();
});

describe("P2-6 — the claim is taken BEFORE the wire", () => {
  it("TWO CONCURRENT approvals of one held reply ⇒ EXACTLY ONE provider send; the loser gets an honest in-flight duplicate", async () => {
    provider.send.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ providerMessageId: "wamid.RACE.1", status: "accepted" }), 30),
        ),
    );

    const [a, b] = await Promise.all([approveHeldReply("held-1"), approveHeldReply("held-1")]);

    // THE exploit assertion: one wire contact, ever.
    expect(provider.send).toHaveBeenCalledTimes(1);

    const outcomes = [a.transport, b.transport];
    const sent = outcomes.filter((t) => t.status === "sent");
    const refused = outcomes.filter((t) => t.duplicate);
    expect(sent).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.attempted).toBe(false);
    // The winner had not RECORDED yet when the loser was refused, so the
    // honest reason is in-flight (a later retry would read `duplicate`).
    expect(["send_in_flight", "duplicate"]).toContain(refused[0]?.failure_reason);
    // Exactly ONE sent row was recorded in the ledger.
    expect(state.transportRpcs.filter((r) => r.p_status === "sent")).toHaveLength(1);
  });

  it("a SEQUENTIAL second approve short-circuits on the claim and reports the SENT transport as its duplicate", async () => {
    provider.send.mockResolvedValue({ providerMessageId: "wamid.SEQ.1", status: "accepted" });
    const first = await approveHeldReply("held-2");
    expect(first.transport.status).toBe("sent");

    const second = await approveHeldReply("held-2");
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(second.transport.duplicate).toBe(true);
    expect(second.transport.status).toBe("skipped");
    expect(second.transport.failure_reason).toBe("duplicate");
    expect(second.transport.transport_id).toBe(first.transport.transport_id);
  });

  it("a FAILED send RELEASES the claim — a legitimate retry may attempt again (no permanent lock-out)", async () => {
    provider.send.mockRejectedValueOnce(new Error("meta 500"));
    const failed = await approveHeldReply("held-3");
    expect(failed.transport.status).toBe("failed");
    expect(failed.transport.failure_reason).toBe("provider_error");

    provider.send.mockResolvedValueOnce({ providerMessageId: "wamid.RETRY.1", status: "accepted" });
    const retry = await approveHeldReply("held-3");
    expect(retry.transport.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(2);
  });
});
