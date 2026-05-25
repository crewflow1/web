"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  DEMO_LIFECYCLE_STATUSES,
  isValidLifecycleStatus,
} from "@/lib/hq/demo-lifecycle";
import {
  onDemoApproved,
  onDemoContacted,
  onPaymentReceived,
  onSetupPaymentSent,
  promoteDemoToCustomer,
  type DemoRow,
  type LifecycleResult,
} from "@/server/services/demo-lifecycle";

/**
 * Demos CRM (HQ-2) — server actions.
 *
 * All gated by isSuperAdminEmail. Each action writes to two places:
 *   1. public.demo_requests  — the source of truth
 *   2. public.admin_activity_log — the per-target audit timeline that
 *      the kanban side panel renders for each demo
 *
 * Audit writes are best-effort and never fail the primary update.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    redirect("/dashboard");
  }
  return { id: user.id, email: user.email ?? "" };
}

// --------------------------------------------------------------------
// Status transitions (kanban drag-and-drop + button presses)
// --------------------------------------------------------------------

const moveSchema = z.object({
  demo_id: z.string().uuid(),
  status: z.enum(DEMO_LIFECYCLE_STATUSES),
  reason: z.string().trim().max(2000).optional(),
});

export async function moveDemoToStatus(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = moveSchema.safeParse({
    demo_id: formData.get("demo_id"),
    status: formData.get("status"),
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) redirect("/admin/demos?error=invalid_input");

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Pull the full row so the lifecycle service has every field it needs.
  const { data: rowRaw } = await supabase
    .from("demo_requests")
    .select("id, status, email, company, name, phone, linked_org_id" as never)
    .eq("id", parsed.data.demo_id)
    .maybeSingle();
  const row = rowRaw as unknown as DemoRow | null;
  if (!row) redirect("/admin/demos?error=not_found");

  // Audit-friendly fields land on the row for fast filtering later.
  type Update = {
    status: string;
    reviewed_by?: string | null;
    approved_at?: string | null;
    rejection_reason?: string | null;
  };
  const update: Update = { status: parsed.data.status };
  if (parsed.data.status === "won") {
    update.approved_at = now;
    update.reviewed_by = admin.id;
    update.rejection_reason = null;
  } else if (parsed.data.status === "lost") {
    update.reviewed_by = admin.id;
    update.rejection_reason = parsed.data.reason ?? null;
  } else if (parsed.data.status === "demo_booked") {
    update.reviewed_by = admin.id;
  }

  const { error } = await supabase
    .from("demo_requests")
    .update(update as never)
    .eq("id", parsed.data.demo_id);
  if (error) {
    console.error("[hq/demos] moveDemoToStatus failed", error);
    redirect("/admin/demos?error=update_failed");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: `demo.move_${parsed.data.status}`,
    targetTable: "demo_requests",
    targetId: parsed.data.demo_id,
    metadata: {
      from: row?.status ?? null,
      to: parsed.data.status,
      reason: parsed.data.reason ?? null,
      company: row?.company ?? null,
      email: row?.email ?? null,
    },
  });

  // -----------------------------------------------------------------
  // Real lifecycle side-effects. Status flip alone isn't enough —
  // each transition triggers the business operation behind it
  // (email, customer-org provisioning, etc).
  //
  // The lifecycle helpers write their own audit + email_sent /
  // email_failed entries to the timeline so the operator sees every
  // step that succeeded or failed.
  //
  // Surface the result back to the UI via the redirect querystring so
  // the toast can warn when something went wrong (e.g. RESEND_API_KEY
  // not set, auth invite hit a rate limit, etc).
  // -----------------------------------------------------------------
  let result: LifecycleResult | null = null;
  const refreshed = row!; // FK-safe shorthand for the lifecycle calls

  switch (parsed.data.status) {
    case "contacted":
      result = await onDemoContacted({ demo: refreshed, actor: admin });
      break;
    case "won":
      result = await onDemoApproved({ demo: refreshed, actor: admin });
      break;
    case "payment_sent":
      result = await onSetupPaymentSent({ demo: refreshed, actor: admin });
      break;
    case "payment_received":
      result = await onPaymentReceived({ demo: refreshed, actor: admin });
      break;
    case "active_onboarding":
      result = await promoteDemoToCustomer({ demo: refreshed, actor: admin });
      break;
    default:
      result = null; // no side-effects for lost / demo_booked / demo_done / active
  }

  revalidatePath("/admin/demos");
  revalidatePath("/admin/customers");
  revalidatePath("/admin/onboarding");

  // Compose a redirect that surfaces the lifecycle outcome.
  const params = new URLSearchParams({
    saved: parsed.data.status,
    demo: parsed.data.demo_id,
  });
  if (result) {
    if (result.done.length > 0) params.set("done", result.done.join(","));
    if (result.failed.length > 0) {
      params.set(
        "failed",
        result.failed.map((f) => `${f.step}:${f.reason.slice(0, 80)}`).join("|"),
      );
    }
  }
  redirect(`/admin/demos?${params.toString()}`);
}

// --------------------------------------------------------------------
// JSON variant for drag-and-drop (no full-page reload).
// --------------------------------------------------------------------

/**
 * Same logic as moveDemoToStatus but used from the client-side kanban
 * after a drag completes. Returns a structured result instead of
 * redirecting so the optimistic UI can confirm or roll back.
 */
