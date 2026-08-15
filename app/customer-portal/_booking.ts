import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  buildPortalSlotView,
  buildPortalBookingView,
  type PortalSlotView,
  type PortalBookingView,
} from "@/lib/maintenance/booking";

/**
 * Customer-portal service-booking reads (P3).
 *
 * TWO reads, two scopes:
 *
 *  • listBookableSlots(orgId) — the org's OWN published, active, future slots and
 *    their REMAINING capacity. Slots are org-level availability (a shared
 *    resource, not one customer's data), so the scope is org_id only; the live
 *    booked COUNT per slot is aggregated from slot_id, and NO other customer's
 *    booking row is ever exposed (only slot_id is selected for the count).
 *
 *  • listPortalServiceBookings(customerId, orgId) — the customer's OWN bookings.
 *    SCOPING PROOF: service_bookings carries org_id AND customer_id (composite-FK
 *    bound to the customer). This filters on BOTH, resolved from the token, so a
 *    customer sees only their own bookings even on the admin client. The slot
 *    details are then read org-scoped for those booking slot ids. Never widened.
 *
 * F-1: every set read is paged via fetchAllRows on a stable unique order.
 */

type Row = Record<string, unknown>;
type Q = PromiseLike<{ data: Row[] | null; error: SupabaseReadError | null }> & {
  select: (c: string) => Q;
  eq: (k: string, v: unknown) => Q;
  gte: (k: string, v: unknown) => Q;
  in: (k: string, v: unknown[]) => Q;
  order: (k: string, o: { ascending: boolean }) => Q;
  range: (from: number, to: number) => Q;
};
type LooseAdmin = { from: (t: string) => Q };

const S = (v: unknown) => (v == null ? null : String(v));

export async function listBookableSlots(orgId: string): Promise<PortalSlotView[]> {
  const admin = createAdminClient() as unknown as LooseAdmin;
  const nowIso = new Date().toISOString();

  // 1. The org's published, active, still-upcoming slots.
  const { data: slotData, error: slotErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("service_booking_slots")
      .select("id, starts_at, ends_at, label, capacity, active")
      .eq("org_id", orgId)
      .eq("active", true)
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (slotErr) throw readFailure("portal booking: slots", slotErr);
  const slots = slotData;
  if (slots.length === 0) return [];
  const slotIds = slots.map((s) => String(s.id));

  // 2. Live bookings on those slots — COUNT ONLY (slot_id selected, nothing
  // customer-identifying). Org-scoped and constrained to this org's slot set.
  const { data: bookingData, error: bookErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("service_bookings")
      .select("slot_id, status")
      .eq("org_id", orgId)
      .in("slot_id", slotIds)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (bookErr) throw readFailure("portal booking: live counts", bookErr);
  const liveBySlot = new Map<string, number>();
  for (const b of bookingData) {
    const st = String(b.status);
    if (st === "requested" || st === "confirmed") {
      const k = String(b.slot_id);
      liveBySlot.set(k, (liveBySlot.get(k) ?? 0) + 1);
    }
  }

  return slots
    .map((s) =>
      buildPortalSlotView({
        id: String(s.id),
        starts_at: String(s.starts_at),
        ends_at: String(s.ends_at),
        label: S(s.label),
        capacity: Number(s.capacity ?? 0),
        live_booked: liveBySlot.get(String(s.id)) ?? 0,
      }),
    )
    .filter((s) => s.seats_left > 0);
}

export async function listPortalServiceBookings(
  customerId: string,
  orgId: string,
): Promise<PortalBookingView[]> {
  const admin = createAdminClient() as unknown as LooseAdmin;

  // 1. The customer's OWN bookings — the cross-customer barrier.
  const { data: bookingData, error: bookErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("service_bookings")
      .select("id, slot_id, status, warranty_id, created_at")
      .eq("org_id", orgId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (bookErr) throw readFailure("portal booking: bookings", bookErr);
  const bookings = bookingData;
  if (bookings.length === 0) return [];

  // 2. Slot details for those bookings — org-scoped.
  const slotIds = [...new Set(bookings.map((b) => String(b.slot_id)))];
  const { data: slotData, error: slotErr } = await fetchAllRows<Row>((from, to) =>
    admin
      .from("service_booking_slots")
      .select("id, starts_at, ends_at, label")
      .eq("org_id", orgId)
      .in("id", slotIds)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (slotErr) throw readFailure("portal booking: booking slots", slotErr);
  const slotById = new Map(slotData.map((s) => [String(s.id), s]));

  return bookings.map((b) => {
    const slot = slotById.get(String(b.slot_id));
    return buildPortalBookingView({
      id: String(b.id),
      status: String(b.status),
      warranty_id: S(b.warranty_id),
      slot_starts_at: slot ? S(slot.starts_at) : null,
      slot_ends_at: slot ? S(slot.ends_at) : null,
      slot_label: slot ? S(slot.label) : null,
    });
  });
}
