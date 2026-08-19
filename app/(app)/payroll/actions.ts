"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { hoursByUser, type TimeEntry } from "@/lib/time/compute";
import {
  computePayrollLine,
  standardHoursPerDayFromStoredProfile,
  type PayrollExtras,
} from "@/lib/payroll/compute";
import { workingDaysInWindow, type LeaveSpan } from "@/lib/staff/holiday";
import { getPayrollTaxProfilesForOrg } from "@/server/services/payroll-tax-profile";
import { prepareFpsReturn } from "@/server/services/hmrc-connections";
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
  type OpenEntryRow = {
    id: string;
    user_id: string;
    started_at: string;
    user: { full_name: string | null; email: string | null } | null;
  };
  // PAGED (F-1): the guard must see EVERY open entry in the window — a bare
  // `.select()` clamped at max_rows (1000) would let open entries past the cap
  // slip through, so a large org with >1000 still-clocked-in shifts would create
  // the run anyway and silently drop those hours (the exact failure this guard
  // exists to prevent). Page the full set on the unique `started_at`+`id` order.
  const { data: openEntries, error: openError } = await fetchAllRows<OpenEntryRow>(
    (from, to) =>
      supabase
        .from("time_entries")
        .select("id, user_id, started_at, user:users ( full_name, email )")
        .eq("org_id", ctx.org.id)
        .is("ended_at", null)
        .lte("started_at", windowEndIso)
        .order("started_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: OpenEntryRow[] | null;
        error: unknown;
      }>,
  );
  // Fail loud — a failed read here would FAIL OPEN, skipping the open-entry
  // guard and silently dropping still-clocked-in hours from the run.
  if (openError) throw readFailure("payroll create: open entries", openError);
  if (openEntries && openEntries.length > 0) {
    const names = Array.from(
      new Set(
        openEntries.map(
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
  // PAGED (F-1): this set drives the WHOLE run — the `for (const m of members)`
  // loop below emits one payroll_line per member. A bare `.select()` clamped at
  // max_rows (1000) would silently drop every member past the (order-less) 1000
  // prefix, so a >1000-member org would give those workers NO payroll line at all
  // (total omission of pay) while the run still reported success. The two
  // time_entries reads either side of this were already paged; this one was
  // overlooked. Page the complete set on the unique `user_id` order (user_id is
  // unique per membership row within an org; `id` added as a defensive tiebreak).
  type MemberRow = {
    user_id: string;
    user: { id: string; full_name: string | null; hourly_pay: number | null } | null;
  };
  const { data: members, error: membersError } = await fetchAllRows<MemberRow>(
    (from, to) =>
      supabase
        .from("memberships")
        .select("user_id, user:users ( id, full_name, hourly_pay )")
        .eq("org_id", ctx.org.id)
        .order("user_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: MemberRow[] | null;
        error: unknown;
      }>,
  );
  // A failed read here would write a £0 run and report success — payroll
  // mismatches are RED, so fail loud instead.
  if (membersError) throw readFailure("payroll create: members", membersError);
  // ACTIVE-org pin — this is the hours source for every line in the run, and
  // the single most expensive omission in this file. `time_entries_select` is
  // `org_id in current_org_ids()`, which admits EVERY org the caller belongs
  // to. Without this predicate a worker who is a member of BOTH companies had
  // their OTHER employer's shifts summed into this run by `hoursByUser` (it
  // groups on user_id alone), inflating gross_pay, paye_estimate, ni_estimate
  // and net_pay — one company paying for hours worked at another, with the
  // PAYE/NI figures filed on the inflated gross. Note the open-entry guard
  // above was ALREADY pinned to ctx.org.id, so the guard and the hour sum
  // disagreed about which company's timesheets it was reading.
  //
  // PAGED (F-1): this set feeds `hoursByUser` → gross_pay/PAYE/NI/net_pay for
  // every line in the run. A bare `.select()` clamped at max_rows (1000) would
  // silently drop the entries past the cap, so a >1000-entry month would
  // UNDERSTATE pay for the whole workforce with no error. Page the complete set
  // on the unique `started_at`+`id` order (mirrors finalisePayrollRun below).
  const { data: entriesRaw, error: entriesError } = await fetchAllRows<TimeEntry>(
    (from, to) =>
      supabase
        .from("time_entries")
        .select("id, user_id, job_id, started_at, ended_at, breaks")
        .eq("org_id", ctx.org.id)
        .gte("started_at", windowStartIso)
        .lte("started_at", windowEndIso)
        .not("ended_at", "is", null)
        .order("started_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: TimeEntry[] | null;
        error: unknown;
      }>,
  );
  if (entriesError) throw readFailure("payroll create: hours", entriesError);
  const entries = (entriesRaw ?? []) as TimeEntry[];
  const hoursByU = hoursByUser(
    entries,
    new Date(windowStartIso),
    new Date(windowEndIso),
  );

  // -----------------------------------------------------------------
  // Holiday pay into gross (paid EXACTLY once).
  //
  // Approved 'holiday' leave_requests overlapping the period are paid at plain
  // rate ON TOP of worked hours. There is no double payment because worked hours
  // come only from clocked time_entries and a holiday day has no clocked shift —
  // the two sources are disjoint by construction. Leave hours are computed as the
  // approved WORKING days that fall in the window (Mon–Fri, clipped to the period)
  // multiplied by the employee's contracted hours-per-working-day. That figure is
  // OPT-IN per employee (payroll_tax_profiles.standard_hours_per_day): absent ⇒ 0
  // leave hours ⇒ no holiday pay, so existing tenants are unchanged.
  //
  // PAGED (F-1): a large org's approved holiday must be seen in full, else a
  // worker past the 1000-row cap would silently lose their holiday pay.
  // -----------------------------------------------------------------
  type LeaveRow = { user_id: string; starts_at: string; ends_at: string; status: string };
  const { data: leaveRaw, error: leaveError } = await fetchAllRows<LeaveRow>(
    (from, to) =>
      supabase
        .from("leave_requests")
        .select("user_id, starts_at, ends_at, status")
        .eq("org_id", ctx.org.id)
        .eq("type", "holiday")
        .eq("status", "approved")
        .lte("starts_at", period_end)
        .gte("ends_at", period_start)
        .order("user_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: LeaveRow[] | null;
        error: unknown;
      }>,
  );
  // Fail loud — a failed leave read would silently drop holiday pay from the run.
  if (leaveError) throw readFailure("payroll create: holiday leave", leaveError);
  const spansByUser = new Map<string, LeaveSpan[]>();
  for (const l of leaveRaw ?? []) {
    const arr = spansByUser.get(l.user_id) ?? [];
    arr.push({ starts_at: l.starts_at, ends_at: l.ends_at, status: l.status });
    spansByUser.set(l.user_id, arr);
  }
  // Per-employee contracted hours-per-day (holiday) + NI category live on the tax
  // profile. Absent ⇒ 0 leave hours / category A ⇒ figures unchanged. Empty map on
  // error (the service swallows read errors), which is the safe, unchanged default.
  const taxProfiles = await getPayrollTaxProfilesForOrg(ctx.org.id);

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
    overtime_hours: number;
    overtime_multiplier: number;
    overtime_pay: number;
    leave_hours: number;
    leave_pay: number;
  };
  const lines: PayrollLineInsert[] = [];
  for (const m of members ?? []) {
    const uid = (m as { user_id: string }).user_id;
    const u = (m as { user?: { id: string; full_name: string | null; hourly_pay: number | null } }).user;
    const hours = hoursByU.get(uid) ?? 0;
    const profile = taxProfiles.get(uid);
    const hoursPerDay = standardHoursPerDayFromStoredProfile(profile);
    // Approved holiday working days in the period × contracted hours-per-day.
    const leaveDays =
      hoursPerDay > 0
        ? workingDaysInWindow(
            spansByUser.get(uid) ?? [],
            period_start,
            period_end,
            ["approved"],
          )
        : 0;
    const leaveHours = Math.round(leaveDays * hoursPerDay * 100) / 100;
    // A worker with ONLY holiday (no clocked hours) is still paid — do not skip.
    if (hours === 0 && leaveHours === 0) continue;
    const hourlyPay = Number(u?.hourly_pay ?? 0);
    // Overtime defaults to 0 at generation; an admin records it on the draft line
    // afterwards (audited). Holiday hours are baked into gross here.
    const extras: PayrollExtras = { leaveHours };
    // `period_start` (not today) picks the employer rate table, so the run is
    // priced at the rates in force for the period it covers — and stays that way
    // when rates change next 6 April. Employer NI/pension are DERIVED on read from
    // the stored gross via `employerCostsForStoredLine`, so there is nothing extra
    // to persist here and no second copy of the rate table.
    const c = computePayrollLine(hours, hourlyPay, cycle, period_start, extras);
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
      overtime_hours: c.overtime_hours,
      overtime_multiplier: c.overtime_multiplier,
      overtime_pay: c.overtime_pay,
      leave_hours: c.leave_hours,
      leave_pay: c.leave_pay,
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
        .eq("id", run.id)
        // Pinned like every other write here. `run.id` came from this action's
        // own INSERT stamped `org_id: ctx.org.id`, so this cannot change the
        // outcome today — it exists so the rollback can never become the one
        // unpinned DELETE in the file.
        .eq("org_id", ctx.org.id);
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

  // ACTIVE-org pin. Finalising is IRREVERSIBLE (deletePayrollRun refuses a
  // finalised run), so an unpinned read here let a dual-org admin working in
  // org A permanently lock org B's draft payroll from A's shell.
  const { data: run, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, period_start, period_end, status")
    .eq("id", runId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (runError) throw readFailure("payroll finalise: run", runError);
  if (!run) redirect("/payroll?error=not_found");
  if (run.status === "finalised") redirect(`/payroll/${runId}`);

  // Lock the time entries whose user appears in this run.
  // PAGED (F-1): every line drives a time-entry lock below, so a bare `.select()`
  // clamped at max_rows (1000) would finalise a large run (>1000 workers) with
  // the workers past the cap left with their timesheets UNLOCKED — editable after
  // payroll was locked. Page the full set on the unique `id` order.
  const { data: lines, error: linesError } = await fetchAllRows<{ id: string; user_id: string }>(
    (from, to) =>
      supabase
        .from("payroll_lines")
        .select("id, user_id")
        .eq("payroll_run_id", runId)
        .eq("org_id", ctx.org.id)
        .order("id", { ascending: true })
        .range(from, to),
  );
  // Fail loud BEFORE finalising — a failed read here would finalise the run
  // with every time entry left unlocked.
  if (linesError) throw readFailure("payroll finalise: lines", linesError);

  for (const l of lines ?? []) {
    // ACTIVE-org pin. This UPDATE is scoped by user_id + a DATE WINDOW, so
    // without it finalising org A's run reached into every OTHER org that
    // worker clocks time for and stamped their shifts in that window with an
    // org A `payroll_line_id` — freezing another company's timesheets
    // (payroll-linked entries are read-only) and attributing them to a payroll
    // line that company cannot see.
    await supabase
      .from("time_entries")
      .update({ payroll_line_id: l.id })
      .eq("org_id", ctx.org.id)
      .eq("user_id", l.user_id)
      .gte("started_at", `${run.period_start}T00:00:00Z`)
      .lte("started_at", `${run.period_end}T23:59:59.999Z`)
      .not("ended_at", "is", null)
      .is("payroll_line_id", null);
  }

  await supabase
    .from("payroll_runs")
    .update({ status: "finalised", finalised_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("org_id", ctx.org.id);

  revalidatePath(`/payroll/${runId}`);
  revalidatePath("/payroll");
  redirect(`/payroll/${runId}?saved=finalised`);
}

/** Delete a draft run (and its lines via cascade) — finalised runs are immutable. */
export async function deletePayrollRun(runId: string) {
  const { ctx } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) redirect("/dashboard?error=forbidden");
  const supabase = await createClient();
  // ACTIVE-org pin on BOTH the read and the DELETE. `payroll_runs` cascades to
  // `payroll_lines`, so an unpinned DELETE let a dual-org admin working in org
  // A destroy org B's draft payroll run and every computed line under it —
  // irrecoverable financial data, and org B sees only that its run vanished.
  // The read is pinned too so a foreign run is `not_found` rather than being
  // status-checked and then silently missed by the DELETE.
  const { data: run, error: runError } = await supabase
    .from("payroll_runs")
    .select("status")
    .eq("id", runId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  // Throw BEFORE the delete — a failed status read must never let a finalised
  // run slip past the immutability check.
  if (runError) throw readFailure("payroll delete: run", runError);
  if (!run) redirect("/payroll?error=not_found");
  if (run.status === "finalised") redirect(`/payroll/${runId}?error=cannot_delete_finalised`);
  await supabase
    .from("payroll_runs")
    .delete()
    .eq("id", runId)
    .eq("org_id", ctx.org.id);
  revalidatePath("/payroll");
  redirect("/payroll?saved=deleted");
}

/**
 * Prepare + HOLD an RTI Full Payment Submission (FPS) for a finalised run — an
 * internal FROZEN record built from this run's own payroll_lines. It does NOT
 * file to HMRC: there is no submit/network path, and RTI filing stays legally
 * recognition-gated (see lib/integrations/hmrc/rti-fps.ts and migration 20261156).
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin; the
 * admin-insert RLS on hmrc_submissions / hmrc_connections (20261099) is the real
 * boundary. Org-pinned via ctx.org.id — never a client-supplied org — and the run
 * id is re-resolved org-pinned inside prepareFpsReturn, so a multi-org admin
 * cannot prepare against another org's run.
 */
export async function prepareFpsRunAction(runId: string) {
  const { ctx, user } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) redirect("/dashboard?error=forbidden");

  const res = await prepareFpsReturn({
    orgId: ctx.org.id,
    preparedBy: user.id,
    payrollRunId: runId,
  });
  if (!res.ok) {
    redirect(`/payroll/${runId}?error=${encodeURIComponent(res.error)}`);
  }
  revalidatePath(`/payroll/${runId}`);
  redirect(`/payroll/${runId}?saved=fps_prepared`);
}

const overtimeSchema = z.object({
  overtime_hours: z.coerce.number().min(0).max(1000),
  // Per-line premium (default 1.5 = time-and-a-half). Capped at 10× as a sanity bound.
  overtime_multiplier: z.coerce.number().min(0).max(10),
});

/**
 * Record OVERTIME on a single DRAFT payroll line, and audit the change.
 *
 * Overtime is a per-line input (hours × multiplier) added to gross ON TOP of worked
 * and holiday pay. Recomputes gross/PAYE/NI/net from the SAME authority the run was
 * built with (computePayrollLine) so the figures reconcile, preserving the line's
 * stored holiday hours. Draft-only: a finalised run is immutable (mirrors
 * deletePayrollRun / finalisePayrollRun). Admin/owner only. Every change writes an
 * append-only row to payroll_line_adjustments (before/after + actor).
 */
export async function setPayrollLineOvertime(
  lineId: string,
  _prevState: FormState<Record<string, unknown>>,
  formData: FormData,
): Promise<FormState<Record<string, unknown>>> {
  const { ctx, user } = await requireOrgContext();
  if (!isOwnerOrAdmin(ctx.membership.role)) {
    return formError("Only admins/owners can edit payroll lines.");
  }
  if (!z.string().uuid().safeParse(lineId).success) {
    return formError("Invalid payroll line.");
  }
  const result = validateFormData(formData, overtimeSchema);
  if (!result.ok) return result.state as FormState<Record<string, unknown>>;

  const supabase = await createClient();
  // Read the line + its run, ACTIVE-org pinned (RLS admits every org the admin
  // belongs to). We need the run's cycle + period_start to reprice, its status to
  // enforce draft-only, and the stored leave hours so holiday pay is preserved.
  const { data: line, error: lineError } = await supabase
    .from("payroll_lines")
    .select(
      "id, payroll_run_id, hours, hourly_pay, leave_hours, overtime_hours, overtime_multiplier, gross_pay, run:payroll_runs ( cycle, period_start, status )",
    )
    .eq("id", lineId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (lineError) throw readFailure("payroll overtime: line", lineError);
  if (!line) return formError("Payroll line not found.");
  const runRel = (line as { run?: { cycle: string; period_start: string; status: string } | null }).run;
  if (!runRel) return formError("Payroll line not found.");
  if (runRel.status !== "draft") {
    return formError("This run is finalised — its lines are locked.");
  }

  const cycle = runRel.cycle === "weekly" ? "weekly" : "monthly";
  const leaveHours = Number((line as { leave_hours?: number | string | null }).leave_hours ?? 0) || 0;
  const extras: PayrollExtras = {
    overtimeHours: result.data.overtime_hours,
    overtimeMultiplier: result.data.overtime_multiplier,
    leaveHours,
  };
  const c = computePayrollLine(
    Number((line as { hours?: number | string | null }).hours ?? 0) || 0,
    Number((line as { hourly_pay?: number | string | null }).hourly_pay ?? 0) || 0,
    cycle,
    runRel.period_start,
    extras,
  );

  const { error: updErr } = await supabase
    .from("payroll_lines")
    .update({
      overtime_hours: c.overtime_hours,
      overtime_multiplier: c.overtime_multiplier,
      overtime_pay: c.overtime_pay,
      gross_pay: c.gross_pay,
      paye_estimate: c.paye_estimate,
      ni_estimate: c.ni_estimate,
      net_pay: c.net_pay,
    })
    .eq("id", lineId)
    .eq("org_id", ctx.org.id);
  if (updErr) {
    console.error("[payroll] overtime update failed", { lineId, error: updErr });
    return formError("Couldn't save overtime. Try again.");
  }

  // Append-only audit row (before → after). Loud on failure: the change committed,
  // so a missing audit trail must be visible in the logs, but we still report
  // success because the payroll figure itself is correct.
  const { error: auditErr } = await supabase.from("payroll_line_adjustments").insert({
    org_id: ctx.org.id,
    payroll_line_id: lineId,
    actor_id: user.id,
    field: "overtime",
    old_overtime_hours: Number((line as { overtime_hours?: number | string | null }).overtime_hours ?? 0) || 0,
    new_overtime_hours: c.overtime_hours,
    old_overtime_multiplier: Number((line as { overtime_multiplier?: number | string | null }).overtime_multiplier ?? 0) || 0,
    new_overtime_multiplier: c.overtime_multiplier,
    old_gross_pay: Number((line as { gross_pay?: number | string | null }).gross_pay ?? 0) || 0,
    new_gross_pay: c.gross_pay,
  });
  if (auditErr) {
    console.error("[payroll] overtime audit insert failed — change applied without a trail", {
      lineId,
      error: auditErr,
    });
  }

  revalidatePath(`/payroll/${line.payroll_run_id}`);
  revalidatePath("/payroll");
  return formSuccess({ successMessage: "Overtime updated." });
}

function isOwnerOrAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
