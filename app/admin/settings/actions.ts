"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireHq } from "@/server/auth/hq";
import { updateSection } from "@/server/services/hq-settings";
import { SECTION_IDS, type SectionId } from "@/lib/hq/settings";

/**
 * Phase 4 — HQ settings server actions.
 *
 * One action: `saveSection(section, formData)`. The page renders a
 * <form action={saveSection.bind(null, section)}> per section so the
 * action is hidden-input-free.
 *
 * Every call:
 *   1. Re-checks isSuperAdminEmail (defence in depth — the layout
 *      already gates the page, but a leaked URL must not bypass).
 *   2. Picks the matching zod schema, validates, UPSERTs.
 *   3. Records to admin_activity_log with a before/after diff.
 *   4. Redirects back to /admin/settings#<section> with a status
 *      banner.
 */

function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as ReadonlyArray<string>).includes(value);
}

/**
 * Parse a FormData into a flat patch object. Checkbox absence means
 * "false" — without this we'd silently keep the prior value when
 * the operator unchecks a box, which would be a surprising UX.
 */
function formDataToPatch(
  section: SectionId,
  formData: FormData,
): Record<string, unknown> {
  // Booleans declared on the schema — we need their names so we can
  // resolve "unchecked → false". We keep this list inline (rather
  // than reading from the zod object) because zod's introspection
  // surface is awkward to traverse at runtime.
  const BOOLEAN_KEYS: Record<SectionId, string[]> = {
    general: [],
    notifications: [
      "send_during_quiet_hours_for_urgent",
      "daily_digest_enabled",
    ],
    alerts: [],
    billing: [],
    branding: [],
    support: [],
    integrations: [
      "stripe_connected",
      "resend_connected",
      "whatsapp_connected",
    ],
    feature_flags: [
      "enable_ai_coo",
      "enable_whatsapp_outbound",
      "enable_self_service_billing",
    ],
  };

  const patch: Record<string, unknown> = {};
  // Capture every field the form submitted.
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("__")) continue; // reserved
    patch[k] = typeof v === "string" ? v : String(v);
  }
  // Force-false for declared booleans the form omitted.
  for (const k of BOOLEAN_KEYS[section]) {
    if (k in patch) {
      patch[k] = patch[k] === "on" || patch[k] === "true";
    } else {
      patch[k] = false;
    }
  }
  return patch;
}

export async function saveSection(
  section: string,
  formData: FormData,
): Promise<void> {
  const admin = await requireHq();
  if (!isSectionId(section)) {
    redirect(`/admin/settings?error=${encodeURIComponent("unknown_section")}`);
  }
  const patch = formDataToPatch(section, formData);
  const result = await updateSection(section, patch, admin);

  if (!result.ok) {
    redirect(
      `/admin/settings?section=${section}&error=${encodeURIComponent(result.error)}#${section}`,
    );
  }

  revalidatePath("/admin/settings");
  if (result.changedKeys.length === 0) {
    redirect(`/admin/settings?section=${section}&saved=nothing#${section}`);
  }
  redirect(
    `/admin/settings?section=${section}&saved=${result.changedKeys.length}#${section}`,
  );
}
