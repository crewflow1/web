import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateProfile, updateOrganization } from "./actions";
import { ProfileForm, OrganizationForm } from "./_forms";

/**
 * Settings — Profile + Organisation + Members in one page.
 *
 * Profile section: any user can edit their own full_name / phone.
 * Organisation section: editable for owners/admins; read-only banner
 *   for plain members.
 * Members section: read-only list of everyone in the current org.
 *
 * Both forms inline-validate via React 19 useActionState — no
 * `?error=` round-trip. Designed for v1 simplicity — no avatar
 * upload, no email change (auth.users.email is governed by Supabase
 * auth flows), no role promotion UI.
 */
export default async function SettingsPage() {
  const { user, ctx } = await requireOrgContext();
  const supabase = await createClient();

  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const { data: profile } = await supabase
    .from("users")
    .select("id, email, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, phone, vat_number, address, logo_url, default_terms, bank_details")
    .eq("id", ctx.org.id)
    .maybeSingle();

  const { data: members } = await supabase
    .from("memberships")
    .select("role, user:users ( id, full_name, email )")
    .eq("org_id", ctx.org.id);

  const address =
    (org?.address as { line1?: string; city?: string; postcode?: string } | null) ?? {};
  const bank =
    (org?.bank_details as {
      name?: string;
      sort_code?: string;
      account_number?: string;
      reference?: string;
    } | null) ?? {};

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          Your profile, your organisation, and the people in it.
        </p>
      </header>

      {/* Profile ------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Profile</h2>
        <p className="mt-1 text-sm text-slate-600">
          How you appear in CrewFlow to teammates.
        </p>

        <ProfileForm
          action={updateProfile}
          email={profile?.email ?? user.email ?? ""}
          defaults={{
            full_name: profile?.full_name ?? "",
            phone: profile?.phone ?? "",
          }}
        />
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

        <OrganizationForm
          action={updateOrganization}
          isAdmin={isAdmin}
          defaults={{
            name: org?.name ?? "",
            phone: org?.phone ?? "",
            vat_number: org?.vat_number ?? "",
            address_line1: address.line1 ?? "",
            address_city: address.city ?? "",
            address_postcode: address.postcode ?? "",
            logo_url: org?.logo_url ?? "",
            default_terms: org?.default_terms ?? "",
            bank_name: bank.name ?? "",
            bank_sort_code: bank.sort_code ?? "",
            bank_account_number: bank.account_number ?? "",
            bank_reference: bank.reference ?? "",
          }}
        />
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
