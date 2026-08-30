# ADR 0015 — Deletion policy: terminal states + RESTRICT + erasure, not blanket soft-delete

- **Status:** Accepted (records the platform's long-standing shipped posture;
  written down per the final-roadmap re-audit's R135 finding that the policy
  existed everywhere except on paper)
- **Date:** 2026-08-30

## Context

The roadmap asks for "soft delete **where appropriate**". The platform's
shipped answer is a three-mechanism policy rather than a `deleted_at` column
on every table:

1. **Terminal states for business records.** A record with commercial or
   audit meaning never disappears — it moves to a trigger-enforced terminal
   state and stays: invoice `void` (20261219, refuses payments), job
   `cancelled` (20261220), RAMS/permit terminal integrity (20261031-37),
   variation-request forward-only lifecycle (20261221), AI-employee
   `retired` (20261222). `blueprint_markup` and `internal_notes` carry
   literal `deleted_at`/archive columns because their records are personal
   drafts with no downstream ledger.
2. **ON DELETE RESTRICT for referenced masters.** A customer/supplier with
   history cannot be deleted at all (the FK refuses); deletion succeeds only
   for a record nothing references — which is exactly the case where a
   tombstone would preserve nothing.
3. **GDPR erasure as the real destroy path.** When data must actually go
   (Art. 17), the erasure engine (lib/gdpr/erase-tables.ts) applies the
   reviewed anonymise / retain / hard-delete census — a deliberate,
   audited destruction, not a row-level `deleted_at` that quietly keeps PII
   forever.

## Decision

"Soft delete where appropriate" is satisfied by the policy above. We do NOT
add `deleted_at` columns platform-wide.

## Rationale

A universal soft-delete flag is the worst of both worlds here: every query
on every table must remember the filter (one miss resurrects "deleted" data
— a whole defect class this codebase currently cannot have), while GDPR
erasure still needs the real-destroy census anyway because a tombstoned row
retains the personal data. Terminal states keep the audit trail with the
semantics stated (`void`, `cancelled`, `retired` say WHY the record left the
working set, which `deleted_at` never does); RESTRICT protects referential
history; erasure destroys deliberately.

## Consequences

- A new business record type chooses at design time: terminal state (has
  ledger/audit meaning), RESTRICT-protected master (referenced by others),
  or plain deletable (leaf data) — and its GDPR census entry in the same PR.
- Restoring a "deleted" business record means reversing a state transition
  where the lifecycle admits it, never un-tombstoning.
- The roadmap atom R135 is classified A under this recorded policy.
