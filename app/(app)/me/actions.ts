"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { isWithinLeave } from "@/lib/time/compute";

const uuidOpt = z.union([z.string().uuid(), z.literal("")]).optional();

/**
 * Clock in. Inserts a new open time_entries row for the caller.
 *
 * Pre-checks:
 *   - No existing open entry (DB unique index also enforces this).
 *   - Not currently within an approved leave window.
 */
export async function clockIn(formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  const jobIdRaw = (formData.get("job_id") as string) ?? "";
  const jobId = uuidOpt.safeParse(jobIdRaw).success && jobIdRaw ? jobIdRaw : null;
  const note = ((formData.get("note") as string) ?? "").slice(0, 500) || null;
  const gpsLatRaw = (formData.get("gps_lat") as string) ?? "";
  const gpsLngRaw = (formData.get("gps_lng") as string) ?? "";
  const gpsLat =
    gpsLatRaw && Number.isFinite(Number(gpsLatRaw)) ? Number(gpsLatRaw) : null;
  const gpsLng =
    gpsLngRaw && Number.isFinite(Number(gpsLngRaw)) ? Number(gpsLngRaw) : null;

  // Block if there's already an open entry.
  const { data: existing } = await supabase
    .from("time_entries")
    .select("id")
    .eq("user_id", user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (existing) {
    redirect("/me?error=already_clocked_in");
  }

  // Block if the caller is on approved leave right now.
  const { data: leaves } = await supabase
    .from("leave_requests")
    .select("starts_at, ends_at, status")
    .eq("user_id", user.id)
    .eq("status", "approved");
  const now = new Date();
  for (const l of leaves ?? []) {
    if (isWithinLeave(now, l)) {
      redirect("/me?error=on_leave");
    }
  }

  const { error } = await supabase.from("time_entries").insert({
    org_id: ctx.org.id,
    user_id: user.id,
    job_id: jobId,
    note,
    gps_lat: gpsLat,
    gps_lng: gpsLng,
  });
  if (error) {
    console.error("[clock-in] insert failed", error);
    redirect("/me?error=clock_in_failed");
  }
  revalidatePath("/me");
  redirect("/me?saved=clocked_in");
}

/** Clock out — closes the open entry. */
export async function clockOut() {
  const { user } = await requireOrgContext();
  const supabase = await createClient();

  const { data: open } = await supabase
    .from("time_entries")
    .select("id, breaks")
    .eq("user_id", user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (!open) redirect("/me?error=not_clocked_in");

  // Auto-close any still-open break.
  type Break = { started_at: string; ended_at: string | null };
  const nowIso = new Date().toISOString();
  const breaks = (open.breaks as Break[] | null) ?? [];
  const closedBreaks: Break[] = breaks.map((b) =>
    b.ended_at ? b : { ...b, ended_at: nowIso },
  );

  const { error } = await supabase
    .from("time_entries")
    .update({ ended_at: nowIso, breaks: closedBreaks })
    .eq("id", open.id);
  if (error) {
    console.error("[clock-out] update failed", error);
    redirect("/me?error=clock_out_failed");
  }
  revalidatePath("/me");
  redirect("/me?saved=clocked_out");
}

/** Start a break on the open entry. */
export async function startBreak() {
  const { user } = await requireOrgContext();
  const supabase = await createClient();
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, breaks")
    .eq("user_id", user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (!open) redirect("/me?error=not_clocked_in");
  type Break = { started_at: string; ended_at: string | null };
  const breaks = (open.breaks as Break[] | null) ?? [];
  const last = breaks[breaks.length - 1];
  if (last && last.ended_at === null) redirect("/me?error=already_on_break");
  breaks.push({ started_at: new Date().toISOString(), ended_at: null });
  const { error } = await supabase
    .from("time_entries")
    .update({ breaks })
    .eq("id", open.id);
  if (error) {
    console.error("[start-break] failed", error);
    redirect("/me?error=break_failed");
  }
  revalidatePath("/me");
  redirect("/me?saved=break_started");
}

/** End the currently-open break. */
export async function endBreak() {
  const { user } = await requireOrgContext();
  const supabase = await createClient();
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, breaks")
    .eq("user_id", user.id)
    .is("ended_at", null)
    .maybeSingle();
  if (!open) redirect("/me?error=not_clocked_in");
  type Break = { started_at: string; ended_at: string | null };
  const breaks = (open.breaks as Break[] | null) ?? [];
  const last = breaks[breaks.length - 1];
  if (!last || last.ended_at !== null) redirect("/me?error=not_on_break");
  last.ended_at = new Date().toISOString();
  const { error } = await supabase
    .from("time_entries")
    .update({ breaks })
    .eq("id", open.id);
  if (error) {
    console.error("[end-break] failed", error);
    redirect("/me?error=break_failed");
  }
  revalidatePath("/me");
  redirect("/me?saved=break_ended");
}
