"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  aiReceptionistSetupSchema,
  parseClosureDates,
  parseStaffNumbers,
  parseWeeklyHours,
} from "@/lib/ai-receptionist/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Customer-side AI receptionist setup actions.
 *
 *   saveAiReceptionistSetup
 *     - Upserts the org's ai_receptionist_setups row.
 *     - Owner/admin only (RLS enforces this; we also check membership
 *       role so the UI fails cleanly).
 *     - When enabled flips on, status moves to 'not_started' so HQ
 *       picks it up; when it flips off, status is preserved (HQ can
 *       still re-activate if needed).
 *
 * Audit-log every save so HQ has full context.
 */

type AiReceptionistValues = Record<string, unknown>;

export async function saveAiReceptionistSetup(
  _prev: FormState<AiReceptionistValues>,
  formData: FormData,
): Promise<FormState<AiReceptionistValues>> {
  const { ctx, user } = await requireOrgContext();

  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return formError("Only owners and admins can manage the AI Receptionist.");
  }

  const result = validateFormData(formData, aiReceptionistSetupSchema);
  if (!result.ok) return result.state as FormState<AiReceptionistValues>;

  const data = result.data;

  // Parse the STRUCTURED answering-policy fields from the flat form (the nested
  // weekly hours, staff numbers and closures are not expressible as Zod scalars).
  // Surface precise per-field errors rather than silently dropping bad input.
  const staff = parseStaffNumbers(formData.get("staff_numbers")?.toString() ?? "");
  const closures = parseClosureDates(formData.get("closures")?.toString() ?? "");
  const weekly = parseWeeklyHours((name) => formData.get(name)?.toString() ?? null);

  const fieldErrors: Record<string, string> = { ...weekly.errors };
  if (staff.invalid.length > 0) {
    fieldErrors.staff_numbers = `Not valid phone numbers: ${staff.invalid.join(", ")}. Use international format, e.g. +447700900123.`;
  }
  if (closures.invalid.length > 0) {
    fieldErrors.closures = `Not valid dates: ${closures.invalid.join(", ")}. Use YYYY-MM-DD.`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      error: "Please fix the highlighted fields.",
      fieldErrors,
      values: data as AiReceptionistValues,
      submittedAt: Date.now(),
    };
  }

  const supabase = await createClient();

  // Check if a row already exists so we know whether this is the first
  // enable (status default 'not_started') or a re-save.
  const { data: existing } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { id: string; enabled: boolean; status: string } | null;
          }>;
        };
      };
    }
  )
    .select("id, enabled, status")
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  const payload = {
    org_id: ctx.org.id,
    enabled: data.enabled,
    business_phone: data.business_phone ?? null,
    whatsapp_number: data.whatsapp_number ?? null,
    facebook_page: data.facebook_page ?? null,
    instagram_handle: data.instagram_handle ?? null,
    preferred_voice: data.preferred_voice ?? null,
    business_hours: data.business_hours ?? null,
    trade_type: data.trade_type ?? null,
    // Structured answering policy (Twilio receptionist PR 2/3).
    answering_mode: data.answering_mode,
    timezone: data.timezone,
    weekly_hours: weekly.weekly,
    closures: closures.dates,
    ring_timeout_seconds: data.ring_timeout_seconds,
    staff_numbers: staff.numbers,
    fallback_number: data.fallback_number ?? null,
    urgent_escalation_number: data.urgent_escalation_number ?? null,
    greeting: data.greeting ?? null,
    service_areas: data.service_areas ?? null,
    recording_enabled: data.recording_enabled,
    transcription_enabled: data.transcription_enabled,
    recording_consent_message: data.recording_consent_message ?? null,
    notify_email: data.notify_email,
    notify_sms: data.notify_sms,
  };

  let setupId: string | null = null;
  let action: "ai_receptionist.enabled" | "ai_receptionist.disabled" | "ai_receptionist.updated";

  if (existing) {
    const wasEnabled = existing.enabled;
    const { error } = await (
      supabase.from("ai_receptionist_setups" as never) as unknown as {
        update: (row: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      }
    )
      .update(payload)
      .eq("id", existing.id);
    if (error) {
      console.error("[ai-receptionist] update failed", error);
      return formError("Couldn't save. Try again.", data as AiReceptionistValues);
    }
    setupId = existing.id;
    action = !wasEnabled && data.enabled
      ? "ai_receptionist.enabled"
      : wasEnabled && !data.enabled
        ? "ai_receptionist.disabled"
        : "ai_receptionist.updated";
  } else {
    const { data: inserted, error } = await (
      supabase.from("ai_receptionist_setups" as never) as unknown as {
        insert: (row: unknown) => {
          select: (cols: string) => {
            single: () => Promise<{
              data: { id: string } | null;
              error: { message: string } | null;
            }>;
          };
        };
      }
    )
      .insert(payload)
      .select("id")
      .single();
    if (error || !inserted) {
      console.error("[ai-receptionist] insert failed", error);
      return formError("Couldn't save. Try again.", data as AiReceptionistValues);
    }
    setupId = inserted.id;
    action = data.enabled ? "ai_receptionist.enabled" : "ai_receptionist.updated";
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action,
    targetTable: "ai_receptionist_setups",
    targetId: setupId,
    metadata: {
      org_id: ctx.org.id,
      enabled: data.enabled,
      business_phone: data.business_phone ?? null,
      trade_type: data.trade_type ?? null,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/settings/ai-receptionist");
  revalidatePath("/admin/ai-receptionist");
  return formSuccess({
    successMessage: data.enabled
      ? "Saved — our team will get this set up and tested for you."
      : "Saved.",
  });
}
