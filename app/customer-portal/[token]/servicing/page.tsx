import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalWarranties } from "../../_warranties";
import { listBookableSlots, listPortalServiceBookings } from "../../_booking";
import { bookServiceSlot } from "../../_booking-action";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  BOOKING_STATUS_LABELS,
  BOOKING_STATUS_STYLES,
} from "@/lib/maintenance/booking";

export const metadata = { title: "Book a service · CrewFlow" };

/**
 * Customer portal — maintenance / service booking (P3).
 *
 * Distinct from the loose future-work request: here the customer books a CONCRETE
 * operator-published slot (a date + time the org has opened), optionally against
 * one of their warranties' servicing. Availability, ownership and capacity are
 * all enforced server-side; the read-back below shows the customer's own bookings.
 */

type SP = Promise<{ saved?: string; error?: string }>;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function PortalServicingPage({
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

  const [slots, bookings, warranties] = await Promise.all([
    listBookableSlots(customer.org_id),
    listPortalServiceBookings(customer.id, customer.org_id),
    listPortalWarranties(customer.id, customer.org_id),
  ]);
  // Only warranties with a servicing cadence are worth attaching to a booking.
  const serviceableWarranties = warranties.filter(
    (w) => w.service_interval_months && w.status === "active",
  );

  const banner = (() => {
    if (sp.saved === "booked")
      return {
        tone: "ok" as const,
        msg: `Booking requested. ${org.name} will confirm your slot.`,
      };
    const errors: Record<string, string> = {
      invalid_token: "This link is not valid.",
      rate_limited: "Too many requests — please wait a minute and try again.",
      invalid_input: "Please pick a slot and try again.",
      warranty_not_found: "That warranty could not be found.",
      slot_unavailable: "That slot is no longer available. Please pick another.",
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
    <PortalShell customer={customer} org={org} token={token} active="servicing">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Book a service</h2>
        <p className="text-sm text-slate-600">
          Pick a slot {org.name} has opened for servicing and maintenance visits.
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
        <h3 className="text-sm font-semibold text-slate-900">Available slots</h3>
        {slots.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            No slots are open just now. Please check back, or send a message under
            Messages and {org.name} will arrange a visit.
          </p>
        ) : (
          <form action={bookServiceSlot} className="mt-3 space-y-3">
            <input type="hidden" name="token" value={token} />
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Choose a slot</span>
              <select
                name="slot_id"
                required
                defaultValue=""
                className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                <option value="" disabled>
                  Select a date and time…
                </option>
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {fmt(s.starts_at)}
                    {s.label ? ` · ${s.label}` : ""}
                    {s.seats_left <= 3 ? ` · ${s.seats_left} left` : ""}
                  </option>
                ))}
              </select>
            </label>

            {serviceableWarranties.length > 0 ? (
              <label className="block text-sm">
                <span className="font-medium text-slate-700">
                  For which warranty? (optional)
                </span>
                <select
                  name="warranty_id"
                  defaultValue=""
                  className="mt-1 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                >
                  <option value="">General service visit</option>
                  {serviceableWarranties.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.title} (Job {w.job_reference})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block text-sm">
              <span className="font-medium text-slate-700">
                Anything we should know? (optional)
              </span>
              <textarea
                name="notes"
                maxLength={2000}
                rows={3}
                placeholder="Access notes, what needs looking at…"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </label>
            <button
              type="submit"
              className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Request booking
            </button>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Your bookings</h3>
        {bookings.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
            No bookings yet. Request a slot above.
          </p>
        ) : (
          <ul className="space-y-2">
            {bookings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {fmt(b.slot_starts_at)}
                    {b.slot_label ? ` · ${b.slot_label}` : ""}
                  </p>
                  {b.slot_ends_at ? (
                    <p className="text-xs text-slate-500">
                      Until {fmt(b.slot_ends_at)}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${BOOKING_STATUS_STYLES[b.status]}`}
                >
                  {BOOKING_STATUS_LABELS[b.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PortalShell>
  );
}
