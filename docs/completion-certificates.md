# Completion certificates (Phase 7)

A **Practical Completion Certificate** — the formal record that a job reached
Practical Completion — issued by the contractor, frozen forever after, and
delivered to the customer's portal as a PDF. Migration `20261014`.

Reuses the **site_reports pattern** (immutable content + write-once snapshot,
portal publish/withdraw, react-pdf) as a **sibling table** — exactly as
`purchase_orders` reused the `quotes` pattern. It is not a site-report type: a
cert is a point-in-time contractual instrument (one final per job), not a
periodic progress report.

## Model (`completion_certificates`)

- Per-org `CERT-NNNN` (`next_certificate_number`, mirrors `next_po_number`) with
  `unique (org_id, certificate_number)` — a contractual number can't collide.
- `status`: `draft → issued → superseded → archived`.
- `content` jsonb (editable draft) + `snapshot` jsonb (**write-once** at issue).
- Its **own `completion_date`** — deliberately *not* coupled to
  `jobs.practical_completion_date` (which lives on a separate branch), so the
  migration is self-contained and the snapshot freezes its own date.
- Portal columns (`portal_published_at/by`, `portal_withdrawn_at`) sit **outside**
  the immutability trigger, so publish/withdraw never touch the frozen record.

### DB-enforced invariants (real-Postgres tested)

- **Immutability** (`tg_completion_certificates_immutable`): once issued, the
  `snapshot`, `content`, `completion_date` and `certificate_number` are frozen —
  blocked for **every** role including `service_role`. (The frozen anchors are
  the `20261007` accepted-quote-freeze lesson applied here.)
- **One live per job**: `unique (job_id) where status = 'issued'` — historical
  superseded certs are kept; at most one live issued cert per job.
- **Tenant isolation**: org-scoped RLS; a non-member reads zero rows.

## Flow

1. On a **completed** job, the completed-job card links to
   `/jobs/[id]/certificate`. An owner/admin fills a customer-facing draft (works
   completed, defects-liability months, handover/retention notes).
2. **Issue** freezes a **customer-safe snapshot** — built by a pure function that
   only accepts safe inputs, so cost/margin/internal notes/staff emails *cannot*
   be embedded (a unit test asserts the snapshot's exact key set).
3. **Publish to portal** makes it visible in the customer's **Documents** library;
   **Withdraw** hides it again without unfreezing the record.

## PDF

`lib/pdf/completion-certificate-pdf.tsx` (a sibling of the site-report PDF,
reusing its StyleSheet vocabulary; a11y-conscious font sizes, real `<Text>` runs).
Operator route `/api/completion-certificates/[id]/pdf` (RLS-gated; renders from
the frozen snapshot when issued, a live preview when draft). Portal route
`/customer-portal/[token]/certificates/[id]/pdf` — token authority + scoped
loader; renders from the frozen snapshot only.

## Security

- All operator writes are **owner/admin-only** (app check + the tenant client's
  org-scoped RLS).
- The portal loader (`_certificates.ts`) runs on the admin client but scopes
  every read by **customer_id AND org_id** and re-checks `isPortalVisible`
  (issued + published + not withdrawn); a wrong/guessed id 404s identically — no
  enumeration.
- The published snapshot is **customer-safe by construction** — no internal
  commercial data can leak (structural, test-asserted).

## Tests

- **Unit (10):** state machine, content schema, snapshot builder + the
  customer-safe key-set guard, and a real `%PDF-` render.
- **Integration (5, real Postgres):** immutability incl. `service_role`, frozen
  anchors, one-live-per-job, portal publish/withdraw allowed, tenant isolation.
- **Security (3):** the portal loader + PDF routes scope + render from snapshot.
- **E2E:** the portal cert PDF 404s for an unknown token + guessed id.

## Deferred (documented fast-follows)

Customer counter-signature / e-sign · warranty tracking + reminders (the cert can
already display a derived defects-liability end date) · bulk/multi-unit issue ·
templates & custom clauses · auto retention-release on the completion date. When
retention-scheduling (`jobs.practical_completion_date`) merges, the issue flow
can pre-fill `completion_date` from the job.
