import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { Field } from "../_components/field";
import { updateProfile, updateOrganization } from "./actions";

/**
 * Settings — Profile + Organisation + Members in one page.
 *
 * Profile section: any user can edit their own full_name / phone.
 * Organisation section: editable for owners/admins; read-only banner
 *   for plain members.
 * Members section: read-only list of everyone in the current org.
 *
 * Designed for v1 simplicity — no avatar upload, no email change
 * (auth.users.email is governed by Supabase auth flows), no role
 * promotion UI (manual via Supabase Studio for now).
 */

const ERROR_MAP: Record<string, string> = {
  invalid_profile: "Profile details didn't validate.",
  profile_update_failed: "Couldn't save your profile. Try again.",
  invalid_org: "Organisation details didn't validate.",
  org_update_failed: "Couldn't save the organisation. Try again.",
  not_admin: "Only admins/owners can edit organisation details.",
  not_allowed: "Only admins/owners can edit organisation details.",
};

const SAVED_MAP: Record<string, string> = {
  profile: "Profile saved.",
  org: "Organisation saved.",
};

type SP = Promise<{ error?: string; saved?: string }>;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { user, ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const { data: profile } = await supabase
    .from("users")
    .select("id, email, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, phone, vat_number, address")
    .eq("id", ctx.org.id)
    .maybeSingle();

  const { data: members } = await supabase
    .from("memberships")
    .select("role, user:users ( id, full_name, email )")
    .eq("org_id", ctx.org.id);

  const address =
    (org?.address as { line1?: string; city?: string; postcode?: string } | null) ?? {};

  const errorMessage = sp.error ? ERROR_MAP[sp.error] ?? sp.error : null;
  const savedMessage = sp.saved ? SAVED_MAP[sp.saved] ?? "Saved." : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          Your profile, your organisation, and the people in it.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {savedMessage}
        </div>
      ) : null}

      {/* Profile ------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Profile</h2>
        <p className="mt-1 text-sm text-slate-600">
          How you appear in CrewFlow to teammates.
        </p>

        <form action={updateProfile} className="mt-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Email
            </label>
            <p className="mt-1 text-sm text-slate-700">{profile?.email ?? user.email}</p>
            <p className="mt-1 text-xs text-slate-500">
              Email is tied to your sign-in. Contact us to change it.
            </p>
          </div>
          <Field
            name="full_name"
            label="Full name"
            required
            defaultValue={profile?.full_name ?? ""}
            autoComplete="name"
          />
          <Field
            name="phone"
            label="Phone"
            type="tel"
            inputMode="tel"
            optional
            defaultValue={profile?.phone ?? ""}
            autoComplete="tel"
          />
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save profile
          </button>
        </form>
      </section>

      {/* Organisation -------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Organisation</h2>
            <p className="mt-1 text-sm text-slate-600">
              Appears on quotes, invoices, and any branded PDFs you send.
            </p>
          </div>
          {!isAdmin ? (
            <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              Read only · ask an admin
            </span>
          ) : null}
        </div>

        <form action={updateOrganization} className="mt-5 space-y-4">
          <fieldset disabled={!isAdmin} className="space-y-4 disabled:opacity-60">
            <Field
              name="name"
              label="Trading name"
              required
              defaultValue={org?.name ?? ""}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="phone"
                label="Phone"
                type="tel"
                inputMode="tel"
                optional
                defaultValue={org?.phone ?? ""}
              />
              <Field
                name="vat_number"
                label="VAT number"
                optional
                placeholder="GB123456789"
                defaultValue={org?.vat_number ?? ""}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field
                name="address_line1"
                label="Address line 1"
                optional
                defaultValue={address.line1 ?? ""}
              />
              <Field
                name="address_city"
                label="City"
                optional
                defaultValue={address.city ?? ""}
              />
              <Field
                name="address_postcode"
                label="Postcode"
                optional
                defaultValue={address.postcode ?? ""}
              />
            </div>
          </fieldset>
          {isAdmin ? (
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Save organisation
            </button>
          ) : null}
        </form>
      </section>

      {/* Members ------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Members</h2>
          <span className="text-xs text-slate-500">
            {(members ?? []).length} {(members ?? []).length === 1 ? "person" : "people"}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Everyone with access to this organisation. Roles control delete + admin actions.
        </p>

        <ul className="mt-4 divide-y divide-slate-100">
          {(members ?? []).map((m) => (
            <li
              key={m.user?.id ?? m.role}
              className="flex items-center justify-between py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">
                  {m.user?.full_name ?? m.user?.email ?? "—"}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {m.user?.email ?? ""}
                </div>
              </div>
              <span
                className={
                  m.role === "owner"
                    ? "rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white"
                    : m.role === "admin"
                      ? "rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700"
                      : "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                }
              >
                {m.role}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-4 text-xs text-slate-500">
          Need to add or remove a team member? That flow lands next. For now,
          have them sign in once with Google or magic link and message us to
          attach them to this org.
        </p>
      </section>
    </div>
  );
}
