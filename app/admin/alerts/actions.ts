"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireHq } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { ALERT_RULE_IDS } from "@/lib/hq/alert-rules";

/**
 * Alerts (HQ-5) — server actions.
 *
 * Every action:
 *   1. Re-checks isSuperAdminEmail (defence-in-depth — the page
 *      already gates, but a leaked action URL must not be exploitable).
 *   2. UPSERTs into admin_alert_state keyed by (rule_id, org_id).
 *   3. Writes a row to admin_activity_log via recordAdminActivity so
 *      the per-customer timeline records "you marked this alert
 *      resolved at X with note Y".
 *
 * Audit writes are best-effort — never fail the primary update.
 *
 * Future-compat:
 *   - bulkMarkResolved is shaped for an LLM coach that picks
 *     a batch of "auto-resolvable" alerts and clears them.
 *   - assignAlert sets admin_alert_state.assigned_to so the future
 *     /admin/alerts?owner=me query plays nicely.
 *   - Channel dispatchers (email / WhatsApp / SMS) will hook into
 *     the recordAdminActivity event stream — no change needed here.
 */

// --------------------------------------------------------------------
// Type-narrow admin client helper (mirrors hq-billing-snapshot).
// admin_alert_state is post-generated-types — we cast through unknown
// to keep the chain typed without re-generating supabase types.
// --------------------------------------------------------------------

type AnyMutationResult = Promise<{
  data: unknown | null;
  error: { message: string } | null;
}>;

type AnyQueryResult = Promise<{
  data: unknown | null;
  error: { message: string } | null;
}>;

function alertStateTable() {
  const admin = createAdminClient();
  return admin.from("admin_alert_state" as never) as unknown as {
    upsert: (
      payload: unknown,
      opts?: { onConflict?: string },
    ) => AnyMutationResult;
    update: (payload: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => AnyMutationResult;
      };
    };
    select: (cols: string) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => AnyQueryResult;
        };
      };
    };
  };
}

// --------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------

const ruleIdSchema = z.enum(ALERT_RULE_IDS);
const orgIdSchema = z.string().uuid();

const snoozePresetSchema = z.enum(["1d", "3d", "7d", "30d"]);
const SNOOZE_DAYS: Record<z.infer<typeof snoozePresetSchema>, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
};

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

async function upsertState(
  ruleId: string,
  orgId: string,
  patch: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  const payload = {
    rule_id: ruleId,
    org_id: orgId,
    created_by: actorId,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  const res = await alertStateTable().upsert(payload, {
    onConflict: "rule_id,org_id",
  });
  if (res.error) {
    console.error("[alerts] upsertState failed", res.error.message);
    redirect(`/admin/alerts?error=update_failed`);
  }
}

function alertTargetId(ruleId: string, orgId: string): string {
  // admin_activity_log.target_id is a single string — use the
  // composite key so the per-customer timeline can find it.
  return `${ruleId}:${orgId}`;
}

// --------------------------------------------------------------------
// markAlertRead — clear the unread badge
// --------------------------------------------------------------------

export async function markAlertRead(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = z
    .object({ rule_id: ruleIdSchema, org_id: orgIdSchema })
    .safeParse({
      rule_id: formData.get("rule_id"),
      org_id: formData.get("org_id"),
    });
  if (!parsed.success) redirect("/admin/alerts?error=invalid_input");

  await upsertState(
    parsed.data.rule_id,
    parsed.data.org_id,
    { read_at: new Date().toISOString() },
    admin.id,
  );

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.read",
    targetTable: "admin_alert_state",
    targetId: alertTargetId(parsed.data.rule_id, parsed.data.org_id),
    metadata: { rule_id: parsed.data.rule_id, org_id: parsed.data.org_id },
  });

  revalidatePath("/admin/alerts");
}

// --------------------------------------------------------------------
// markAlertResolved — auto-archives from the default list view
// --------------------------------------------------------------------

const resolveSchema = z.object({
  rule_id: ruleIdSchema,
  org_id: orgIdSchema,
  resolution_note: z.string().trim().max(2000).optional(),
});

