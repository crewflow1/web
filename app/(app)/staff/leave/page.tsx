import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  createLeaveRequest,
  reviewLeaveRequest,
  cancelLeaveRequest,
} from "../actions";
import { CreateLeaveForm } from "./_create-form";
import { formatDateUK } from "@/lib/time/format";
import { readFailure } from "@/lib/supabase/read-failure";
import { getHolidayBalanceForUser } from "@/server/services/holiday-balance";

/**
 * Leave requests — submit, review (approve/reject), cancel.
 *
 *   - Staff see their own requests + all team leave for awareness
 *   - Admins see everything + an approve/reject action on pending rows
 *   - Lifecycle: pending → approved | rejected | cancelled (by staff)
 */

type SP = Promise<{
  filter?: "mine" | "pending" | "all";
  error?: string;
  saved?: string;
}>;

type LeaveRow = {
  id: string;
  user_id: string;
  type: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  status: string;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  cancelled: "bg-slate-100 text-slate-700",
};

// Friendly copy for the error codes the leave actions redirect back with.
// Unknown keys still fall back to the raw (decoded) code below, so this only
// upgrades the wording — it never hides an error.
const ERROR_MAP: Record<string, string> = {
  invalid_decision: "Please choose approve or reject.",
  review_failed: "Couldn't record that decision. Please try again.",
  already_reviewed: "That request was already reviewed by someone else.",
  cancel_failed: "Couldn't cancel that request. Please try again.",
  cannot_cancel: "That request can no longer be cancelled.",
};

const TYPE_LABEL: Record<string, string> = {
  holiday: "Holiday",
  sick: "Sick",
  emergency: "Emergency",
  unpaid: "Unpaid",
};

