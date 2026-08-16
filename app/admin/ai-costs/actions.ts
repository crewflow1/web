"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AI_MONTHLY_CEILING_HARD_MAX_PENCE,
  isAcceptableLimitPence,
} from "@/lib/ai/governor";

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
