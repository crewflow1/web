"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
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
    // `period_start` (not today) picks the employer rate table, so the run is
    // priced at the rates in force for the period it covers — and stays that way
    // when rates change next 6 April. Employer NI/pension are DERIVED on read from
    // the stored gross via `employerCostsForStoredLine`, so there is nothing extra
    // to persist here and no second copy of the rate table.
    const c = computePayrollLine(hours, hourlyPay, cycle, period_start);
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

function isOwnerOrAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
