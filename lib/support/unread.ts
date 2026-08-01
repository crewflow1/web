/**
 * Portal-thread unread signals — DERIVED, no new column, no migration.
 *
 * A portal conversation (support_tickets.customer_id IS NOT NULL) has exactly
 * two speakers: the end-customer ('customer') and the tenant org ('org'). The
 * `support_messages_after_insert` trigger stamps `support_tickets.last_reply_kind`
 * on every non-internal message, so "who spoke last" is already authoritative on
 * the ticket row. We read unread straight off that:
 *
 *   TENANT side  — a thread is awaiting staff when the end-customer spoke last:
 *                  customer_id IS NOT NULL AND last_reply_kind = 'customer'.
 *   PORTAL side  — the customer has an unread staff reply when the org spoke
 *                  last: last_reply_kind = 'org'.
 *
 * This is the "last speaker" proxy for unread the directive prefers over a
 * per-viewer read marker: it needs no write on read, so it can never fire in a
 * GET/render path, and it self-clears the moment the other party replies. It
 * deliberately does NOT model "staff opened the thread but didn't reply" — that
 * would need a read-timestamp column (and a migration) for no security or
 * correctness gain here.
 *
 * Pure functions only — trivially unit-testable, safe in server or client code.
 */

/** Denormalised last-speaker signal from the after-insert trigger. */
export type LastSpeakerSignal = {
  last_reply_kind: "customer" | "hq" | "org" | null;
};

/**
 * The tenant-side shape: last-speaker PLUS the customer linkage that tells a
 * portal conversation apart from a CrewFlow helpdesk thread.
 */
export type UnreadTicketSignal = LastSpeakerSignal & {
  /** Set only for portal conversations with the org's own customer. */
  customer_id: string | null;
};

/**
 * TENANT view: this portal thread is waiting on a staff reply — the org's own
 * customer spoke last and nobody has answered. `last_reply_kind = 'hq'` (a
 * CrewFlow helpdesk thread) and `customer_id = null` are both excluded, so this
 * only ever counts the org↔customer conversation.
 */
export function isAwaitingOrgReply(t: UnreadTicketSignal): boolean {
  return t.customer_id != null && t.last_reply_kind === "customer";
}

/**
 * PORTAL view: this thread has a staff reply the customer hasn't answered yet —
 * the org ('org') spoke last. Scoping to the caller's own customer is the
 * responsibility of the query that produced the list (see the portal messages
 * page); this predicate only reads the last-speaker signal.
 */
export function hasUnreadOrgReplyForCustomer(t: LastSpeakerSignal): boolean {
  return t.last_reply_kind === "org";
}

/** TENANT unread badge count — portal threads awaiting a staff reply. */
export function countAwaitingOrgReply(
  tickets: ReadonlyArray<UnreadTicketSignal>,
): number {
  return tickets.reduce((n, t) => (isAwaitingOrgReply(t) ? n + 1 : n), 0);
}

/** PORTAL unread badge count — threads with an unanswered staff reply. */
export function countUnreadOrgRepliesForCustomer(
  tickets: ReadonlyArray<LastSpeakerSignal>,
): number {
  return tickets.reduce(
    (n, t) => (hasUnreadOrgReplyForCustomer(t) ? n + 1 : n),
    0,
  );
}