export async function markAlertResolved(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = resolveSchema.safeParse({
    rule_id: formData.get("rule_id"),
    org_id: formData.get("org_id"),
    resolution_note: formData.get("resolution_note") ?? "",
  });
  if (!parsed.success) redirect("/admin/alerts?error=invalid_input");

  const now = new Date().toISOString();
  await upsertState(
    parsed.data.rule_id,
    parsed.data.org_id,
    {
      resolved_at: now,
      // Mark as read when resolved so it doesn't bounce back into unread.
      read_at: now,
      resolution_note: parsed.data.resolution_note || null,
    },
    admin.id,
  );

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.resolved",
    targetTable: "admin_alert_state",
    targetId: alertTargetId(parsed.data.rule_id, parsed.data.org_id),
    metadata: {
      rule_id: parsed.data.rule_id,
      org_id: parsed.data.org_id,
      resolution_note: parsed.data.resolution_note ?? null,
    },
  });

  // Also write a per-org audit row so it shows up on /admin/customers/[id].
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.resolved",
    targetTable: "organizations",
    targetId: parsed.data.org_id,
    metadata: {
      rule_id: parsed.data.rule_id,
      resolution_note: parsed.data.resolution_note ?? null,
    },
  });

  revalidatePath("/admin/alerts");
  revalidatePath(`/admin/customers/${parsed.data.org_id}`);
}

// --------------------------------------------------------------------
// snoozeAlert — hide for N days
// --------------------------------------------------------------------

const snoozeSchema = z.object({
  rule_id: ruleIdSchema,
  org_id: orgIdSchema,
  preset: snoozePresetSchema,
});

export async function snoozeAlert(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = snoozeSchema.safeParse({
    rule_id: formData.get("rule_id"),
    org_id: formData.get("org_id"),
    preset: formData.get("preset"),
  });
  if (!parsed.success) redirect("/admin/alerts?error=invalid_input");

  const days = SNOOZE_DAYS[parsed.data.preset];
  const until = new Date(Date.now() + days * 86_400_000).toISOString();

  await upsertState(
    parsed.data.rule_id,
    parsed.data.org_id,
    {
      snoozed_until: until,
      // Read when snoozed — operator has acknowledged.
      read_at: new Date().toISOString(),
    },
    admin.id,
  );

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.snoozed",
    targetTable: "admin_alert_state",
    targetId: alertTargetId(parsed.data.rule_id, parsed.data.org_id),
    metadata: {
      rule_id: parsed.data.rule_id,
      org_id: parsed.data.org_id,
      preset: parsed.data.preset,
      until,
    },
  });

  revalidatePath("/admin/alerts");
}

// --------------------------------------------------------------------
// assignAlert — owner pickup
// --------------------------------------------------------------------

const assignSchema = z.object({
  rule_id: ruleIdSchema,
  org_id: orgIdSchema,
  assignee_user_id: z.string().uuid().nullable().or(z.literal("")),
});

export async function assignAlert(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = assignSchema.safeParse({
    rule_id: formData.get("rule_id"),
    org_id: formData.get("org_id"),
    assignee_user_id: formData.get("assignee_user_id") ?? "",
  });
  if (!parsed.success) redirect("/admin/alerts?error=invalid_input");

  // Empty string = unassign.
  const assignedTo =
    parsed.data.assignee_user_id && parsed.data.assignee_user_id !== ""
      ? parsed.data.assignee_user_id
      : null;

  await upsertState(
    parsed.data.rule_id,
    parsed.data.org_id,
    {
      assigned_to: assignedTo,
      // Assigning implies acknowledgement.
      read_at: new Date().toISOString(),
    },
    admin.id,
  );

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.assigned",
    targetTable: "admin_alert_state",
    targetId: alertTargetId(parsed.data.rule_id, parsed.data.org_id),
    metadata: {
      rule_id: parsed.data.rule_id,
      org_id: parsed.data.org_id,
      assigned_to: assignedTo,
    },
  });

  revalidatePath("/admin/alerts");
}

// --------------------------------------------------------------------
// reopenAlert — un-resolve (mistake recovery)
// --------------------------------------------------------------------

const reopenSchema = z.object({
  rule_id: ruleIdSchema,
  org_id: orgIdSchema,
});

export async function reopenAlert(formData: FormData): Promise<void> {
  const admin = await requireHq();
  const parsed = reopenSchema.safeParse({
    rule_id: formData.get("rule_id"),
    org_id: formData.get("org_id"),
  });
  if (!parsed.success) redirect("/admin/alerts?error=invalid_input");

  await upsertState(
    parsed.data.rule_id,
    parsed.data.org_id,
    {
      resolved_at: null,
      snoozed_until: null,
      resolution_note: null,
      read_at: null,
    },
    admin.id,
  );

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "alert.reopened",
    targetTable: "admin_alert_state",
    targetId: alertTargetId(parsed.data.rule_id, parsed.data.org_id),
    metadata: {
      rule_id: parsed.data.rule_id,
      org_id: parsed.data.org_id,
    },
  });

  revalidatePath("/admin/alerts");
}