export default async function LeavePage({ searchParams }: { searchParams: SP }) {
  const { ctx, user } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  // (Read deleted upstream — #480's loud-read guard here is obsolete, not lost.)
  // Current user's role — from ctx (own membership in the ACTIVE org); an
  // unfiltered memberships read returns every member's row and `.single()`
  // errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const filter = sp.filter ?? (isAdmin ? "pending" : "mine");

  // Build query. Filter "mine" overrides org-wide via .eq(user_id).
  let q = supabase
    .from("leave_requests")
    .select(
      "id, user_id, type, starts_at, ends_at, reason, status, reviewed_at, review_note, created_at",
    )
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false });
  if (filter === "mine") q = q.eq("user_id", user.id);
  if (filter === "pending") q = q.eq("status", "pending");

  const { data: rowsRaw, error: rowsError } = await q;
  if (rowsError) throw readFailure("leave: requests", rowsError);
  const rows = (rowsRaw ?? []) as LeaveRow[];

  // Member name lookup.
  const { data: members } = await supabase
    .from("memberships")
    .select("user_id, user:users ( id, full_name, email )")
    .eq("org_id", ctx.org.id);
  const memberById = new Map<string, string>();
  for (const m of members ?? []) {
    memberById.set(m.user_id, m.user?.full_name ?? m.user?.email ?? "—");
  }

  // Leave calendar: org-wide upcoming approved + pending leave.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { data: upcomingRaw, error: upcomingError } = await supabase
    .from("leave_requests")
    .select("id, user_id, type, starts_at, ends_at, status")
    .eq("org_id", ctx.org.id)
    .in("status", ["approved", "pending"])
    .gte("ends_at", todayIso)
    .order("starts_at", { ascending: true });
  if (upcomingError) throw readFailure("leave: upcoming calendar", upcomingError);
  const upcoming = (upcomingRaw ?? []) as Pick<
    LeaveRow,
    "id" | "user_id" | "type" | "starts_at" | "ends_at" | "status"
  >[];

  // The current user's own holiday balance (derived). null when no entitlement
  // is configured for them.
  const myHoliday = await getHolidayBalanceForUser(ctx.org.id, user.id);

  const errorMessage = sp.error
    ? ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved
    ? sp.saved === "requested"
      ? "Leave request submitted."
      : sp.saved === "approved"
        ? "Leave approved."
        : sp.saved === "rejected"
          ? "Leave rejected."
          : sp.saved === "cancelled"
            ? "Request cancelled."
            : null
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Leave requests</h1>
          <p className="mt-1 text-sm text-slate-600">
            Holiday / sick / emergency / unpaid. {isAdmin ? "Admins approve or reject pending requests." : "Submit and track your own."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FilterLink active={filter === "mine"} href="?filter=mine">Mine</FilterLink>
          <FilterLink active={filter === "pending"} href="?filter=pending">Pending</FilterLink>
          <FilterLink active={filter === "all"} href="?filter=all">All</FilterLink>
        </div>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {savedMessage}
        </div>
      ) : null}

      {/* My holiday balance (derived from entitlement + approved/pending leave). */}
      {myHoliday ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            My holiday balance
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <LeaveStat
              label="Days remaining"
              value={`${myHoliday.balance.remaining_days}`}
              emphasis
            />
            <LeaveStat
              label="Allowance"
              value={`${myHoliday.balance.allowance_days}`}
            />
            <LeaveStat label="Taken" value={`${myHoliday.balance.taken_days}`} />
            <LeaveStat
              label="Booked"
              value={`${myHoliday.balance.booked_days}`}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Leave year {myHoliday.balance.leave_year_start} →{" "}
            {myHoliday.balance.leave_year_end}
            {myHoliday.balance.carried_over_days > 0
              ? ` · ${myHoliday.balance.carried_over_days} day(s) carried over`
              : ""}
            . Days are working days (Mon–Fri).
          </p>
        </section>
      ) : null}

      {/* Submit form (everyone). */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Request leave</h2>
        <CreateLeaveForm action={createLeaveRequest} />
      </section>

      {/* Leave calendar — org-wide upcoming approved + pending leave. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Leave calendar</h2>
        <p className="mt-0.5 text-xs text-slate-500">Upcoming approved and pending leave across the team.</p>
        {upcoming.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No upcoming leave.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {upcoming.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-2.5 w-2.5 rounded-full ${r.status === "approved" ? "bg-green-500" : "bg-amber-400"}`}
                    aria-hidden
                  />
                  <span className="font-medium text-slate-900">{memberById.get(r.user_id) ?? "—"}</span>
                  <span className="text-slate-500">· {TYPE_LABEL[r.type] ?? r.type}</span>
                </div>
                <div className="text-right text-slate-600">
                  {formatDateUK(r.starts_at)} – {formatDateUK(r.ends_at)}
                  <span className="ml-2 text-[11px] text-slate-500">{r.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2">Staff</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Dates</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-4 text-center text-sm text-slate-500">No requests.</td></tr>
              ) : rows.map((r) => {
                const isMine = r.user_id === user.id;
                const canCancel = isMine && r.status === "pending";
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2 text-slate-900">{memberById.get(r.user_id) ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-700">{TYPE_LABEL[r.type] ?? r.type}</td>
                    <td className="px-4 py-2 text-slate-700">{formatDateUK(r.starts_at)} → {formatDateUK(r.ends_at)}</td>
                    <td className="px-4 py-2 text-slate-600">{r.reason ?? "—"}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[r.status] ?? STATUS_STYLES.pending}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isAdmin && r.status === "pending" ? (
                          <>
                            <form action={reviewLeaveRequest.bind(null, r.id)}>
                              <input type="hidden" name="decision" value="approved" />
                              <button type="submit" className="rounded-md border border-green-300 bg-white px-2 py-0.5 text-xs font-medium text-green-700 hover:bg-green-50">
                                Approve
                              </button>
                            </form>
                            <form action={reviewLeaveRequest.bind(null, r.id)}>
                              <input type="hidden" name="decision" value="rejected" />
                              <button type="submit" className="rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50">
                                Reject
                              </button>
                            </form>
                          </>
                        ) : null}
                        {canCancel ? (
                          <form action={cancelLeaveRequest.bind(null, r.id)}>
                            <button type="submit" className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                              Cancel
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FilterLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white"
          : "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      }
    >
      {children}
    </Link>
  );
}

function LeaveStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={
          emphasis
            ? "mt-1 text-2xl font-bold text-slate-900"
            : "mt-1 text-lg font-semibold text-slate-800"
        }
      >
        {value}
      </div>
    </div>
  );
}
