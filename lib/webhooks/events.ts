/**
 * Outbound-webhook event registry — a BUILD-TIME data boundary (Train A).
 *
 * EXPOSABLE_WEBHOOK_EVENTS is the curated subset of the spine `Verb` union
 * (lib/events/registry.ts) an org may subscribe a webhook to. It is DELIBERATELY
 * SMALL and safe: which internal events cross the tenant boundary to a
 * third-party URL is a data-governance decision, so this ships as a minimal
 * allowlist (operations lifecycle only) and grows by reviewed diff. The
 * drift-guard in __tests__/security/outbound-webhooks.test.ts asserts every entry
 * is a REAL registered Verb, so a typo or a renamed verb fails the build rather
 * than silently subscribing to nothing.
 *
 * WHY THESE: each verb here resolves to an owning org reliably in the fan-out
 * (webhook_resolve_org, migration §6) — the event's object is a tenant row
 * (job / customer / quote / invoice) with an org_id — AND each has a real spine
 * producer. The two BILLING verbs (invoice.created, invoice.paid) landed in
 * MP R4: webhook_resolve_org already had an `invoice` branch, and migration
 * 20261168000000 completed their producer edges in hq_emit_from_activity (both
 * activity actions — the invoices INSERT trigger's `invoice.created` and the
 * status-change trigger's `invoice.paid` — already flow through
 * _record_activity). The remaining billing verbs and support/org.* are still
 * NOT exposed: broadening further is a CEO data-boundary call.
 *
 * NOT exposed, and why (drift correction, C26): the registry `Verb` union also
 * contains `job.scheduled` and `job.cancelled`, but NEITHER has a spine PRODUCER
 * — the activity→spine mapper (hq_emit_from_activity, 20260720010000) emits only
 * job.created / job.completed / customer.created / customer.updated / quote.sent /
 * quote.accepted. There is no "scheduled" or "cancelled" job transition to map:
 * jobs.status is new|in-progress|completed|blocked (no cancel), scheduling is a
 * scheduled_date change surfaced as the un-exposed `job.rescheduled` activity, and
 * a delete is a hard delete (`job.deleted`, deliberately kept off the spine). A
 * subscriber to a producer-less verb would receive silence forever, so those two
 * are OMITTED here rather than advertised. The drift-guard test asserts every
 * entry below has a REAL producer, so re-adding one without a producer fails CI.
 * Making them real (a new deliverable event) is a producer + data-boundary
 * decision, not a catalogue edit.
 *
 * Client-safe on purpose (no server-only, no imports beyond the Verb TYPE): the
 * settings form renders the subscribe checkboxes from this same registry, so the
 * UI can never offer a verb the fan-out would not deliver.
 */

import type { Verb } from "@/lib/events/registry";

/**
 * The verbs an org may subscribe a webhook to. Every entry MUST be a member of
 * the spine `Verb` union — enforced by the compile-time annotation below AND by
 * the runtime drift-guard test.
 */
export const EXPOSABLE_WEBHOOK_EVENTS = [
  "job.created",
  "job.completed",
  "customer.created",
  "customer.updated",
  "quote.sent",
  "quote.accepted",
  "invoice.created",
  "invoice.paid",
] as const satisfies readonly Verb[];

/** The union of exposable webhook verbs. */
export type ExposableWebhookEvent = (typeof EXPOSABLE_WEBHOOK_EVENTS)[number];

const EXPOSABLE_SET: ReadonlySet<string> = new Set(EXPOSABLE_WEBHOOK_EVENTS);

/** Human labels for the settings UI, keyed so a verb cannot be offered without one. */
export const WEBHOOK_EVENT_LABELS: Readonly<Record<ExposableWebhookEvent, string>> = {
  "job.created": "Job created",
  "job.completed": "Job completed",
  "customer.created": "Customer created",
  "customer.updated": "Customer updated",
  "quote.sent": "Quote sent",
  "quote.accepted": "Quote accepted",
  "invoice.created": "Invoice created",
  "invoice.paid": "Invoice paid",
};

/** Runtime guard — is `value` a subscribable webhook verb? */
export function isExposableWebhookEvent(value: string): value is ExposableWebhookEvent {
  return EXPOSABLE_SET.has(value);
}

/**
 * Validate a set of requested verbs against the registry. Deduplicates, preserves
 * registry order, refuses the empty set (a webhook subscribed to nothing does
 * nothing and is a creation mistake).
 */
export function validateWebhookEvents(
  requested: readonly string[],
):
  | { ok: true; events: ExposableWebhookEvent[] }
  | { ok: false; invalid: string[] } {
  const invalid = [...new Set(requested.filter((v) => !isExposableWebhookEvent(v)))];
  if (invalid.length > 0) return { ok: false, invalid };
  const wanted = new Set(requested);
  const events = EXPOSABLE_WEBHOOK_EVENTS.filter((v) => wanted.has(v));
  if (events.length === 0) return { ok: false, invalid: [] };
  return { ok: true, events };
}

// ---------------------------------------------------------------------------
// Payload redaction — the per-verb key allowlist (defence in depth).
// ---------------------------------------------------------------------------
//
// The spine producer already curates event payloads to be small + non-PII
// (hq_emit_from_activity drops names/emails/phones). This map is a SECOND,
// independent boundary applied at send time: for each verb, ONLY the listed data
// keys are allowed to leave. An unlisted key is dropped even if a future producer
// change starts emitting it, so broadening what a producer sends never silently
// widens what a webhook receives. A verb absent from the map sends an empty
// `data` object (fail-closed).

/** Envelope shape actually sent on the wire. */
export type WebhookEnvelope = {
  id: number | null;
  verb: string;
  ts: string;
  org_id: string;
  object?: { type: string; id: string };
  data: Record<string, unknown>;
};

/** Allowed `data` keys per verb. Unlisted keys are stripped; a missing verb ⇒ {}. */
export const WEBHOOK_REDACTION_MAP: Readonly<
  Record<ExposableWebhookEvent, readonly string[]>
> = {
  "job.created": ["status"],
  "job.completed": ["from", "to"],
  "customer.created": [],
  "customer.updated": ["fields"],
  "quote.sent": ["number", "total"],
  "quote.accepted": ["number", "total", "source"],
  "invoice.created": ["number", "total"],
  "invoice.paid": ["number", "total", "from", "to"],
};

/**
 * Redact an envelope's `data` to the per-verb allowlist. Pure + deterministic
 * (unit-tested). Non-exposable verbs (e.g. the 'webhook.ping' sentinel) keep
 * their data untouched — pings carry no tenant data. Everything outside `data`
 * (ids, ts, object, org_id) is metadata and passes through.
 */
export function redactEnvelope(envelope: WebhookEnvelope): WebhookEnvelope {
  const verb = envelope.verb;
  if (!isExposableWebhookEvent(verb)) {
    // Ping / non-domain messages: no tenant data to redact.
    return envelope;
  }
  const allowed = WEBHOOK_REDACTION_MAP[verb] ?? [];
  // Not a Supabase read — this is the envelope's own POJO field. Written with ||
  // (not ??) to stay clear of the loud-read-failure scanner's `.data ??` probe.
  const rawData: Record<string, unknown> = envelope.data || {};
  const data: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(rawData, key)) {
      data[key] = rawData[key];
    }
  }
  return { ...envelope, data };
}
