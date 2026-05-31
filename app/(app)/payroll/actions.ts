"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { hoursByUser, type TimeEntry } from "@/lib/time/compute";
import { computePayrollLine } from "@/lib/payroll/compute";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const runSchema = z.object({
  cycle: z.enum(["weekly", "monthly"]),
  period_start: isoDate,
  period_end: isoDate,
});

/**
 * Generate a payroll run for the given period.
 * Pulls every member of the org, sums their hours from time_entries in
 * window, computes gross/PAYE/NI, and writes draft payroll_lines.
 */
export async function createPayrollRun(
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx, user } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) {
    return formError("Only admins/owners can create payroll runs.");
  }
  const result = validateFormData(formData, runSchema);
  if (!result.ok) return result.state as FormState<Record<string, unknown>>;

  const { cycle, period_start, period_end } = result.data;
  if (period_end < period_start) {
    return formError(
      "Period end must be on or after period start.",
      result.data as Record<string, unknown>,
    );
  }

  const supabase = await createClient();

  // -----------------------------------------------------------------
  // Open-entry guard (CEO directive — any payroll mismatch is RED).
  //
  // The hour-sum query below filters `.not("ended_at", "is", null)`,
  // which silently drops time_entries that were clocked-in but never
  // clocked-out. Without this guard, a missed clock-out costs the
  // worker the whole shift.
  //
  // We refuse to create the run when any open entries overlap the
  // window. The owner has to either:
  //   (a) ask the worker to clock out, or
  //   (b) close the entry manually (future: an admin-side editor).
  //
  // Until that fix-up flow exists, surfacing the names is the
  // safest behaviour — no silent data loss.
  // -----------------------------------------------------------------
  const windowEndIso = `${period_end}T23:59:59.999Z`;
  const windowStartIso = `${period_start}T00:00:00Z`;
  const { data: openEntries } = await supabase
    .from("time_entries")
    .select("id, user_id, started_at, user:users ( full_name, email )")
    .eq("org_id", ctx.org.id)
    .is("ended_at", null)
    .lte("started_at", windowEndIso);
  if (openEntries && openEntries.length > 0) {
    type OpenRow = {
      user: { full_name: string | null; email: string | null } | null;
      started_at: string;
    };
    const names = Array.from(
      new Set(
        (openEntries as unknown as OpenRow[]).map(
          (e) => e.user?.full_name ?? e.user?.email ?? "Unknown",
        ),
      ),
    );
    return formError(
      `Some staff are still clocked in: ${names.slice(0, 3).join(", ")}${
        names.length > 3 ? ` +${names.length - 3} more` : ""
      }. Ask them to clock out first — otherwise their hours would be dropped from this run.`,
      result.data as Record<string, unknown>,
    );
  }

  // Insert the run.
  const { data: run, error: runErr } = await supabase
    .from("payroll_runs")
    .insert({
      org_id: ctx.org.id,
      cycle,
      period_start,
      period_end,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (runErr || !run) {
    console.error("[payroll] create run failed", runErr);
    return formError(
      "Couldn't create the payroll run. Try again.",
      result.data as Record<string, unknown>,
    );
  }

  // Pull every member + their hourly_pay.
  const { data: members } = await supabase
    .from("memberships")
    .select("user_id, user:users ( id, full_name, hourly_pay )")
    .eq("org_id", ctx.org.id);
  const { data: entriesRaw } = await supabase
    .from("time_entries")
    .select("id, user_id, job_id, started_at, ended_at, breaks")
    .gte("started_at", windowStartIso)
    .lte("started_at", windowEndIso)
    .not("ended_at", "is", null);
  const entries = (entriesRaw ?? []) as TimeEntry[];
  const hoursByU = hoursByUser(
    entries,
    new Date(windowStartIso),
    new Date(windowEndIso),
  );

  type PayrollLineInsert = {
    org_id: string;
    payroll_run_id: string;
    user_id: string;
    hours: number;
    hourly_pay: number;
    gross_pay: number;
    paye_estimate: number;
    ni_estimate: number;
    net_pay: number;
  };
  const lines: PayrollLineInsert[] = [];
  for (const m of members ?? []) {
    const uid = (m as { user_id: string }).user_id;
    const u = (m as { user?: { id: string; full_name: string | null; hourly_pay: number | null } }).user;
    const hours = hoursByU.get(uid) ?? 0;
    if (hours === 0) continue; // skip unpaid rows
    const hourlyPay = Number(u?.hourly_pay ?? 0);
    const c = computePayrollLine(hours, hourlyPay, cycle);
    lines.push({
      org_id: ctx.org.id,
      payroll_run_id: run.id,
      user_id: uid,
      hours: c.hours,
      hourly_pay: c.hourly_pay,
      gross_pay: c.gross_pay,
      paye_estimate: c.paye_estimate,
      ni_estimate: c.ni_estimate,
      net_pay: c.net_pay,
    });
  }

  if (lines.length > 0) {
    const { error: linesErr } = await supabase.from("payroll_lines").insert(lines);
    if (linesErr) {
      // supabase-js gives us no multi-statement transaction, so the run
      // row and its lines aren't atomic. A half-written run (parent saved,
      // zero lines) reads as a £0 payroll — and this branch USED to report
      // it to the user as success, which is exactly the "payroll appeared
      // to commit despite a failure" defect from the QA audit. Instead,
      // roll the parent back so the action is all-or-nothing, then surface
      // a real error so the owner can retry cleanly.
      console.error("[payroll] lines insert failed — rolling back run", {
        runId: run.id,
        orgId: ctx.org.id,
        lineCount: lines.length,
        error: linesErr,
      });
      const { error: rollbackErr } = await supabase
        .from("payroll_runs")
        .delete()
        .eq("id", run.id);
      if (rollbackErr) {
        console.error(
          "[payroll] rollback of orphaned run failed — manual cleanup may be needed",
          { runId: run.id, error: rollbackErr },
        );
      }
      return formError(
        "Couldn't save the payroll lines, so the run was rolled back. Please try again.",
        result.data as Record<string, unknown>,
      );
    }
  }

  revalidatePath("/payroll");
  revalidatePath("/dashboard");
  return formSuccess({
    successMessage: "Draft payroll run created.",
    redirectTo: `/payroll/${run.id}?saved=created`,
  });
}

/** Lock a draft run. Time entries that fed it become read-only. */
export async function finalisePayrollRun(runId: string) {
  const { ctx } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) redirect("/dashboard?error=forbidden");
  const supabase = await createClient();

  const { data: run } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, status")
    .eq("id", runId)
    .maybeSingle();
  if (!run) redirect("/payroll?error=not_found");
  if (run.status === "finalised") redirect(`/payroll/${runId}`);

  // Lock the time entries whose user appears in this run.
  const { data: lines } = await supabase
    .from("payroll_lines")
    .select("id, user_id")
    .eq("payroll_run_id", runId);

  for (const l of lines ?? []) {
    await supabase
      .from("time_entries")
      .update({ payroll_line_id: l.id })
      .eq("user_id", l.user_id)
      .gte("started_at", `${run.period_start}T00:00:00Z`)
      .lte("started_at", `${run.period_end}T23:59:59.999Z`)
      .not("ended_at", "is", null)
      .is("payroll_line_id", null);
  }

  await supabase
    .from("payroll_runs")
    .update({ status: "finalised", finalised_at: new Date().toISOString() })
    .eq("id", runId);

  revalidatePath(`/payroll/${runId}`);
  revalidatePath("/payroll");
  redirect(`/payroll/${runId}?saved=finalised`);
}

/** Delete a draft run (and its lines via cascade) — finalised runs are immutable. */
export async function deletePayrollRun(runId: string) {
  const { ctx } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) redirect("/dashboard?error=forbidden");
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("payroll_runs")
    .select("status")
    .eq("id", runId)
    .maybeSingle();
  if (!run) redirect("/payroll?error=not_found");
  if (run.status === "finalised") redirect(`/payroll/${runId}?error=cannot_delete_finalised`);
  await supabase.from("payroll_runs").delete().eq("id", runId);
  revalidatePath("/payroll");
  redirect("/payroll?saved=deleted");
}

function isOwnerOrAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
