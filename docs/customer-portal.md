# Customer Portal — architecture & completion

> The customer's single place to understand their commercial relationship with
> the contractor. Public (no JWT); the URL token is the credential. Additive,
> reuses the existing token/read/attachment infrastructure — no second auth,
> no second file store.

## Access model (reuse — never re-implement)

- **Single authority:** `loadCustomerByPortalToken(token)`
  (`app/customer-portal/_helpers.ts`). Every page/route/action resolves the
  token here and treats `null` → `<InvalidLinkPage kind="portal" />`. No
  downstream re-check of expiry/ownership (the single-authority invariant the
  security tests pin).
- **Token shape:** RFC-4122 v4 UUID; `isValidPortalTokenShape` /
  `generateCustomerPortalToken` (`lib/customers/portal-token.ts`). Shape-checked
  before any DB hit.
- **Expiry:** `customers.portal_token_expires_at` (NULL = never;
  `20260914000000`). Enforced only in the loader; `portal_token_last_used_at`
  is debounced telemetry, never authority.
- **Revoke = rotate:** `rotateCustomerPortalToken(id)` mints a fresh token and
  clears expiry/usage — the old link dies immediately.
- **Read scoping:** service-role admin client (RLS bypassed) → **every query
  filters `org_id` AND `customer_id`** (the token-resolved identity). Invoices
  anchor on their own `customer_id` (not via `quote_id`). Middleware
  allow-lists `/customer-portal/` as public.

## Shell & navigation

`PortalShell` (`app/customer-portal/[token]/_shell.tsx`) — org branding, the
customer's name, a "Call {org}" action, and a tab nav (Overview · Quotes ·
Invoices · Jobs · **Reports** · Messages). Every portal page renders inside it,
so the customer never lands on an orphaned layout. (The Reports pages were
migrated onto the shell in the action-centre slice — they previously rendered a
bespoke layout and `notFound()` instead of the friendly invalid-link page.)

## Document library (`/documents`)

`buildDocumentLibrary` (`lib/customers/portal-documents.ts`, pure + unit-tested)
aggregates the customer's quotes, invoices and progress reports into one
date-sorted, type-filterable library — each linking to its secure PDF route
(`/q/<token>/pdf`, the portal invoice/report PDF routes). Only document types
that already carry an explicit visibility gate are included; arbitrary job
attachments are never surfaced.

## Action centre (overview)

`buildPortalActionItems` (`lib/customers/portal-actions.ts`, pure + unit-tested)
turns the data the overview already loads into a precise, ordered "Needs your
attention" list. Priority: **overdue payments → quotes awaiting a response
(soonest expiry first) → payments coming due → report decisions.** Every item
carries a precise, financially-explicit label ("Payment of £5,000.00 is
overdue — invoice INV-0001", "Review and respond — £2,400.00 quote Q-0001"),
its consequence/deadline, and a deep link to the **existing single-authority
surface** — `/q/<public_token>` for quote decisions (which already runs the
full accept → job → draft-invoice flow), the invoice tab otherwise. No new
approval path is introduced. Only quotes the portal already surfaces
(sent/viewed with a public token) are actionable; drafts and internal states
never appear.

## What each tab shows (existing)

Overview (KPIs + action centre + latest quote/invoice) · Quotes (cleared-gate
statuses only; decisions on `/q/`) · Invoices (paid/outstanding/overdue +
payment-proof upload; no online pay yet) · Jobs (status/date/tech — internal
notes/AI-summary deliberately omitted) · Reports (published, non-withdrawn
issued/superseded frozen snapshots) · Messages (this customer's threads only).

## Security proofs (existing, real-Postgres + source)

`portal-token-expiry-authority` · `token-expiry` (real-PG loader) ·
`portal-invoices-scope` · `portal-job-internal-data` ·
`portal-tickets-customer-scope` · `portal-message-org-attribution` ·
`site-reports-portal` (real-PG). Boundary E2E added this slice
(`e2e/portal.spec.ts`): every portal surface with an unknown token shows the
invalid-link page and never paints customer data or the action centre.

## Known limitations / next slices

- **Document library** — shipped (`/documents`, `lib/customers/portal-documents.ts`):
  one date-sorted, type-filterable library of the PDF-backed commercial
  documents (quotes/invoices/reports), each loaded with the SAME scoped read
  its own tab uses. Deliberately excludes arbitrary `tenant_attachments`
  (no portal-visibility flag exists → including them would risk leaking
  internal docs). Report-**decision** surfacing in the action centre + a
  customer-upload surface are the remaining document follow-ups.
- **Job switcher** — the portal is flat per-customer; a per-job context lands
  with the commercial-integration slice (once variations attach to jobs).
- **End-customer notifications** — `emitNotifications` audience "customer"
  means the *tenant org*, not the end customer; there is no end-customer email
  channel yet beyond the quote email. `publishToPortal` notifies nobody today —
  delivering "a report/decision needs you" to the customer needs new email
  plumbing (reuse `lib/email/send-quote.ts`/Resend), tracked.
- **Online payment** — bank-transfer + proof only; a pay button is deferred.
- **Authenticated portal E2E** — needs a seeded `portal_token` harness (the
  same passwordless-harness gap tracked elsewhere); per-customer isolation is
  proven at the integration tier meanwhile.
