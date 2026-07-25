# Toolbox Talks — evidence-grade on-site safety briefings

Toolbox Talks evolve the pre-existing `toolbox_talks` log (migration `20260921`) into
acknowledgeable, revisable H&S evidence — **in place**. There is no parallel domain and
`/toolbox` is unchanged as the entry point.

## Lifecycle

```
draft ──issue──▶ issued ("Delivered") ──▶ superseded | withdrawn
```

- **draft** — freely editable; captured on a phone mid-site. No reference.
- **issued** — frozen evidence, allocated `TBT-NNNN`, snapshot written. Presented as
  "Delivered" (construction-natural); the DB status stays `issued`.
- **superseded** — a newer revision was delivered (historical, immutable).
- **withdrawn** — retracted but retained (evidence is never destroyed).

The pure lib `lib/health-safety/toolbox-talks.ts` is the single source of truth for the
UI (status labels, `canIssue`, `canTransition`, reference/revision helpers); the DB
re-enforces every rule so a forged client write is refused.

## Database invariants (migrations 20261025–28)

| Invariant | Mechanism |
|---|---|
| Born a draft | `tg_tt_a_lifecycle` blocks a born-issued INSERT (service role too) |
| Issue-gate (topic + key points) | `tg_tt_a_lifecycle` (JWT path); mirrored by `canIssue` |
| Provenance pinned | `issued_by = auth.uid()`, `issued_at = now()` on issue |
| Immutable on issue | `tg_tt_m_immutable` freezes content/links/lineage/provenance + write-once snapshot; forward-only status |
| Same-org links | `tg_tt_validate_links` (job/RAMS/permit) — trigger, not a cascade FK |
| Per-org numbering | `next_tbt_number` (membership-gated; revisions never advance the series) |
| One current + one draft / series | partial unique indexes on `root_toolbox_talk_id` |
| Revision lineage | `tg_tt_revision_integrity` (self-root, same-series, no self-supersede) |
| Delivered evidence non-deletable | `tg_tt_block_delete_when_issued` (trigger) + draft-only delete RLS |
| Atomic revision issue | `issue_toolbox_talk_revision(uuid, jsonb)` — supersede + promote + freeze snapshot in one txn |
| Attachment evidence append-only | `tg_tenant_attachment_freeze_delivered_toolbox` — delivered talks' attachments can't be deleted/repointed |

Every `SECURITY DEFINER` pins `search_path = public`.

## Acknowledgement engine (M2) — reuse, not fork

Toolbox talks are a third `subject_type` on the shared `safety_acknowledgements`
engine (`20261026`), alongside `risk_assessment` and `permit_to_work`. The generic
guarantees apply unchanged: org derived from the subject (anti-spoof), membership-first,
signer bound to `auth.uid()`, timestamp pinned, version-anchored to the `TBT` reference,
one-ack-per-(version, user), append-only, non-erasable. Only an **issued (current)** talk
is acknowledgeable — a draft/superseded/withdrawn talk is not.

### Attendance ≠ authenticated acknowledgement (the honesty rule)

- **Tier A — CrewFlow-authenticated acknowledgements.** The `SignoffPanel` denominator
  is the operatives **rota'd to the talk's job** (`requiredOperatives` → `rota_entries`).
  When no crew is derivable the panel reads **"Not tracked"** — we never invent an
  N-of-M obligation.
- **Tier B — recorded attendance.** Free-text names + a photographed sign-off sheet
  (`tenant_attachments`). Shown in a **separate** section and on the PDF as
  "Recorded attendees (manual record) — not platform-authenticated". Tier B **never**
  counts toward the N-of-M or is presented as a CrewFlow signature.

## Revisions + re-acknowledgement (M3)

A revision is a new draft copied from the current issued talk. Delivering it atomically
supersedes the prior revision and freezes a fresh snapshot. Because each revision is its
own row with its own ack `subject_version`, **zero acknowledgements carry forward** —
the crew must re-acknowledge, and the `SignoffPanel` shows the "you signed Rev N, please
re-acknowledge" prompt (`priorRevisionSignoff`, generalised over any revisable subject).

## Evidence snapshot + PDF (M4)

`buildToolboxTalkSnapshot` is a worker-safe **explicit allowlist** (identity, briefing,
PPE, point-in-time RAMS/permit **references as strings**, issue stamps). No FK, no
cost/rate/margin/PII path. Written once at issue and frozen by the DB. The PDF
(`GET /api/health-safety/toolbox-talks/[id]/pdf`) renders the **document body from the
frozen snapshot** (a later RAMS revision or permit expiry never rewrites history) and the
**acknowledgement roster live**. Draft or no-snapshot → `409`; `private, no-store`;
labelled with the subject's own org.

## Operational intelligence (M6)

- **Job Safety hub** (`jobs/[id]`) shows the job's toolbox talks beside RAMS + permits.
- **Dashboard signal** `toolboxAwaitingAck` — delivered talks whose job crew hasn't
  fully acknowledged (reuses `summariseSignoff`; bounded + no N+1). Warn-tone, links to
  `/toolbox`, only when non-zero.

## Poor connectivity (§17)

Acknowledgement is an **online** server action; the PWA architecture is untouched (no new
offline write path — an unproven sync engine is explicitly out of scope). Submission is
**idempotent**: the `(org, subject_type, subject_id, subject_version, user_id)` unique
constraint means a retry after a flaky connection yields `23505`, which the action treats
as success — no duplicate acknowledgement after reconnect. A talk's read content is served
by the normal app shell; there is no offline-read guarantee for a talk beyond what the PWA
already caches.

## Performance (§18)

- Registers/hubs use **bounded** reads (`limit`) and `Promise.all` for independent
  queries; the dashboard awaiting-ack signal is **three batched reads diffed in JS**
  (no N+1), mirroring the existing active-jobs-without-RAMS cross-reference.
- Indexes: `toolbox_talks` carries series/status/RA/permit indexes (`20261025`);
  acknowledgements are indexed by subject and user (`20261020`).
- No new realtime, polling, cron, AI calls, providers, or duplicated evidence blobs —
  **cost-neutral**.

## Templates (§14) — deferred, with evidence

A template library's value is pre-filled H&S wording, which must **not** be shipped as
fabricated "compliant"/authoritative content. It would add a table + RLS + CRUD vertical
that materially expands this wave without a roadmap or evidence-integrity driver. The
create-draft form is the clean seam to add "create from template" in a later wave.

## Status

Built on `feat/health-safety-toolbox-talks`, migrations `20261025`–`20261028`.
**Unmerged, undeployed** — production remains `73ba21f`.
