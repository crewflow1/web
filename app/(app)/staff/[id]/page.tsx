import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  updateStaffProfile,
  updateStaffRole,
  removeStaff,
} from "../actions";
import { EMPLOYMENT_TYPES, STAFF_ROLES } from "@/lib/staff/schema";

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

  // Current user's role.
  const { data: myRow } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", ctx.org.id)
    .single();
  const isAdmin = myRow?.role === "owner" || myRow?.role === "admin";

  // Target row + extended profile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (supabase as any)
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
        <form action={updateStaffProfile.bind(null, id)} className="mt-4 space-y-3">
          <Pair label="Full name" name="full_name" defaultValue={user?.full_name ?? ""} disabled={!isAdmin} />
          <Pair label="Phone" name="phone" defaultValue={user?.phone ?? ""} disabled={!isAdmin} />
          <Pair
            label="Hourly pay (£)"
            name="hourly_pay"
            type="number"
            step={0.01}
            defaultValue={user?.hourly_pay != null ? String(user.hourly_pay) : ""}
            disabled={!isAdmin}
          />
          <label className="block text-xs text-slate-600">
            Employment type
            <select
              name="employment_type"
              defaultValue={user?.employment_type ?? ""}
              disabled={!isAdmin}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60"
            >
              <option value="">—</option>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace("_", " ")}</option>
              ))}
            </select>
          </label>
          <Pair
            label="Start date"
            name="start_date"
            type="date"
            defaultValue={user?.start_date ?? ""}
            disabled={!isAdmin}
          />
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Emergency contact
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Pair
                label="Name"
                name="emergency_contact_name"
                defaultValue={user?.emergency_contact?.name ?? ""}
                disabled={!isAdmin}
                bare
              />
              <Pair
                label="Phone"
                name="emergency_contact_phone"
                defaultValue={user?.emergency_contact?.phone ?? ""}
                disabled={!isAdmin}
                bare
              />
              <Pair
                label="Relationship"
                name="emergency_contact_relationship"
                defaultValue={user?.emergency_contact?.relationship ?? ""}
                disabled={!isAdmin}
                bare
              />
            </div>
          </div>
          {isAdmin ? (
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              Save profile
            </button>
          ) : (
            <p className="text-xs text-slate-500">Only admins can edit profile fields.</p>
          )}
        </form>
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

      {isAdmin && row.role !== "owner" ? (
        <section className="rounded-xl border border-red-200 bg-red-50/50 p-4">
          <p className="text-sm font-medium text-red-900">Remove from organisation</p>
          <p className="mt-1 text-xs text-red-700">
            This removes their access. Their historical job assignments + rota
            entries stay (the user record persists).
          </p>
          <form action={removeStaff.bind(null, id)} className="mt-3">
            <button
              type="submit"
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Remove
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function Pair({
  label,
  name,
  defaultValue,
  type = "text",
  step,
  disabled = false,
  bare = false,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  step?: number;
  disabled?: boolean;
  bare?: boolean;
}) {
  return (
    <label className={bare ? "block text-xs text-slate-600" : "block text-xs text-slate-600"}>
      {label}
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        step={step}
        disabled={disabled}
        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-60"
      />
    </label>
  );
}
