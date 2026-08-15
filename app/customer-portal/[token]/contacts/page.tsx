import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalContacts } from "../../_contacts";
import { addCustomerContact } from "../../_contact-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { CONTACT_ROLES, CONTACT_ROLE_LABELS } from "@/lib/customers/contacts";

export const metadata = { title: "Contacts · CrewFlow" };

/**
 * Customer portal — named contacts (P3).
 *
 * Lists the customer's own contacts (scoped org_id + customer_id) and lets them
 * add a reachable person. Provisioning scoped portal ACCESS for a contact is a
 * staff action — the portal never mints a login token — so this page shows
 * whether a contact has access but never exposes the credential.
 */

type SP = Promise<{ saved?: string; error?: string }>;

export default async function PortalContactsPage({
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

  const contacts = await listPortalContacts(customer.id, customer.org_id);

  const banner = (() => {
    if (sp.saved === "contact_added")
      return { tone: "ok" as const, msg: "Contact added." };
    const errors: Record<string, string> = {
      invalid_token: "This link is not valid.",
      rate_limited: "Too many requests — please wait a minute and try again.",
      invalid_input: "Please check the form — add a name and an email or phone.",
      could_not_submit: "Something went wrong. Please try again.",
    };
    if (sp.error)
      return {
        tone: "err" as const,
        msg: errors[sp.error] ?? "Something went wrong. Please try again.",
      };
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="contacts">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Contacts</h2>
        <p className="text-sm text-slate-600">
          People {org.name} can reach about your account. Add anyone who should be
          kept in the loop.
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

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-900">Add a contact</h3>
        <form action={addCustomerContact} className="mt-3 space-y-3">
          <input type="hidden" name="token" value={token} />
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Name</span>
            <input
              name="name"
              type="text"
              required
              minLength={2}
              maxLength={200}
              placeholder="e.g. Jordan Smith"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Email</span>
              <input
                name="email"
                type="email"
                maxLength={320}
                placeholder="name@example.com"
                className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Phone</span>
              <input
                name="phone"
                type="tel"
                maxLength={50}
                placeholder="07…"
                className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Role</span>
            <select
              name="role"
              defaultValue="other"
              className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              {CONTACT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {CONTACT_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-slate-500">
            Add an email or a phone number so we can reach them.
          </p>
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Add contact
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Your contacts</h3>
        {contacts.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No contacts yet. Add your first one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {contacts.map((c) => (
              <li
                key={c.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {c.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">{c.role_label}</p>
                    <div className="mt-1 space-y-0.5 text-sm text-slate-700">
                      {c.email ? <p className="truncate">{c.email}</p> : null}
                      {c.phone ? <p>{c.phone}</p> : null}
                    </div>
                  </div>
                  {c.has_portal_access ? (
                    <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                      Portal access
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