export async function moveDemoToStatusJson(
  demoId: string,
  status: string,
): Promise<
  | { ok: true; status: string; done?: string[]; failed?: { step: string; reason: string }[] }
  | { ok: false; error: string }
> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return { ok: false, error: "Not authorised" };
  }
  if (!isValidLifecycleStatus(status)) {
    return { ok: false, error: "Unknown status" };
  }

  const supabase = createAdminClient();
  const { data: rowRaw } = await supabase
    .from("demo_requests")
    .select("id, status, email, company, name, phone, linked_org_id" as never)
    .eq("id", demoId)
    .maybeSingle();
  const row = rowRaw as unknown as DemoRow | null;
  if (!row) return { ok: false, error: "Demo not found" };

  type Update = { status: string; reviewed_by?: string | null };
  const update: Update = { status };
  if (status === "demo_booked" || status === "won" || status === "lost") {
    update.reviewed_by = user.id;
  }

  const { error } = await supabase
    .from("demo_requests")
    .update(update as never)
    .eq("id", demoId);
  if (error) {
    console.error("[hq/demos] moveDemoToStatusJson failed", error);
    return { ok: false, error: "Couldn't update — try again." };
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `demo.move_${status}`,
    targetTable: "demo_requests",
    targetId: demoId,
    metadata: {
      from: row.status,
      to: status,
      source: "drag",
      company: row.company,
      email: row.email,
    },
  });

  // Drag-drop also triggers the real lifecycle work — same code path as
  // the explicit-button flow above. Caller gets back done/failed steps so
  // the optimistic UI can warn if the email send failed or the
  // promotion couldn't complete.
  const actor = { id: user.id, email: user.email ?? "" };
  let result: LifecycleResult | null = null;
  switch (status) {
    case "contacted":
      result = await onDemoContacted({ demo: row, actor });
      break;
    case "won":
      result = await onDemoApproved({ demo: row, actor });
      break;
    case "payment_sent":
      result = await onSetupPaymentSent({ demo: row, actor });
      break;
    case "payment_received":
      result = await onPaymentReceived({ demo: row, actor });
      break;
    case "active_onboarding":
      result = await promoteDemoToCustomer({ demo: row, actor });
      break;
  }

  revalidatePath("/admin/demos");
  revalidatePath("/admin/customers");
  revalidatePath("/admin/onboarding");

  return {
    ok: true,
    status,
    done: result?.done,
    failed: result?.failed,
  };
}

