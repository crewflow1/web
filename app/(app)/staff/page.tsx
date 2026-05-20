import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { inviteStaff } from "./actions";

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
    hourly_pay: number | null;
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

  // Current user's role — gates the invite form.
  const { data: myRow } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .single();
  const isAdmin = myRow?.role === "owner" || myRow?.role === "admin";

  const { data: membersRaw } = await supabase
    .from("memberships")
    .select(
      `
        user_id, role,
        user:users ( id, full_name, email, phone, employment_type, hourly_pay, start_date )
      `,
    )
    .eq("org_id", ctx.org.id)
    .order("role", { ascending: true });

  const members = (membersRaw ?? []) as MemberRow[];

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;
  const savedMessage = (() => {
    switch (sp.saved) {
      case "invited":
        return "Staff member added.";
      case "removed":
        return "Staff member removed.";
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Staff</h1>
          <p className="mt-1 text-sm text-slate-600">
            {members.length} {members.length === 1 ? "member" : "members"} ·{" "}
            <Link href="/staff/rota" className="text-slate-700 underline hover:text-slate-900">
              Rota
            </Link>{" "}
            ·{" "}
            <Link href="/staff/leave" className="text-slate-700 underline hover:text-slate-900">
              Leave requests
            </Link>
          </p>
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

      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Invite by email</h2>
          <p className="mt-1 text-xs text-slate-500">
            The person must already have signed up at least once — we link
            them into this organisation. Magic-link invites for new users
            are a future feature.
          </p>
          <form action={inviteStaff} className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block text-xs text-slate-600">
              Email
              <input
                type="email"
                name="email"
                required
                placeholder="name@example.com"
                className="mt-1 block w-64 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs text-slate-600">
              Role
              <select
                name="role"
                defaultValue="staff"
                className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              Add
            </button>
          </form>
        </section>
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
                  <td colSpan={7} className="px-6 py-4 text-center text-sm text-slate-500">
                    No members yet.
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
                      {m.user?.hourly_pay != null
                        ? `£${Number(m.user.hourly_pay).toFixed(2)}`
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
    </div>
  );
}
