"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AI_MONTHLY_CEILING_HARD_MAX_PENCE,
  hqBudgetOrgId,
  isAcceptableLimitPence,
} from "@/lib/ai/governor";
import { transcribeVoiceNoteGoverned } from "@/lib/ai/transcription";
import { buildSelftestWav, SELFTEST_WAV_SECONDS } from "@/lib/ai/transcription/selftest";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * /admin/ai-costs — server actions for the EDITABLE budget controls.
 *
 * THIN WRAPPERS over the audited service-role RPCs (supabase/migrations/
 * 20261147000000): ai_set_org_ceiling / ai_clear_org_ceiling /
 * ai_set_employee_limit / ai_clear_employee_limit. Those RPCs are the ONE
 * authority — they clamp to the hard safety max and write the audit row in the
 * SAME transaction, so a control change can neither exceed the cap nor land
 * without its audit, whatever an action does. These actions parse the form,
 * name the acting super-admin, call the RPC, and redirect.
 *
 * Gating, defence-in-depth: the /admin layout already 404s non-allowlisted
 * users; every action re-checks isSuperAdminEmail before touching anything, so a
 * stolen-cookie POST straight to an action URL still bounces. This is the same
 * posture as the Approval Console and AI Boardroom actions.
 *
 * NEVER activates anything: these edit the CONTROLS. The generative layer stays
 * dark (no tier bound), so a changed ceiling governs a path nothing reaches yet.
 */

/**
 * The reservation/control RPCs are newer than the generated Supabase types
 * (lib/supabase/types.ts), which regenerate on a separate cadence — the same gap
 * lib/ai/governor.ts handles with a narrow structural cast at the call site.
 */
type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
};
const rpc = (client: unknown) => client as unknown as Rpc;

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

function backTo(params: Record<string, string>): never {
  const sp = new URLSearchParams(params);
  revalidatePath("/admin/ai-costs");
  redirect(`/admin/ai-costs?${sp.toString()}`);
}

/**
 * Parse a pounds field (e.g. "40", "£40.00", "40.5") to INTEGER PENCE, or null
 * when it is not an acceptable value (finite, ≥ 0, ≤ the hard max).
 */
function penceFromPounds(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[£,\s]/g, "");
  if (cleaned.length === 0) return null;
  const pounds = Number(cleaned);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  const pence = Math.round(pounds * 100);
  return isAcceptableLimitPence(pence, AI_MONTHLY_CEILING_HARD_MAX_PENCE) ? pence : null;
}

const orgSchema = z.object({ org_id: z.string().uuid() });
const employeeSchema = z.object({
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

/** The optional reviewer note, trimmed and capped, or null. */
function noteFrom(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 500);
  return trimmed.length > 0 ? trimmed : null;
}

// ── Per-org ceiling ─────────────────────────────────────────────────────────

export async function setOrgCeilingAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = orgSchema.safeParse({ org_id: formData.get("org_id") });
  if (!parsed.success) backTo({ error: "Invalid organisation." });

  const pence = penceFromPounds(formData.get("pounds"));
  if (pence === null) {
    backTo({
      error: `Ceiling must be a number between £0 and £${(
        AI_MONTHLY_CEILING_HARD_MAX_PENCE / 100
      ).toFixed(0)}.`,
    });
  }

  const { error } = await rpc(createAdminClient()).rpc("ai_set_org_ceiling", {
    p_org_id: parsed.data.org_id,
    p_ceiling_pence: pence,
    p_set_by: admin.id,
    p_note: noteFrom(formData.get("note")),
  });
  if (error) {
    console.error("[ai-costs] setOrgCeiling failed", error);
    backTo({ error: "Couldn't save the ceiling — try again." });
  }
  backTo({ saved: "ceiling_set" });
}

export async function clearOrgCeilingAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = orgSchema.safeParse({ org_id: formData.get("org_id") });
  if (!parsed.success) backTo({ error: "Invalid organisation." });

  const { error } = await rpc(createAdminClient()).rpc("ai_clear_org_ceiling", {
    p_org_id: parsed.data.org_id,
    p_set_by: admin.id,
    p_note: null,
  });
  if (error) {
    console.error("[ai-costs] clearOrgCeiling failed", error);
    backTo({ error: "Couldn't clear the override — try again." });
  }
  backTo({ saved: "ceiling_cleared" });
}

// ── Per-employee limit ──────────────────────────────────────────────────────

