import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TRANSCRIPT PERSISTENCE + DUPLICATE RECOVERY — the media-ledger seam.
 *
 * Built DARK: the WhatsApp transport is null in prod, so none of this executes
 * today. These tests pin the load-bearing contract for the day it does:
 *
 *   • persistVoiceNoteTranscription writes ONLY transcript/transcript_status,
 *     keyed on org_id + content_hash (the SHA-256 of the exact audio bytes) —
 *     it NEVER includes the write-once evidence columns (content_hash,
 *     storage_path) in a payload, and NEVER downgrades a completed row.
 *   • resolveDuplicateTranscription returns the transcript the org ALREADY
 *     PAID for on a governor `duplicate` outcome — a webhook redelivery must
 *     not lose it — and defers honestly when none is persisted. It makes no
 *     provider call and reports no usage (no double-metering).
 *   • Both are best-effort: a storage error degrades, never throws.
 */

type CapturedUpdate = {
  table: string;
  payload: Record<string, unknown>;
  eqs: Array<[string, string]>;
  neqs: Array<[string, string]>;
};

const h = vi.hoisted(() => ({
  updates: [] as CapturedUpdate[],
  selectRows: [] as Array<{ transcript: string | null }>,
  selectEqs: [] as Array<[string, string]>,
  updateError: null as { message: string } | null,
  selectError: null as { message: string } | null,
  throwOnConstruct: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (h.throwOnConstruct) throw new Error("no admin client available");
    return {
      from: (table: string) => {
        const cap: CapturedUpdate = { table, payload: {}, eqs: [], neqs: [] };
        return {
          update(payload: Record<string, unknown>) {
            cap.payload = payload;
            h.updates.push(cap);
            const chain = {
              eq(k: string, v: string) {
                cap.eqs.push([k, v]);
                return chain;
              },
              neq(k: string, v: string) {
                cap.neqs.push([k, v]);
                return Promise.resolve({ error: h.updateError });
              },
            };
            return chain;
          },
          select(_cols: string) {
            const chain = {
              eq(k: string, v: string) {
                h.selectEqs.push([k, v]);
                return chain;
              },
              limit(_n: number) {
                return Promise.resolve({ data: h.selectRows, error: h.selectError });
              },
            };
            return chain;
          },
        };
      },
    };
  },
}));

import {
  persistVoiceNoteTranscription,
  resolveDuplicateTranscription,
  voiceNoteContentHash,
  type TranscriptionResult,
} from "@/lib/ai/transcription";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const audio = new Uint8Array([1, 2, 3, 4]);
const audioSha = createHash("sha256").update(audio).digest("hex");

beforeEach(() => {
  h.updates = [];
  h.selectRows = [];
  h.selectEqs = [];
  h.updateError = null;
  h.selectError = null;
  h.throwOnConstruct = false;
});

describe("persistVoiceNoteTranscription — write shape", () => {
  const completed: TranscriptionResult = {
    status: "completed",
    transcript: "boiler fixed, invoice to follow",
    provider: "p",
    model: "m",
  };

  it("keys the UPDATE on org_id + content_hash (the SHA-256 of the exact bytes)", async () => {
    const ok = await persistVoiceNoteTranscription({ orgId: ORG, audio, result: completed });
    expect(ok).toBe(true);
    expect(voiceNoteContentHash(audio)).toBe(audioSha);
    const u = h.updates[0]!;
    expect(u.table).toContain("whatsapp_inbound_media");
    expect(u.eqs).toEqual([
      ["org_id", ORG],
      ["content_hash", audioSha],
    ]);
  });

  it("completed ⇒ writes EXACTLY { transcript, transcript_status } — never the evidence columns", async () => {
    await persistVoiceNoteTranscription({ orgId: ORG, audio, result: completed });
    const u = h.updates[0]!;
    expect(Object.keys(u.payload).sort()).toEqual(["transcript", "transcript_status"]);
    expect(u.payload.transcript_status).toBe("completed");
    expect(u.payload.transcript).toBe("boiler fixed, invoice to follow");
    // The write-once evidence columns (immutability trigger, migration
    // 20261127 :104-124) are never in the payload.
    expect(u.payload).not.toHaveProperty("content_hash");
    expect(u.payload).not.toHaveProperty("storage_path");
  });

  it("deferred ⇒ writes ONLY transcript_status:'deferred' (transcript untouched, never fabricated)", async () => {
    await persistVoiceNoteTranscription({
      orgId: ORG,
      audio,
      result: { status: "deferred", transcript: null, reason: "no_model_bound" },
    });
    const u = h.updates[0]!;
    expect(Object.keys(u.payload)).toEqual(["transcript_status"]);
    expect(u.payload.transcript_status).toBe("deferred");
  });

  it("failed ⇒ writes ONLY transcript_status:'failed'", async () => {
    await persistVoiceNoteTranscription({
      orgId: ORG,
      audio,
      result: { status: "failed", transcript: null, error: "provider_500" },
    });
    const u = h.updates[0]!;
    expect(Object.keys(u.payload)).toEqual(["transcript_status"]);
    expect(u.payload.transcript_status).toBe("failed");
  });

  it("NEVER downgrades: every write excludes rows already completed", async () => {
    for (const result of [
      completed,
      { status: "deferred", transcript: null, reason: "no_model_bound" } as const,
      { status: "failed", transcript: null, error: "x" } as const,
    ]) {
      await persistVoiceNoteTranscription({ orgId: ORG, audio, result });
    }
    for (const u of h.updates) {
      expect(u.neqs).toEqual([["transcript_status", "completed"]]);
    }
  });

  it("is best-effort: an update error returns false, a thrown client returns false — never throws", async () => {
    h.updateError = { message: "boom" };
    await expect(
      persistVoiceNoteTranscription({ orgId: ORG, audio, result: completed }),
    ).resolves.toBe(false);
    h.updateError = null;
    h.throwOnConstruct = true;
    await expect(
      persistVoiceNoteTranscription({ orgId: ORG, audio, result: completed }),
    ).resolves.toBe(false);
  });
});

