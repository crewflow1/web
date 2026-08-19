import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure, reportReadFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { updateProfile, updateOrganization } from "./actions";
import { ProfileForm, OrganizationForm } from "./_forms";
import { LogoUpload } from "./_logo-upload";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { outboundWebhooksEnabled } from "@/lib/webhooks/flags";
import { NotificationPreferences } from "./_notification-prefs";
import { WorkingHoursSettings } from "./_working-hours";
import { TaxDefaultsSettings } from "./_tax-defaults";
import { FlatRateSettings } from "./_flat-rate";
import { HelpLink } from "../_components/help-link";

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

  // These feed EDIT forms — rendering blank defaults over a failed read would
  // let a save wipe the real profile/org values. Fail loud.
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id, email, full_name, phone")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw readFailure("settings: profile", profileError);

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, phone, email, vat_number, address, logo_path, logo_url, default_terms, bank_details")
    .eq("id", ctx.org.id)
    .maybeSingle();
  if (orgError) throw readFailure("settings: organisation", orgError);

  // Resolve a display src for the current logo (signed URL for an uploaded
  // file, or a legacy external URL for back-compat). Drives the preview.
  const logoSrc = await resolveOrgLogoSrc(org);

  // Phase A — AI receptionist setup status (drives the badge below).
  type AiSetupRow = { enabled: boolean; status: string };
  const { data: aiSetup } = await (
    supabase.from("ai_receptionist_setups" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: AiSetupRow | null }>;
        };
      };
    }
  )
    .select("enabled, status")
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  const aiBadge =
    !aiSetup || !aiSetup.enabled
      ? { label: "Off", style: "bg-slate-100 text-slate-600" }
      : aiSetup.status === "live"
        ? { label: "Live", style: "bg-emerald-100 text-emerald-800" }
        : { label: "Pending", style: "bg-amber-100 text-amber-800" };

  const { data: members, error: membersError } = await supabase
    .from("memberships")
    .select("role, user:users ( id, full_name, email )")
    .eq("org_id", ctx.org.id);
  if (membersError) {
    // Panel-scoped failure: the rest of settings stays useful — render an
    // explicit error block below instead of an empty member list.
    reportReadFailure("settings: members", membersError);
  }

  const address =
    (org?.address as { line1?: string; city?: string; postcode?: string } | null) ?? {};
  const bank =
    (org?.bank_details as {
      name?: string;
      sort_code?: string;
      account_number?: string;
      reference?: string;
    } | null) ?? {};

  const status = ctx.org.status;
  const STATUS_PILL: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-800",
    trial: "bg-blue-100 text-blue-800",
    pending: "bg-amber-100 text-amber-800",
    suspended: "bg-red-100 text-red-700",
    rejected: "bg-slate-200 text-slate-600",
  };
  const trialDaysLeft =
    status === "trial" && ctx.org.trial_ends_at
      ? Math.max(
          0,
          Math.ceil(
            (new Date(ctx.org.trial_ends_at).getTime() - Date.now()) /
              86_400_000,
          ),
        )
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
            <HelpLink article="inviting-your-team" label="Help with your team &amp; settings" />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Your profile, your organisation, and the people in it.
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium capitalize ${STATUS_PILL[status] ?? STATUS_PILL.active}`}
          title={`Workspace status: ${status}`}
        >
          {status === "trial" && trialDaysLeft !== null
            ? `Trial · ${trialDaysLeft} ${trialDaysLeft === 1 ? "day" : "days"} left`
            : status}
        </span>
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

        <div className="mt-5 border-b border-slate-200 pb-5">
          <LogoUpload
            isAdmin={isAdmin}
            logoSrc={logoSrc}
            hasLogo={Boolean(logoSrc)}
          />
        </div>

        <OrganizationForm
          action={updateOrganization}
          isAdmin={isAdmin}
          defaults={{
            name: org?.name ?? "",
            phone: org?.phone ?? "",
            org_email: (org?.email as string | null) ?? "",
            vat_number: org?.vat_number ?? "",
            address_line1: address.line1 ?? "",
            address_city: address.city ?? "",
            address_postcode: address.postcode ?? "",
            default_terms: org?.default_terms ?? "",
            bank_name: bank.name ?? "",
            bank_sort_code: bank.sort_code ?? "",
            bank_account_number: bank.account_number ?? "",
            bank_reference: bank.reference ?? "",
          }}
        />
      </section>

      {/* Working hours ------------------------------------------------- */}
      <WorkingHoursSettings />

      {/* Tax & defaults ------------------------------------------------ */}
      <TaxDefaultsSettings />

      {/* VAT Flat Rate Scheme ------------------------------------------ */}
      <FlatRateSettings />

      {/* AI Receptionist ----------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              AI Receptionist
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              An AI receptionist that answers calls, WhatsApps and DMs,
              qualifies the job, and creates a lead automatically. White-glove
              setup by our team.
            </p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium ${aiBadge.style}`}
          >
            {aiBadge.label}
          </span>
        </div>
        <div className="mt-4">
          <Link
            href="/settings/ai-receptionist"
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            {!aiSetup || !aiSetup.enabled
              ? "Enable AI Receptionist"
              : aiSetup.status === "live"
                ? "Manage AI Receptionist"
                : "View setup status"}
          </Link>
        </div>
      </section>

      {/* API keys ------------------------------------------------------ */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">API keys</h2>
          <p className="mt-1 text-sm text-slate-600">
            Create and revoke keys for the CrewFlow API. Keys are shown once at
            creation and can be revoked at any time.
          </p>
          <div className="mt-4">
            <Link
              href="/settings/api-keys"
              className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Manage API keys
            </Link>
          </div>
        </section>
      ) : null}

      {/* Notification preferences -------------------------------------- */}
      <NotificationPreferences />

      {/* Security ------------------------------------------------------ */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Security</h2>
        <p className="mt-1 text-sm text-slate-600">
          Set up two-factor authentication and manage your linked sign-in
          methods.
        </p>
        <div className="mt-4">
          <Link
            href="/settings/security"
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Manage security
          </Link>
        </div>
      </section>

      {/* Webhooks ------------------------------------------------------ */}
      {isAdmin && outboundWebhooksEnabled() ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Webhooks</h2>
          <p className="mt-1 text-sm text-slate-600">
            Receive signed HTTPS notifications when CrewFlow events happen.
          </p>
          <div className="mt-4">
            <Link
              href="/settings/webhooks"
              className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Manage webhooks
            </Link>
          </div>
        </section>
      ) : null}

      {/* Integrations -------------------------------------------------- */}
      {isAdmin ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Integrations</h2>
          <p className="mt-1 text-sm text-slate-600">
            Connect a Google or Microsoft calendar to push scheduled jobs and
            rota shifts as events.
          </p>
          <div className="mt-4">
            <Link
              href="/settings/integrations"
              className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Manage integrations
            </Link>
          </div>
        </section>
      ) : null}

      {/* Automations --------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Automations</h2>
        <p className="mt-1 text-sm text-slate-600">
          Turn CrewFlow&apos;s built-in automations on or off, and schedule rules
          to run on a timetable.
        </p>
        <div className="mt-4">
          <Link
            href="/settings/automations"
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Manage automations
          </Link>
        </div>
      </section>

      {/* Plan & billing ----------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Plan &amp; billing
          </h2>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_PILL[status] ?? STATUS_PILL.active}`}
          >
            {status}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Your plan and its features. Manage billing, upgrade or downgrade from
          the billing page.
        </p>

        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Plan
            </dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900 capitalize">
              {ctx.org.plan}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Status
            </dt>
            <dd className="mt-0.5 text-sm font-semibold text-slate-900 capitalize">
              {status}
            </dd>
          </div>
          {status === "trial" ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-amber-800">
                Trial ends
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-amber-900">
                {ctx.org.trial_ends_at
                  ? `${ctx.org.trial_ends_at.slice(0, 10)} · ${trialDaysLeft} ${trialDaysLeft === 1 ? "day" : "days"} left`
                  : "Date not set — contact us"}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href="/settings/billing"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Manage plan &amp; billing
          </Link>
          <p className="text-xs text-slate-500">
            View your plan, features and invoices.
          </p>
        </div>
      </section>

      {/* Members ------------------------------------------------------- */}
      {membersError ? (
        <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
          <h2 className="text-base font-semibold text-red-800">Members</h2>
          <p className="mt-1 text-sm text-red-700">
            Couldn&apos;t load the members of this organisation. Refresh to try again.
          </p>
        </section>
      ) : (
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
      )}
    </div>
  );
}
