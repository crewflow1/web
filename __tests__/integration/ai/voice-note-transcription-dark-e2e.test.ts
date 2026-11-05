import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  transcribeVoiceNoteGoverned,
  persistVoiceNoteTranscription,
  voiceNoteContentHash,
  isTranscriptionModelBound,
  isTranscriptionCredentialPresent,
} from "@/lib/ai/transcription";
import { buildSelftestWav } from "@/lib/ai/transcription/selftest";

/**
 * Voice-note transcription — SANDBOX VERIFIED dark-tier behaviour on real Postgres.
 *
 * The transcription tier is BUILT and model-bound in source, but this environment
 * is KEYLESS (no OPENAI/TRANSCRIPTION credential), so the tier is dark. Every
 * existing transcription test is a MOCKED unit test; none drives the governed
 * path against real Postgres. This proves the honest dark-path guarantees:
 *   - a governed transcription while dark short-circuits to `deferred/no_credential`,
 *     `transcript === null` — it NEVER fabricates content;
 *   - it is a true no-op against the cost ledger: ZERO `ai_invocations` and ZERO
 *     `ai_cost_reservations` rows for the org (no reservation, no spend);
 *   - the media-ledger persistence records only the honest status (`deferred`),
 *     never a transcript, and NEVER downgrades a transcript the org already paid for.
 *
 * SANDBOX, NOT LIVE: no OpenAI call is ever made (the transport is never reached
 * while dark; `fetch` is not touched). A real vendor transcription — a genuine
 * model round-trip producing real transcript text — is LIVE-only and requires a
 * credential plus the governor tier binding.
 */

const TOKEN = `it-vn-dark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const raw = () => serviceClient() as any;

function forceKeylessDarkTier(): void {
  // Belt-and-braces: guarantee the tier is credential-dark regardless of ambient env.
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("TRANSCRIPTION_API_KEY", "");
}

describeIntegration("voice-note transcription · SANDBOX VERIFIED dark tier (real Postgres)", () => {
  let orgId = "";

  beforeAll(async () => {
    const o = await raw().from("organizations").insert({ name: "VN Dark", slug: `${TOKEN}-a` }).select("id").single();
    expect(o.error, o.error?.message).toBeNull();
    orgId = String(o.data.id);
  });

  beforeEach(() => forceKeylessDarkTier());
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (orgId) await raw().from("organizations").delete().eq("id", orgId);
  });

  it("the tier is BOUND in source but CREDENTIAL-dark in this env (the exact dark reason)", () => {
    expect(isTranscriptionModelBound(), "the model binding is armed in source").toBe(true);
    expect(isTranscriptionCredentialPresent(), "no credential in this env → dark").toBe(false);
  });

  it("a governed transcription while dark DEFERS with a null transcript — never fabricates, never spends", async () => {
    const audio = buildSelftestWav(Date.now());
    const result = await transcribeVoiceNoteGoverned({
      orgId,
      userId: null,
      audio,
      mimeType: "audio/wav",
      durationSeconds: 2,
    });

    expect(result.status, "dark tier defers rather than inventing a transcript").toBe("deferred");
    expect(result.transcript, "NO fabricated content on the dark path").toBeNull();
    if (result.status === "deferred") {
      expect(["no_credential", "no_model_bound"]).toContain(result.reason);
    }

    // No reservation and no ledger row — the dark path short-circuits before any spend.
    const inv = await raw().from("ai_invocations").select("id").eq("org_id", orgId);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(inv.data ?? [], "zero ai_invocations for the org").toHaveLength(0);

    const resv = await raw().from("ai_cost_reservations").select("id").eq("org_id", orgId);
    expect(resv.error, resv.error?.message).toBeNull();
    expect(resv.data ?? [], "zero ai_cost_reservations for the org").toHaveLength(0);
  });

  it("media-ledger persistence of a dark result records 'deferred' + a NULL transcript (no fabrication)", async () => {
    const audio = buildSelftestWav(1234);
    const hash = voiceNoteContentHash(audio);
    // Seed a stored media row this voice note would attach to.
    const ins = await raw().from("whatsapp_inbound_media").insert({
      org_id: orgId,
      wamid: `wamid.${TOKEN}.m1`,
      media_id: `media_${TOKEN}_1`,
      message_type: "audio",
      mime_type: "audio/ogg",
      content_hash: hash,
      status: "stored",
      transcript_status: "none",
    });
    expect(ins.error, ins.error?.message).toBeNull();

    const ok = await persistVoiceNoteTranscription({
      orgId,
      audio,
      result: { status: "deferred", transcript: null, reason: "no_credential" },
    });
    expect(ok).toBe(true);

    const row = await raw()
      .from("whatsapp_inbound_media")
      .select("transcript_status, transcript")
      .eq("org_id", orgId)
      .eq("content_hash", hash);
    expect(row.error, row.error?.message).toBeNull();
    expect(row.data?.[0]?.transcript_status).toBe("deferred");
    expect(row.data?.[0]?.transcript, "a dark voice note keeps a null transcript — the note falls back to its placeholder").toBeNull();
  });

  it("NEVER downgrades a transcript the org already PAID for (completed stays completed)", async () => {
    const audio = buildSelftestWav(5678);
    const hash = voiceNoteContentHash(audio);
    const paidTranscript = "customer confirmed the Tuesday 9am slot";
    const ins = await raw().from("whatsapp_inbound_media").insert({
      org_id: orgId,
      wamid: `wamid.${TOKEN}.m2`,
      media_id: `media_${TOKEN}_2`,
      message_type: "audio",
      mime_type: "audio/ogg",
      content_hash: hash,
      status: "stored",
      transcript_status: "completed",
      transcript: paidTranscript,
    });
    expect(ins.error, ins.error?.message).toBeNull();

    // A later dark re-run must not clobber the paid transcript.
    await persistVoiceNoteTranscription({
      orgId,
      audio,
      result: { status: "deferred", transcript: null, reason: "no_credential" },
    });

    const row = await raw()
      .from("whatsapp_inbound_media")
      .select("transcript_status, transcript")
      .eq("org_id", orgId)
      .eq("content_hash", hash);
    expect(row.error, row.error?.message).toBeNull();
    expect(row.data?.[0]?.transcript_status, "completed is never downgraded").toBe("completed");
    expect(row.data?.[0]?.transcript).toBe(paidTranscript);
  });
});