export async function setEmployeeLimitAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = employeeSchema.safeParse({
    org_id: formData.get("org_id"),
    user_id: formData.get("user_id"),
  });
  if (!parsed.success) backTo({ error: "Invalid organisation or employee." });

  const pence = penceFromPounds(formData.get("pounds"));
  if (pence === null) {
    backTo({
      error: `Limit must be a number between £0 and £${(
        AI_MONTHLY_CEILING_HARD_MAX_PENCE / 100
      ).toFixed(0)}.`,
    });
  }

  const { error } = await rpc(createAdminClient()).rpc("ai_set_employee_limit", {
    p_org_id: parsed.data.org_id,
    p_user_id: parsed.data.user_id,
    p_limit_pence: pence,
    p_set_by: admin.id,
    p_note: noteFrom(formData.get("note")),
  });
  if (error) {
    console.error("[ai-costs] setEmployeeLimit failed", error);
    backTo({ error: "Couldn't save the limit — try again." });
  }
  backTo({ saved: "limit_set" });
}

// ── Transcription self-test ─────────────────────────────────────────────────

/**
 * "Run transcription self-test" — the PROVIDER-PROOF path for the STT tier
 * (armed 2026-09-13). Generates a ~2-second synthetic WAV in process (pure PCM
 * sine — our own bytes, no tenant audio) and runs it through the REAL
 * `transcribeVoiceNoteGoverned` against the HQ budget org: validation →
 * activation gates → atomic reservation → provider → settle → immutable ledger
 * row (feature `voice_note.transcription`, visible in the By-feature table on
 * this page). An honest, labelled ops diagnostic:
 *
 *   • It BYPASSES NOTHING. A dark or keyless tier refuses exactly as
 *     production would (a `deferred` outcome, rendered as such); a governor
 *     block/duplicate degrades identically. There is no side door.
 *   • It NEVER exposes a credential. The redirect carries only the outcome
 *     status, latency, provider/model label, and (for a completed run) the
 *     transcript of our own synthetic audio — a sine tone, so usually "".
 *   • Every run is audited (recordAdminActivity `transcription.selftest`).
 *
 * Same defence-in-depth gating as every action in this file: the /admin layout
 * 404s non-allowlisted users AND requireAdmin re-checks isSuperAdminEmail.
 */
export async function runTranscriptionSelftestAction(): Promise<void> {
  const admin = await requireAdmin();

  const orgId = hqBudgetOrgId();
  if (!orgId) {
    backTo({
      st_status: "refused",
      st_reason:
        "CREWFLOW_INTERNAL_ORG_ID unset — HQ-billed AI refuses fail-closed (no budget org to attribute the spend to).",
    });
  }

  // Nonce-varied bytes: each run is a fresh SHA-256, so the governor's dedupe
  // window and the seam's persist-first recovery never mask the provider.
  const audio = buildSelftestWav(Date.now());
  const startedAt = Date.now();
  const result = await transcribeVoiceNoteGoverned({
    orgId,
    userId: null, // HQ spend runs unattributed to an employee, like all HQ AI.
    audio,
    mimeType: "audio/wav",
    durationSeconds: SELFTEST_WAV_SECONDS,
  });
  const latencyMs = Date.now() - startedAt;

  const reason =
    result.status === "deferred"
      ? result.reason
      : result.status === "failed"
        ? result.error.slice(0, 120)
        : null;
  const recovered = result.status === "completed" && result.recovered === true;

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "transcription.selftest",
    targetTable: "ai_invocations",
    targetId: orgId,
    metadata: {
      status: result.status,
      latency_ms: latencyMs,
      reason,
      recovered,
      provider: result.status === "completed" ? result.provider : null,
      model: result.status === "completed" ? result.model : null,
      audio_bytes: audio.byteLength,
    },
  });

  backTo({
    st_status: result.status,
    st_ms: String(latencyMs),
    ...(reason ? { st_reason: reason } : {}),
    ...(result.status === "completed"
      ? {
          st_model: `${result.provider}/${result.model}`,
          st_text: result.transcript.slice(0, 300),
          ...(recovered ? { st_recovered: "1" } : {}),
        }
      : {}),
  });
}

export async function clearEmployeeLimitAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = employeeSchema.safeParse({
    org_id: formData.get("org_id"),
    user_id: formData.get("user_id"),
  });
  if (!parsed.success) backTo({ error: "Invalid organisation or employee." });

  const { error } = await rpc(createAdminClient()).rpc("ai_clear_employee_limit", {
    p_org_id: parsed.data.org_id,
    p_user_id: parsed.data.user_id,
    p_set_by: admin.id,
    p_note: null,
  });
  if (error) {
    console.error("[ai-costs] clearEmployeeLimit failed", error);
    backTo({ error: "Couldn't clear the limit — try again." });
  }
  backTo({ saved: "limit_cleared" });
}
