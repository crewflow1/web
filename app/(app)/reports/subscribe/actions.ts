"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import {
  isReportKey,
  isReportFormat,
  isReportCadence,
} from "@/lib/reports/registry";
import {
  insertReportSubscription,
  deleteReportSubscription as deleteSubscriptionRow,
  type SubscriptionsClient,
} from "@/lib/reports/subscriptions";

/**
 * Report-subscription actions — the write path behind the /reports subscribe UI.
 *
 * ADMIN-GATED, AND THE RLS IS THE REAL BOUNDARY. The role check produces a
 * sentence for the operator; the admin-write RLS on `report_subscriptions`
 * (migration 20261134000000) is what actually stops a non-admin, even one
 * forging the request. Every write is org-pinned. Route depth is 1 (`/reports`),
 * so no server navigation happens — the action returns state the client renders
 * inline and revalidates the page.
 */

export type SubscribeState = { ok: boolean; message: string };

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

// Mirrors the report_subscriptions.recipients CHECK regex — a bad address is
// rejected here with a friendly message before RLS/CHECK would reject the row.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export async function createReportSubscription(
  _prev: SubscribeState | null,
  formData: FormData,
): Promise<SubscribeState> {
  const reportKey = String(formData.get("report_key") ?? "");
  const format = String(formData.get("format") ?? "pdf");
  const cadence = String(formData.get("cadence") ?? "");
  const recipientsRaw = String(formData.get("recipients") ?? "");

  if (!isReportKey(reportKey)) return { ok: false, message: "Choose a report." };
  if (!isReportFormat(format)) return { ok: false, message: "Choose PDF or CSV." };
  if (!isReportCadence(cadence)) return { ok: false, message: "Choose how often to send." };

  const recipients = parseRecipients(recipientsRaw);
  if (recipients.length === 0) {
    return { ok: false, message: "Add at least one recipient email address." };
  }
  if (recipients.length > 20) {
    return { ok: false, message: "A subscription can have at most 20 recipients." };
  }
  const bad = recipients.find((r) => !EMAIL_RE.test(r));
  if (bad) return { ok: false, message: `"${bad}" is not a valid email address.` };

  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return { ok: false, message: "Only an owner or admin can schedule report delivery." };
  }

  const supabase = await createClient();
  const { error } = await insertReportSubscription(
    supabase as unknown as SubscriptionsClient,
    {
      org_id: ctx.org.id,
      report_key: reportKey,
      format,
      cadence,
      recipients,
      created_by: user.id,
    },
  );
  if (error) {
    console.error("[reports] create subscription failed", error);
    return { ok: false, message: "Could not create the subscription. Please try again." };
  }

  revalidatePath("/reports");
  return { ok: true, message: "Scheduled. The report will be emailed on its cadence." };
}

export async function deleteReportSubscription(
  _prev: SubscribeState | null,
  formData: FormData,
): Promise<SubscribeState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, message: "Missing subscription." };

  const { ctx } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return { ok: false, message: "Only an owner or admin can change report delivery." };
  }

  const supabase = await createClient();
  const { error } = await deleteSubscriptionRow(
    supabase as unknown as SubscriptionsClient,
    ctx.org.id,
    id,
  );
  if (error) {
    console.error("[reports] delete subscription failed", error);
    return { ok: false, message: "Could not remove the subscription." };
  }

  revalidatePath("/reports");
  return { ok: true, message: "Subscription removed." };
}
