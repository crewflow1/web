import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AddStaffButton, InviteStaffModal } from "./_invite-modal";
import { PendingInvites } from "./_pending-invites";
import { listPendingInvites } from "./_invites";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Staff list page.
 *
 * Lists all org members with role, name, email. Admins see an invite
 * form + role-edit shortcut. Staff users see the directory but cannot
 * change anything (RLS enforces this server-side).
 */

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  admin: "bg-blue-100 text-blue-800",
  staff: "bg-slate-100 text-slate-700",
};

type SP = Promise<{ error?: string; saved?: string }>;

type MemberRow = {
  user_id: string;
  role: string;
  user: {
    id: string;
    full_name: string | null;
    email: string;
    phone: string | null;
    employment_type: string | null;
    start_date: string | null;
  } | null;
};

export default async function StaffPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  // (Read deleted upstream — #480's loud-read guard here is obsolete, not lost.)
  // Current user's role — gates the invite form. From ctx (own membership in
  // the ACTIVE org): an unfiltered memberships read returns every member's
  // row and `.single()` errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const { data: membersRaw, error: membersError } = await supabase
    .from("memberships")
    .select(
      `
        user_id, role,
        user:users ( id, full_name, email, phone, employment_type, start_date )
      `,
    )
    .eq("org_id", ctx.org.id)
    .order("role", { ascending: true });
  if (membersError) throw readFailure("staff: members register", membersError);

  // Pay is in staff_compensation (20261218) behind self-or-admin RLS: an admin
  // reads every member's rate (full roster), a non-admin who reaches this page by
  // URL reads only their OWN — so a co-worker's pay renders as "—", never leaked.
  const memberIds = [...new Set((membersRaw ?? []).map((m) => m.user_id))];
  const payByUser = new Map<string, number>();
  if (memberIds.length > 0) {
    const { data: compRows, error: compError } = await supabase
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .in("user_id", memberIds);
    if (compError) throw readFailure("staff: compensation", compError);
    for (const c of compRows ?? []) {
      const row = c as { user_id: string; hourly_pay: number | string | null };
      if (row.hourly_pay != null) payByUser.set(row.user_id, Number(row.hourly_pay));
    }
  }

  const members = (membersRaw ?? []) as MemberRow[];

  // Pending invites (H2): invited-but-not-yet-accepted teammates. Only an
  // admin can act on them (and the listing uses the service-role client),
  // so we only load them for admins. Reconciled against current members so
  // an accepted invite drops off automatically.
  const memberEmails = new Set(
    members
      .map((m) => m.user?.email?.trim().toLowerCase())
      .filter((e): e is string => !!e),
  );
  const pendingInvites = isAdmin
    ? await listPendingInvites(ctx.org.id, memberEmails)
    : [];

  const errorMessage = (() => {
    if (!sp.error) return null;
    switch (sp.error) {
      case "already_member":
        return "That person is already a member of this org.";
      case "invalid_input":
        return "Please enter a valid email and pick a role.";
      case "owner_role_not_assignable":
        return "Owner role can't be assigned through the invite form.";
      case "invite_failed":
        return "Couldn't add the member. Try again.";
      case "invite_email_failed":
        return "Couldn't send the invite email. Check that the address is valid, then try again.";
      default:
        return decodeURIComponent(sp.error);
    }
  })();
  const savedMessage = (() => {
    switch (sp.saved) {
      case "invited":
        return "Staff member added to your org.";
      case "invite_sent":
        return "Invite email sent. They'll get a magic-link to join your org.";
      case "removed":
        return "Staff member removed.";
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Staff</h1>
          <p className="mt-1 text-sm text-slate-600">
            {members.length} {members.length === 1 ? "member" : "members"}
            {pendingInvites.length > 0 ? (
              <span className="text-amber-700">
                {" "}· {pendingInvites.length} pending
              </span>
            ) : null}{" "}
            ·{" "}
            <Link href="/staff/rota" className="text-slate-700 underline hover:text-slate-900">
              Rota
            </Link>{" "}
            ·{" "}
            <Link href="/staff/leave" className="text-slate-700 underline hover:text-slate-900">
              Leave requests
            </Link>{" "}
            ·{" "}
            <Link href="/staff/rota/conflicts" className="text-slate-700 underline hover:text-slate-900">
              Schedule check
            </Link>
          </p>
        </div>
        {isAdmin ? (
          <AddStaffButton size="lg" testId="add-staff-button">
            + Add staff
          </AddStaffButton>
        ) : null}
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


      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-2">Name</th>
                <th className="px-6 py-2">Email</th>
                <th className="px-6 py-2">Role</th>
                <th className="px-6 py-2">Type</th>
                <th className="px-6 py-2 text-right">Hourly</th>
                <th className="px-6 py-2">Since</th>
                <th className="px-6 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-sm text-slate-500">
                    <p className="font-medium text-slate-700">No members yet.</p>
                    {isAdmin ? (
                      <p className="mt-2">
                        Use the{" "}
                        <strong className="text-slate-900">+ Add staff</strong>{" "}
                        button above to invite your first teammate.
                      </p>
                    ) : (
                      <p className="mt-2">
                        Ask an owner or admin to invite you.
                      </p>
                    )}
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.user_id}>
                    <td className="px-6 py-2 text-slate-900">
                      <Link href={`/staff/${m.user_id}`} className="font-medium hover:underline">
                        {m.user?.full_name ?? "—"}
                      </Link>
                    </td>
                    <td className="px-6 py-2 text-slate-600">{m.user?.email}</td>
                    <td className="px-6 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLES[m.role] ?? ROLE_STYLES.staff}`}
                      >
                        {m.role}
                      </span>
                    </td>
                    <td className="px-6 py-2 text-slate-600">{m.user?.employment_type ?? "—"}</td>
                    <td className="px-6 py-2 text-right text-slate-600">
                      {payByUser.has(m.user_id)
                        ? `£${payByUser.get(m.user_id)!.toFixed(2)}`
                        : "—"}
                    </td>
                    <td className="px-6 py-2 text-slate-600">{m.user?.start_date ?? "—"}</td>
                    <td className="px-6 py-2 text-right">
                      <Link href={`/staff/${m.user_id}`} className="text-xs text-slate-500 hover:text-slate-900">
                        Edit →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin ? <PendingInvites invites={pendingInvites} /> : null}

      {isAdmin ? <InviteStaffModal /> : null}
    </div>
  );
}
