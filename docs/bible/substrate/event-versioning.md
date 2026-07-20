# Event Spine — Event Versioning (engineering rule)

> **Status: live and enforced.** This is an engineering *rule*, not an ADR and not
> a proposal. It makes concrete the `schema_version` the canonical envelope already
> reserves (`./README.md` §P1; Volume XI §4.2). Introduced under **CEO Directive
> #012** alongside the Generic Task Engine, but it governs the **whole** Event
> Spine — every registered event, in every domain.
>
> **It changes no behaviour today.** Nothing about how events are emitted or
> consumed changes. The rule exists to give every event a *stable identifier* that
> replay, analytics and future schema evolution can key off — so that an event
> written today is still unambiguously readable years from now.

---

## 1. The rule

> **Every registered event carries a stable, integer schema version, starting at
> `1`. A version is immutable once shipped: a backward-incompatible change to an
> event's payload mints a NEW version — it never edits or reuses an old one.**

That is the whole rule. The rest of this document is what it means, why, and where
it is enforced.

The version is a property of the **event's payload shape** (its `verb` + the
meaning of its `payload` fields), not of any single occurrence. Two events with the
same `verb` and the same version are guaranteed to share a payload contract; a
consumer that understands `task.completed` **v1** can read *every* `task.completed`
v1 event ever written, in order, forever.

---

## 2. Why — events are immutable history

`hq_events` is **append-only**: the spine blocks `UPDATE`/`DELETE` even under the
service-role (`./README.md` §P1), and replay re-derives read-models deterministically
from the raw log (Volume XI §10). That is the spine's superpower — and its
constraint. Because old events are *never rewritten*, the day a payload's meaning
changes, history splits into "the old shape" and "the new shape," and a consumer
**must** be able to tell them apart to read both correctly.

A version identifier is what makes that tractable:

- **Replay** — rebuilding a projection from event #1 means re-reading years of
  payloads. A consumer branches on the version to apply the right interpretation to
  each era of history, instead of guessing from field presence.
- **Analytics** — a metric computed over `task.*` history is only sound if the
  payload fields it reads mean the same thing across every row it touches. The
  version is the join key that keeps a query honest across a schema change.
- **Schema evolution** — adding capability later (a new payload field, a renamed
  one, a changed unit) becomes a *new version*, shipped without breaking a single
  reader of the old one. Evolution stops being a migration of history (impossible —
  it's append-only) and becomes a fork the consumers opt into.

Without versions, the only safe schema change is "never change anything," which no
living system can hold to. The version is the seam that lets the contract evolve
while history stays readable.

---

## 3. What counts as a version bump

A bump is mandatory for any **backward-incompatible** payload change — anything a
naive consumer of the old shape could silently mis-read:

- removing or renaming a payload field a consumer relied on;
- changing a field's type, unit, or semantic meaning (e.g. seconds → milliseconds,
  or `reason` gaining a value with new implications);
- changing what the event *means* (the same verb now fires for a different fact).

A bump is **not** required for a purely additive, optional field that old consumers
correctly ignore (the spine's "tolerant reader" posture — Volume XI §4.2: *"adding
a field is a new version, never an in-place break"* applies to *meaningful* additions
a consumer must branch on; a strictly optional, ignorable annotation may ride the
same version at the author's discretion). **When in doubt, bump** — a spurious
version costs one map entry; a missed one silently corrupts replay.

Renaming a *verb* is a different and heavier act (a new event identity, an ADR, a
breaking change to the registry — `lib/events/registry.ts` header). Versioning is
for evolving an event whose **name stays the same**.

---

## 4. Where the version lives — registry-first, producer-side

The single source of every event's version is the **TypeScript registry**,
`lib/events/registry.ts` — the same file that is the single source of event *names*.
This is deliberate and matches the spine's standing security posture (Volume XI §4.2
and §16, *"verb registry: data vs. code"*): **verb and payload-schema validity are a
PRODUCER contract, validated before the write — never a hot-path DB constraint.** A
bad version can no more wedge the append-only log than a bad verb can, because the
database only enforces the cheap envelope CHECKs (`actor_type`, `severity`) and
trusts the producer for the rest.