describe("resolveDuplicateTranscription — a redelivery never loses a paid transcript", () => {
  it("returns COMPLETED with the persisted transcript for this org + content hash", async () => {
    h.selectRows = [{ transcript: "customer confirmed Tuesday" }];
    const r = await resolveDuplicateTranscription({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("completed");
    if (r.status === "completed") {
      expect(r.transcript).toBe("customer confirmed Tuesday");
      // Recovery re-reads — it never re-meters (no usage ⇒ no double spend),
      // and it says so: the recovered provenance marker (activation P2).
      expect(r.usage).toBeUndefined();
      expect(r.recovered).toBe(true);
    }
    // The read is scoped to the org, the exact bytes, and completed rows only.
    expect(h.selectEqs).toEqual([
      ["org_id", ORG],
      ["content_hash", audioSha],
      ["transcript_status", "completed"],
    ]);
  });

  it("defers honestly (null transcript) when nothing is persisted", async () => {
    h.selectRows = [];
    const r = await resolveDuplicateTranscription({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("deferred");
    expect(r.transcript).toBeNull();
  });

  it("defers honestly on a read error or a thrown client — never throws, never fabricates", async () => {
    h.selectError = { message: "boom" };
    const r1 = await resolveDuplicateTranscription({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r1.status).toBe("deferred");
    expect(r1.transcript).toBeNull();
    h.selectError = null;
    h.throwOnConstruct = true;
    const r2 = await resolveDuplicateTranscription({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r2.status).toBe("deferred");
    expect(r2.transcript).toBeNull();
  });

  it("an empty persisted transcript is NOT returned as completed", async () => {
    h.selectRows = [{ transcript: "   " }];
    const r = await resolveDuplicateTranscription({ orgId: ORG, audio, mimeType: "audio/ogg" });
    expect(r.status).toBe("deferred");
  });
});

describe("source pins — the wiring that is dark-unreachable in tests", () => {
  const src = readFileSync(
    resolve(__dirname, "../../lib/ai/transcription.ts"),
    "utf8",
  );

  it("transcribeVoiceNoteGoverned routes the governor's DUPLICATE outcome to the persisted re-read", () => {
    // The activated path can't execute while TRANSCRIPTION_MODEL is null, so
    // the branch is pinned at source: a duplicate outcome must resolve via
    // resolveDuplicateTranscription, not fall through to a blind defer.
    expect(src).toMatch(/outcome\.status === "duplicate"[\s\S]{0,200}resolveDuplicateTranscription\(input\)/);
  });

  it("the webhook note path persists every transcription outcome", () => {
    const actions = readFileSync(
      resolve(__dirname, "../../server/services/whatsapp-assistant-actions.ts"),
      "utf8",
    );
    expect(actions).toMatch(/persistVoiceNoteTranscription\(\{ orgId, audio: input\.media\.bytes, result: t \}\)/);
  });
});
