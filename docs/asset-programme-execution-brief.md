# Asset Management programme — shared execution brief (M4b → M5 → integration)

> **⚠ ARCHIVED — superseded by `docs/asset-management.md`.** Frozen at the M4b-1
> moment: its baseline table (attachment-CHECK "14 targets", "open asset PRs
> #376–#381 unmerged", RC2 #375, base SHA) is stale — the CHECK authority is now
> `20261002` with **15 targets** and Asset Management is in prod via RC3. Current
> state: `docs/stage-one-reconciliation.md`.

> Coordination contract for the multi-agent build of inspection templates,
> scheduling, overrides/reinspection, maintenance, and full integration.
> The lead agent owns final architecture, all shared DB objects, conflict
> prevention, security sign-off, CI classification and milestone reports.

## Verified baseline (do not re-derive)

| Fact | Value |
|---|---|
| Branch line | `feat/asset-inspection-safety` → **`feat/asset-inspection-templates`** |
| Base SHA | `adf4f6bf2fecab9be29d0e1da5af3948aa4708ae` (M4c tip, clean tree) |
| Migration tip | `20260928000000_asset_inspection_safety_block.sql` — new migrations strictly after; never reuse timestamps |
| PR base (MANDATORY) | `directive/018-r6-controlled-live-execution` — CI `pull_request` only fires for base `main`/`directive/018`. A feature-branch base silently skips all 6 gates (proven on #380). Vercel-only validation is never green. |
| Open asset PRs | #376 #377 #378 #379 #380 #381 — all 8/8 green, UNMERGED |
| RC2 | PR #375 — `READY — UNMERGED — UNDEPLOYED`, frozen; no production claims |

## PR dependency order

1. **M4b-1 templates & versioning** (this PR) — `20260929` templates table + inspection linkage
2. **M4b-2 schedules & due-generation claims** — `20260930+`; depends on templates
3. **M4d overrides + reinspection lineage** — extends the custody guard (lead-only file)
4. **M4 UX completion + dedicated E2E**
5. **M5a maintenance cases + state machine**
6. **M5b preventive service + scheduler claims**
7. **M5c repair → reinspection → return-to-service**
8. **M5 UX + E2E**, then **full integration & hardening**

## Ownership (conflict prevention)

**Lead-agent-only (serialized; no other agent may touch):**
- every `supabase/migrations/*` file
- `tg_asset_assignments_guard` (custody guard), `tg_asset_inspections_immutable`,
  all snapshot/immutability triggers, all RLS policies
- the `tenant_attachments.target_table` CHECK (inspect-then-extend only; current
  authority = `20260927`, 14 targets)
- state-machine modules (`lib/assets/inspection.ts`, `inspection-template.ts`,
  future `maintenance.ts`), scheduler claim model, permission boundaries

**Parallel workstreams (research/design only, no repo writes):**
- infra-reuse discovery (scheduler/cron, claims, notifications, permissions, audit)
- construction-domain review (UK inspection workflows, wording, evidence)
- M4d override threat model + M5 maintenance design (DDL sketch + transition matrix,
  reviewed by lead before any implementation)
- performance / accessibility / E2E planning (attach findings to milestone reports)

## Fixed domain decisions (M4b-1)

- Template = **one row per version**: `family_id` groups versions; `definition`
  jsonb `{sections:[{key,title,items:[…]}]}` — the smallest durable model, not a
  generic form builder. Bounded by zod (sections/items caps).
- Lifecycle `draft → published → superseded → archived` (+ `draft → archived`);
  app validates transitions (house pattern), the **DB freezes substance**:
  definition/name/categories immutable once non-draft; publish requires a
  non-empty definition; **one published version per family** (partial unique
  index); atomic publish+supersede via a SECURITY INVOKER RPC.
- Inspections carry `template_id` / `template_version` / **`template_snapshot`**
  (frozen copy at start, **write-once at the DB**) — an active inspection keeps
  its version even after later publishes; deleting a template never destroys
  evidence (`on delete set null`; snapshot survives).
- Outcome derivation (pure, unit-tested): failed **safety-critical** item →
  `fail` + `safety_critical=true` (M4c block engages unchanged); only
  non-critical failures → `pass_with_defects`; else `pass`. Required-unanswered
  blocks issue (validation), never auto-fails.
- Item model: `response_type` ∈ pass_fail · yes_no · text · number ·
  meter_reading · choice · acknowledgement; `required`, `safety_critical`
  (block-use rule), `severity` (minor/major for non-critical defects), fail
  rules per type, `requires_photo` / `requires_comment_on_fail` /
  `requires_signature` flags (signature *capture* lands with M4-UX; the model
  carries the flag now).

## Known risks & stop conditions

- Guard/trigger replacements must reproduce prior checks verbatim and keep the
  existing regression suites green (M4c precedent).
- `next build` is a gate typecheck cannot substitute (node:crypto precedent) —
  no server-only imports in client-reachable modules.
- Scheduling (M4b-2) must reuse the existing cron/claim infrastructure —
  discovery agent maps it before any scheduler code is written.
- Stop only for: product fork, irreversible migration, architecture-changing
  decision, missing external credential with no parallel work, confirmed
  security break, programme completion, or a genuine context boundary (with a
  full structured handoff). Green PRs are not stop conditions.

## Expected outputs per increment

Migration(s) applied to real Postgres in CI · pure domain module with unit
tests · tenant-scoped audited actions · UI in the house design system ·
real-Postgres integration proof · docs updated (`docs/asset-management.md`) ·
all 6 GH gates + Vercel green on a `directive/018`-based PR · exact
test-execution lines quoted from CI logs · PR left unmerged.
