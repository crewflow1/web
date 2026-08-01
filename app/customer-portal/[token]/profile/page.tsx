import { loadCustomerByPortalToken } from "../../_helpers";
import { loadPortalPreferences } from "../../_preferences";
import {
  requestProfileUpdate,
  savePortalPreferences,
} from "../../_preferences-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  PREFERRED_CHANNELS,
  PREFERRED_CHANNEL_LABELS,
} from "@/lib/customers/portal-preferences";

export const metadata = { title: "Profile · CrewFlow" };

/**
 * Customer portal — profile & contact preferences.
 *
 * Name/email/phone are READ-ONLY here by design: those are the org's records
 * (invoices, quotes and this portal link itself are delivered against them),
 * so the portal never writes public.customers. Edits are REQUESTS — a support
 * ticket staff review and apply (see _preferences-action.ts). Communication
 * preferences, by contrast, belong to the customer and save directly.
 */

type SP = Promise<{ saved?: string; error?: string }>;

const inputClass =
  "mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

export default async function PortalProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const preferences = await loadPortalPreferences(customer.id, customer.org_id);

  const banner = (() => {
    if (sp.saved === "preferences")
      return { tone: "ok" as const, msg: "Preferences saved." };
    if (sp.saved === "requested")
      return {
        tone: "ok" as const,
        msg: `Change requested. ${org.name} will update your details and confirm.`,
      };
    if (sp.error) return { tone: "err" as const, msg: `Error: ${sp.error}` };
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="profile">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Your details</h2>
        <p className="text-sm text-slate-600">
          What {org.name} has on file, and how you&apos;d like to be contacted.
        </p>
      </header>

      {banner ? (
        <div
          role="alert"
          className={`rounded-md border px-3 py-2 text-sm ${banner.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
        >
          {banner.msg}
        </div>
      ) : null}

      {/* Current details — read-only on purpose. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">On file</h3>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-slate-500">Name</dt>
            <dd className="font-medium text-slate-900">{customer.name}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-slate-500">Email</dt>
            <dd className="font-medium text-slate-900">
              {customer.email ?? "Not on file"}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-slate-500">Phone</dt>
            <dd className="font-medium text-slate-900">
              {customer.phone ?? "Not on file"}
            </dd>
          </div>
        </dl>
      </section>

      {/* Communication preferences — the customer's own, saved directly. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">
          How should {org.name} contact you?
        </h3>
        <form action={savePortalPreferences} className="mt-3 space-y-3">
          <input type="hidden" name="token" value={token} />
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">
              Preferred way to reach you
            </legend>
            <div className="mt-1 space-y-1">
              {PREFERRED_CHANNELS.map((c) => (
                <label
                  key={c}
                  className="flex min-h-[44px] items-center gap-2 rounded-md px-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="radio"
                    name="preferred_channel"
                    value={c}
                    required
                    defaultChecked={
                      preferences
                        ? preferences.preferred_channel === c
                        : c === "email"
                    }
                    className="h-5 w-5 border-slate-300 text-slate-900 focus:ring-slate-500"
                  />
                  {PREFERRED_CHANNEL_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">
              Anything we should know? (optional)
            </span>
            <textarea
              name="contact_notes"
              maxLength={500}
              rows={2}
              defaultValue={preferences?.contact_notes ?? ""}
              placeholder="e.g. Mornings only, please"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Save preferences
          </button>
          {preferences?.updated_on ? (
            <p className="text-[11px] text-slate-500">
              Last saved {preferences.updated_on}
            </p>
          ) : null}
        </form>
      </section>

      {/* Profile changes — requests, applied by staff. Said plainly on-page. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">
          Need a detail corrected?
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          For your security, changes to your name, email or phone are reviewed
          and applied by {org.name} — they aren&apos;t changed instantly. Fill in
          only what should change.
        </p>
        <form action={requestProfileUpdate} className="mt-3 space-y-3">
          <input type="hidden" name="token" value={token} />
          <label className="block text-sm">
            <span className="font-medium text-slate-700">New name</span>
            <input name="requested_name" type="text" maxLength={200} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">New email</span>
            <input name="requested_email" type="email" maxLength={254} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">New phone</span>
            <input name="requested_phone" type="tel" maxLength={50} className={inputClass} />
          </label>
          <button
            type="submit"
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Request the change
          </button>
        </form>
      </section>
    </PortalShell>
  );
}
