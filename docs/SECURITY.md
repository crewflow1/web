# CrewFlow security & compliance — Phase 7 baseline

This document is the contract every PR should preserve. If a change
breaks one of these properties, the test in
`__tests__/security/phase7.test.ts` should fail loudly.

## Authentication & authorisation

| Surface | Gate |
|---|---|
| `app/(app)/**` (tenant) | `requireOrgContext()` — user JWT + active membership. Layout 307s anon → `/login`. |
| `app/admin/**` (HQ) | `requireUser()` + `isSuperAdminEmail()` + `notFound()` for non-allowlist. Defence in depth at every action. |
| `app/api/cron/**` | `isCronAuthorised(request)` (Bearer `CRON_SECRET`). 401 otherwise. |
| `app/api/ai/question` | `requireOrgContext()` + rate limit. |
| `app/api/demo` | Public + rate limit + zod validation. |
| `app/api/webhooks/stripe` | Signature verification (`stripe-signature`). |
| `app/customer-portal/[token]/**` | Token IS the auth surface. Loader (`loadCustomerByPortalToken`) validates UUID shape + DB lookup; service-role queries are then scoped by `org_id AND customer_id`. |

## RLS contract

Every tenant table uses these helper functions:

- `public.current_org_ids()` — `memberships ∪ active impersonation_sessions` (24h cap)
- `public.is_org_admin(uuid)` — owner/admin role OR active impersonation

Both are `SECURITY DEFINER` so they read past `impersonation_sessions`'s
no-policy RLS. Tables with sensitive HQ-only data (`admin_alert_state`,
`cron_runs`, `automation_runs`, `hq_settings`, `portal_uploads`) enable
RLS with **no policies** — service-role access only.

## Audit logging

Every sensitive action writes to `public.admin_activity_log` via
`recordAdminActivity()`. Coverage:

- approve / suspend / cancel / reactivate (lifecycle)
- impersonation start / end / force-end (with 24h SQL-side cap)
- import commit / rollback
- quote accept / decline (HQ-side review)
- invoice status change
- payment recorded
- support reply
- settings change (with before/after diff)
- user invite / remove
- portal message sent / portal upload (customer-side audit)
- recovery actions (resetOnboarding / markSetupComplete / resendInvite)
- milestone notifications

## Cron + ops telemetry

Every cron route wraps its payload in `withCronTelemetry()` which:
- captures start/end stamps + duration_ms
- catches uncaught errors, returns `{ok:false, error}` with status 500
- inserts a row in `cron_runs` with success/failure + truncated stack
- **never throws** out of the cron route

The `/admin/ops` dashboard renders this telemetry as a traffic-light
status (RED on missing required env, AMBER on recent failures, GREEN
otherwise).

## Rate limiting

In-memory fixed-window limiter (`lib/security/rate-limit.ts`) applied to:

| Route | Limit | Window |
|---|---|---|
| `POST /api/demo` | 5 | 10 minutes |
| `POST /api/ai/question` | 20 | 1 hour |
| Portal write actions (message / upload) | 10 | 1 minute (planned) |
| Portal reads | 60 | 1 minute (planned) |

**Known limitation:** memory-only, per-Lambda. Upgrade target: Vercel
KV or Upstash Redis when traffic warrants it. The current limiter
blocks 90%+ of casual abuse; persistent attackers will hit cold-start
instances repeatedly. Mitigated by: Vercel's edge DDoS protection,
LLM provider's own rate limits (Anthropic + OpenAI), and the fact that
no rate-limited route can mutate without further auth gates.

The limiter **fails open** — a bug in this module never takes down a
route; it just stops enforcing the limit for that call.

## File safety

`portal_uploads` (the only customer-side upload surface):
- MIME whitelist: `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `image/webp`
- 10 MB size cap
- Storage bucket `portal-uploads`, RLS service-role only
- Path keyed `{org_id}/{customer_id}/{uuid}.{ext}` so HQ can audit by
  prefix; customers can never access another org's prefix
- Inserts re-verify the target invoice belongs to the customer before
  writing the storage row
- Orphan-file cleanup if the DB insert fails

`imports` (operator-side, admin-only):
- MIME whitelist: CSV / Excel / PDF / JPG / PNG / HEIC / WebP / HEIF
- 50 MB per file (existing storage policy)
- OCR confidence capped at 85% (Claude vision) so every PDF row needs
  operator review before commit

Tenant-side file uploads (job photos) use the existing tenant-RLS
storage bucket with org-scoped paths.

## Secrets

| Env var | Source | Required |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Vercel | Yes |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Yes |
| `CRON_SECRET` | Vercel | Yes (gates 5 cron routes) |
| `RESEND_API_KEY` | Vercel | Optional (email queue/demo email) |
| `CREWFLOW_INTERNAL_ORG_ID` | Vercel | Optional (gates HQ in-app bell on demo bookings) |
| `ANTHROPIC_API_KEY` | Vercel | Optional (Migration OS OCR + AI insights prose) |
| `OPENAI_API_KEY` | Vercel | Optional (AI fallback) |

Status is visible at `/admin/ops`. Presence-only (never values).

## Backup & recovery

- **Supabase**: daily Point-in-Time backups via Supabase platform.
  Recovery RPO ≈ 1 hour, RTO ≈ 30 min from the Supabase support flow.
- **Imports**: `import_audit` ledger tracks every inserted row.
  `rollbackImport()` deletes children-first using REVERSE_ORDER so an
  bad migration is fully reversible.
- **Files**: storage buckets have 30-day soft-delete (Supabase
  default).
- **Configuration**: Vercel env vars are recoverable via the Vercel
  UI history. Code state is reproducible from git.

## Impersonation

- Cookie-based (`cf_impersonation_session`), httpOnly, SameSite=Lax,
  24h.
- DB-side mirror (`impersonation_sessions` row) is the actual auth
  substrate. Cookie alone is not sufficient.
- 24h SQL-side cap (`started_at > now() - interval '24 hours'`)
  enforces revocation even if the cookie is replayed.
- `ended_at IS NULL` gate means Exit is INSTANT — no cache, no
  propagation delay.
- All start / end / force-end events audit-logged.
- The HQ-side notifications service emits a high-visibility row when
  impersonation starts so the whole HQ team sees the action.