The encoding is intentionally tiny, because today **every event is v1**:

```ts
// lib/events/registry.ts
export const EVENT_SCHEMA_VERSION_BASELINE = 1 as const;

// A verb appears here ONLY once its payload schema has changed incompatibly;
// the value is the current version (always ≥ 2). Absent ⇒ v1.
export const EVENT_SCHEMA_VERSION_OVERRIDES: Partial<Record<Verb, number>> = {};

export function eventSchemaVersion(verb: Verb): number {
  return EVENT_SCHEMA_VERSION_OVERRIDES[verb] ?? EVENT_SCHEMA_VERSION_BASELINE;
}
```

- **Baseline, not boilerplate.** Rather than list `: 1` against all ~80 verbs (noise
  that drifts), the baseline is implicit and only **bumps** are recorded — one line
  each, added in the *same* edit as the payload change and its ADR. `eventSchemaVersion(verb)`
  resolves the current version of any registered event.
- **One source.** The version sits beside the name, so "what events exist and what
  shape are they in" has exactly one answer, in one file, that both the server
  emitter and the client UI import (the registry carries no `server-only`).

---

## 5. How the version travels (today vs. forward)

- **Today (no behavioural change).** The registry is the authoritative version
  catalogue. Emission is **unchanged**: the Task Engine's events (and every other
  domain's) are written exactly as before. Because every event is v1, there is
  nothing to disambiguate at read time yet, and the rule deliberately adds no field
  to any payload.
- **Forward (when a payload first evolves).** The canonical envelope reserves
  `payload.schema_version` for exactly this (`./README.md` §P1: *payload "carries
  `schema_version`"*). When an event's payload first bumps past v1 — or when the AI
  SDK `events.publish()` path lands (Volume XI §4.2, XIII) and validates payloads
  against the registry — the producer stamps `schema_version` into the payload at
  emit time, sourced from `eventSchemaVersion(verb)`. That is the point at which the
  version becomes self-describing on the wire. **Retrofitting it onto already-emitted
  v1 events is neither needed nor done** (they are, by definition, v1; the absence of
  the field *is* the v1 signal).

This staging is what keeps the rule a *rule* and not a migration: the contract is
fixed now; the on-the-wire mechanism arrives with the first change that needs it.

---

## 6. Enforcement (the drift gate)

The rule is held by a contract test in the unit tier
(`__tests__/lib/event-registry.test.ts`), so it cannot quietly rot:

- the baseline is `1`;
- **every** registered verb resolves to a positive-integer version (no event can
  exist without one);
- the override map contains **only registered verbs** (no orphan / typo'd entry) and
  **only genuine bumps** (`≥ 2` — an override of `1` is redundant and rejected).

Adding a versioned event, or bumping one, that violates these fails CI here — the
same "deliberate-change tripwire" discipline the registry uses for its verb count.

---

## 7. Checklist — bumping an event's version

When an event's payload must change incompatibly:

1. Add (or increment) its entry in `EVENT_SCHEMA_VERSION_OVERRIDES` in
   `lib/events/registry.ts`.
2. Update the event's payload contract in its domain reference (for `task.*`, that is
   `./task-event-contract.md`) — record the new version and the new shape *beside*
   the old, never over it.
3. Have producers stamp `payload.schema_version = eventSchemaVersion(verb)` and have
   consumers branch on it.
4. Write the ADR (`../decisions/NNNN-*.md`) that records why the shape changed, in the
   same PR.
5. The drift test (§6) goes green only when the override is a real bump for a real
   verb.

---

*Engineering rule of the Event Spine (CEO Directive #012 / D-02). Companion to the
canonical envelope (`./README.md` §P1), the Event Bus (`./volume-11-event-bus.md`
§4.2, §10), and the registry (`lib/events/registry.ts`). The first domain to record
its per-event contracts under this rule is the Task Engine — see
`./task-event-contract.md`.*
