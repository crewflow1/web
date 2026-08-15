import { z } from "zod";

/**
 * Service booking — pure layer (P3 portal completeness).
 *
 * A booking is the customer picking a concrete operator-published slot for a
 * servicing visit — distinct from the loose future-work request (a lead). This
 * module is the pure layer: input validation and the customer-safe projections
 * for both bookable slots and the customer's own bookings.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const serviceBookingSchema = z.object({
  slot_id: z.string().regex(UUID_RE, "Pick a slot"),
  // Optional — a booking may be against a specific warranty's servicing, or a
  // general service visit. Validated against the customer's own warranties in
  // the action; here we only bound the shape.
  warranty_id: z
    .string()
    .regex(UUID_RE)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type ServiceBookingInput = z.infer<typeof serviceBookingSchema>;

/** Coarse, customer-safe booking-status words. */
export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "cancelled",
  "completed",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
};

export const BOOKING_STATUS_STYLES: Record<BookingStatus, string> = {
  requested: "bg-amber-100 text-amber-800",
  confirmed: "bg-green-100 text-green-700",
  cancelled: "bg-slate-100 text-slate-600",
  completed: "bg-blue-100 text-blue-700",
};

export function toBookingStatus(status: string): BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(status)
    ? (status as BookingStatus)
    : "requested";
}

// ── Bookable slot projection ─────────────────────────────────────────────────
export type PortalSlotView = {
  id: string;
  starts_at: string;
  ends_at: string;
  label: string | null;
  /** Remaining capacity — never the raw capacity or the other customers on it. */
  seats_left: number;
};

export function buildPortalSlotView(row: {
  id: string;
  starts_at: string;
  ends_at: string;
  label: string | null;
  capacity: number;
  live_booked: number;
}): PortalSlotView {
  const seats = Math.max(0, Math.trunc(row.capacity) - Math.trunc(row.live_booked));
  return {
    id: row.id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    label: row.label ?? null,
    seats_left: seats,
  };
}

// ── Booking read-back projection ─────────────────────────────────────────────
export const BOOKING_PORTAL_KEYS = [
  "id",
  "slot_starts_at",
  "slot_ends_at",
  "slot_label",
  "status",
  "warranty_id",
] as const;

export type PortalBookingView = {
  id: string;
  slot_starts_at: string | null;
  slot_ends_at: string | null;
  slot_label: string | null;
  status: BookingStatus;
  warranty_id: string | null;
};

export function buildPortalBookingView(row: {
  id: string;
  status: string;
  warranty_id: string | null;
  slot_starts_at: string | null;
  slot_ends_at: string | null;
  slot_label: string | null;
}): PortalBookingView {
  return {
    id: row.id,
    slot_starts_at: row.slot_starts_at ?? null,
    slot_ends_at: row.slot_ends_at ?? null,
    slot_label: row.slot_label ?? null,
    status: toBookingStatus(row.status),
    warranty_id: row.warranty_id ?? null,
  };
}
