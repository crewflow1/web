import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  updateStaffProfile,
  updateStaffRole,
  removeStaff,
} from "../actions";
import { STAFF_ROLES } from "@/lib/staff/schema";
import { StaffProfileForm } from "./_profile-form";
import { ConfirmForm } from "@/components/forms/ConfirmForm";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { readFailure } from "@/lib/supabase/read-failure";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // (Read deleted upstream — #480's loud-read guard here is obsolete, not lost.)
  // Current user's role — from ctx (own membership in the ACTIVE org); an
  // unfiltered memberships read returns every member's row and `.single()`
  // errors in any org with ≥2 members.
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  // Target row + extended profile.
  const { data: row, error: rowError } = await supabase
    .from("memberships")
    .select(
      `
        role, user_id,
        user:users ( id, full_name, email, phone, hourly_pay, employment_type, start_date, emergency_contact )
      `,
    )
    .eq("org_id", ctx.org.id)
    .eq("user_id", id)
    .maybeSingle();
  if (rowError) throw readFailure("staff detail: member", rowError);

  if (!row) notFound();

  const user = row.user as {
    id: string;
    full_name: string | null;
    email: string;
    phone: string | null;
    hourly_pay: number | null;
    employment_type: string | null;
    start_date: string | null;
    emergency_contact: {
      name?: string | null;
      phone?: string | null;
      relationship?: string | null;
    } | null;
  } | null;

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/staff" className="hover:text-slate-900">Staff</Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900 truncate">
          {user?.full_name ?? user?.email}
        </span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">
          {user?.full_name ?? user?.email}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {user?.email} · role: <strong>{row.role}</strong>
        </p>
      </header>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}
      {sp.saved ? (
        <div role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Saved.
        </div>
      ) : null}

      {/* Profile form — admin-only edit */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Profile</h2>
        <StaffProfileForm
          action={updateStaffProfile.bind(null, id)}
          isAdmin={isAdmin}
          defaults={{
            full_name: user?.full_name ?? "",
            phone: user?.phone ?? "",
            hourly_pay: user?.hourly_pay != null ? String(user.hourly_pay) : "",
            employment_type: user?.employment_type ?? "",
            start_date: user?.start_date ?? "",
            emergency_contact_name: user?.emergency_contact?.name ?? "",
            emergency_contact_phone: user?.emergency_contact?.phone ?? "",
            emergency_contact_relationship:
              user?.emergency_contact?.relationship ?? "",
          }}
        />
      </section>

      {/* Pay summary (read-only mini-tile) */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Pay</h2>
        <p className="mt-2 text-sm text-slate-600">
          Hourly:{" "}
          <strong className="text-slate-900">
            {user?.hourly_pay != null ? GBP.format(Number(user.hourly_pay)) : "—"}
          </strong>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Weekly pay is computed from rota hours × hourly pay once rota
          entries exist for this user (Mon–Sun).
        </p>
      </section>

      {/* Role + remove (admin only) */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Role</h2>
          <form action={updateStaffRole.bind(null, id)} className="mt-3 flex items-end gap-2">
            <label className="block text-xs text-slate-600">
              Role
              <select
                name="role"
                defaultValue={row.role}
                className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {STAFF_ROLES.filter((r) => r !== "owner").map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
                {row.role === "owner" ? <option value="owner">owner</option> : null}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              disabled={row.role === "owner"}
              title={row.role === "owner" ? "Owner role can't be changed here" : "Update role"}
            >
              Update
            </button>
          </form>
        </section>
      ) : null}

      <AttachmentsPanel targetTable="memberships" targetId={id} />

      {isAdmin && row.role !== "owner" ? (
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
          <p className="text-sm font-medium text-red-900">Remove from organisation</p>
          <p className="mt-1 text-xs text-red-700">
            This removes their access. Their historical job assignments + rota
            entries stay (the user record persists).
          </p>
          <ConfirmForm
            action={removeStaff.bind(null, id)}
            confirm={`Remove ${row.user?.full_name ?? row.user?.email ?? "this staff member"} from the organisation? Their historical assignments stay but they lose access immediately.`}
            className="mt-3"
          >
            <button
              type="submit"
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Remove
            </button>
          </ConfirmForm>
        </section>
      ) : null}
    </div>
  );
}

