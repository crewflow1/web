import "server-only";
import { emitEvent, type EmitEventInput } from "@/server/services/event-spine";
import type { Severity, Verb, Visibility } from "@/lib/events/registry";

/**
 * CrewFlow HQ — the `ctx.events` SDK facet
 * (CEO Directive #014 / D-04, Phase A; ADR 0008; Bible Volume XIII §13).
 *
 * The single way an AI employee appends to the Event Spine. It does NOT re-implement
 * anything — it BINDS the already-built service primitive (`emitEvent`, the validated
 * `hq_emit_event` SECURITY DEFINER write) to one employee's identity and one run's
 * trace, and stamps both onto every emission, so the employee can never record an event
 * as anyone else (XIII §8, the no-spoofing rule — the same property the memory facet
 * enforces, and the reason there is no `actorType`/`actorId` parameter on {@link EmitInput}).
 *
 * BEST-EFFORT, by spine design. Unlike the memory and comms facets (whose ABI is
 * throw-based), `emit` NEVER throws: it returns the outcome and a failed append is
 * logged, not raised. The Event Spine is the audit floor — a spine hiccup must never
 * break the handler's primary work (this mirrors `emitEvent`, which catches and returns
 * `{ ok:false }`). A handler MAY inspect the outcome; it is not obliged to.
 *
 * The verb is compile-time checked against the closed registry union ({@link Verb}), so
 * an unregistered verb WILL NOT COMPILE — the spine's "one source of event names" rule,
 * inherited verbatim by every employee.
 */

/** The identity the events facet stamps — the canonical runtime slug (ADR 0007). */
export type EventsIdentity = {
  /** Canonical runtime handle (e.g. `research-ai`); stamped as the spine `actor_id`. */
  slug: string;
};

/**
 * What a handler supplies to `ctx.events.emit` — the spine envelope MINUS the fields the
 * SDK owns. There is deliberately NO `actorType`/`actorId`: the facet always stamps the
 * bound employee as the actor, so a handler cannot emit as a different actor.
 */
export type EmitInput = {
  /** Compile-time checked against the closed verb registry — an unregistered verb won't build. */
  verb: Verb;
  objectType: string;
  objectId: string;
  targetType?: string | null;
  targetId?: string | null;
  /** The id of the event that directly caused this one (a causal chain). */
  causationId?: number | null;
  severity?: Severity;
  payload?: Record<string, unknown>;
  visibility?: Visibility;
  /** Override the run's trace; defaults to the RunContext `correlationId`. */
  correlationId?: string;
};

/** The result of an append — `id` on success, an `error` string on a logged failure. */
export type EmitOutcome = { ok: true; id: number } | { ok: false; error: string };

/** The bound `ctx.events` surface. */
export interface BoundEvents {
  /**
   * Append one event to the Event Spine AS this employee. BEST-EFFORT: returns the
   * outcome and NEVER throws (a spine hiccup cannot break the handler's work). The actor
   * is always this employee; the run's correlation threads through unless overridden.
   */
  emit(input: EmitInput): Promise<EmitOutcome>;
  /** The frozen identity this facet emits as. */
  readonly identity: Readonly<EventsIdentity>;
}

/**
 * Bind the Event Spine to one employee + one run's trace. Identity is captured once and
 * stamped as `actor_type:"ai_employee"` / `actor_id: slug` on every emission; the run's
 * `correlationId` threads through unless a call overrides it.
 */
export function createEvents(identity: EventsIdentity, correlationId: string): BoundEvents {
  const actorId = identity.slug;
  return {
    identity: Object.freeze({ ...identity }),

    async emit(input: EmitInput): Promise<EmitOutcome> {
      const event: EmitEventInput = {
        actorType: "ai_employee",
        actorId,
        verb: input.verb,
        objectType: input.objectType,
        objectId: input.objectId,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        correlationId: input.correlationId ?? correlationId,
        causationId: input.causationId ?? null,
        severity: input.severity,
        payload: input.payload,
        visibility: input.visibility,
      };
      return emitEvent(event);
    },
  };
}