// --------------------------------------------------------------------
// Notes (appends to demo_requests.notes + audit entry)
// --------------------------------------------------------------------

const noteSchema = z.object({
  demo_id: z.string().uuid(),
  note: z.string().trim().min(1, "Write something").max(4000),
});

export async function addDemoNote(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = noteSchema.safeParse({
    demo_id: formData.get("demo_id"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) redirect("/admin/demos?error=invalid_note");

  const supabase = createAdminClient();
  const { data: row } = await supabase
    .from("demo_requests")
    .select("id, notes, company")
    .eq("id", parsed.data.demo_id)
    .maybeSingle();
  if (!row) redirect("/admin/demos?error=not_found");

  // Prepend the new note with the actor + ISO timestamp so the field
  // doubles as a quick audit when the operator opens the panel.
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const author = admin.email || "admin";
  const next = `[${stamp} · ${author}] ${parsed.data.note}\n\n${row.notes ?? ""}`.trim();

  const { error } = await supabase
    .from("demo_requests")
    .update({ notes: next })
    .eq("id", parsed.data.demo_id);
  if (error) {
    console.error("[hq/demos] addDemoNote failed", error);
    redirect("/admin/demos?error=update_failed");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "demo.note_added",
    targetTable: "demo_requests",
    targetId: parsed.data.demo_id,
    metadata: {
      preview: parsed.data.note.slice(0, 140),
      company: row?.company ?? null,
    },
  });

  revalidatePath("/admin/demos");
  redirect(`/admin/demos?saved=note&demo=${parsed.data.demo_id}`);
}

// --------------------------------------------------------------------
// Schedule (set preferred_demo_time)
// --------------------------------------------------------------------

const scheduleSchema = z.object({
  demo_id: z.string().uuid(),
  preferred_demo_time: z.string().trim().min(1).max(200),
});

export async function scheduleDemo(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = scheduleSchema.safeParse({
    demo_id: formData.get("demo_id"),
    preferred_demo_time: formData.get("preferred_demo_time") ?? "",
  });
  if (!parsed.success) redirect("/admin/demos?error=invalid_schedule");

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("demo_requests")
    .update({
      preferred_demo_time: parsed.data.preferred_demo_time,
      status: "demo_booked",
      reviewed_by: admin.id,
    } as never)
    .eq("id", parsed.data.demo_id);
  if (error) {
    console.error("[hq/demos] scheduleDemo failed", error);
    redirect("/admin/demos?error=update_failed");
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "demo.scheduled",
    targetTable: "demo_requests",
    targetId: parsed.data.demo_id,
    metadata: { preferred_demo_time: parsed.data.preferred_demo_time },
  });

  revalidatePath("/admin/demos");
  redirect(`/admin/demos?saved=scheduled&demo=${parsed.data.demo_id}`);
}

// --------------------------------------------------------------------
// Contact-channel logging — Call / Email / WhatsApp.
//
// The actual contact happens client-side via `tel:` / `mailto:` /
// `https://wa.me/…` links. After the user clicks the link in the
// browser we POST a no-op log entry so the timeline records that
// outbound contact was attempted. Status is NOT auto-flipped to
// `contacted` — the operator can do that explicitly with the
// dedicated button when they want.
// --------------------------------------------------------------------

const contactSchema = z.object({
  demo_id: z.string().uuid(),
  channel: z.enum(["call", "email", "whatsapp"]),
});

export async function logDemoContact(
  demoId: string,
  channel: "call" | "email" | "whatsapp",
): Promise<{ ok: boolean }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) return { ok: false };
  const parsed = contactSchema.safeParse({ demo_id: demoId, channel });
  if (!parsed.success) return { ok: false };

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `demo.contact_${parsed.data.channel}`,
    targetTable: "demo_requests",
    targetId: parsed.data.demo_id,
    metadata: { channel: parsed.data.channel },
  });
  return { ok: true };
}
