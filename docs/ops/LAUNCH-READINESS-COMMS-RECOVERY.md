# Launch readiness — Communications + Recovery

Consolidation of PR #983 (Resend/Sentry coverage) and PR #985 (backups/DR), with
two additive guards added. **Unit tier only** — no live provider was contacted,
no email sent, no production connection made, no secret printed or committed.

Scope: transactional email (Resend), error monitoring (Sentry), auth email
deliverability (Supabase Auth SMTP), and off-platform backup / DR freshness.

- Companion DR detail: [`BACKUP-RECOVERY-STATUS.md`](./BACKUP-RECOVERY-STATUS.md)
- Verification date: 2026-10-30 · consolidated on branch `ops/comms-recovery-launch-readiness`

---

## Test evidence

Consolidated comms + recovery unit suites: **307 passing across 27 files**
(`vitest run __tests__/email __tests__/ops __tests__/monitoring __tests__/comms`).

| Area | Suite | Count |
|---|---|---|
| Resend transport (`lib/email/send.ts`, mocked SDK) | `email/send-wrapper.test.ts` | 15 (PR #983) |
| Real `sendInvoiceEmail`/`sendQuoteEmail` | `email/transactional-send.test.ts` | PR #983 |
| Subject/body builders + HTML-escape injection | `email/transactional-templates.test.ts` | 10 (PR #983) |
| Resend webhook HMAC/Svix signature + replay | `comms/resend-events.test.ts` | 13 |
| Bounce/complaint classification + idempotency + suppression | `comms/resend-events-handler.test.ts` | 9 |
| Sentry `beforeSend` PII/secret scrub | `monitoring/scrub.test.ts` | 9 |
| **Sentry scrub fail-closed (NEW)** | `monitoring/scrub-fail-closed.test.ts` | **3** |
| Monitoring readiness / config wiring | `monitoring/readiness.test.ts`, `monitoring/sentry-config-wiring.test.ts` | 13 |
| Backup freshness classifier (GREEN/AMBER/RED) | `ops/backup-health-freshness.test.ts` | 15 (PR #985) |
| **Auth email isolation — not via Resend (NEW)** | `email/auth-email-isolation.test.ts` | **2** |

PR #983 = 36 new; PR #985 = 15 new; this consolidation = **5 additional** (two gap files).

---

## VERIFIED (no live key / no CEO action needed)

**Email — outbound transport (`lib/email/send.ts`)**
- Correct dispatch shape: `from`/`replyTo` env defaults + per-send overrides;
  `Uint8Array`→`Buffer` attachment; array recipients.
- Failure is **classified and surfaced, never silently dropped**: `no_key`,
  `self_loop`, and `error` (provider `res.error`, missing id, SDK throw,
  non-Error throw) all return a typed `{ sent: false, reason }` — the helper
  never throws out, so a transient email failure cannot 500 the caller's route.
- Self-loop guard (From == To) catches the top Gmail/Workspace silent-drop cause.

**Email — transactional (real `sendInvoiceEmail` / `sendQuoteEmail`)**
- Recipient resolution (own customer / `options.to` / quote fallback / missing /
  invalid); real subject + `<number>.pdf` attachment reach the wire.
- **Void invoice is never emailed.** Transport failure → `send_failed` with
  **no status flip**; `draft`→`sent` only after a successful send; reminders
  never rewrite status.
- Untrusted customer name + free-text message are HTML-escaped (injection-safe).

**Email — auth deliverability path (NEW guard)**
- Magic-link + password-reset go through **Supabase Auth** (`signInWithOtp` /
  `resetPasswordForEmail`) via Supabase's own SMTP — **not** Resend. The new
  source guard fails loudly if an auth path is ever re-routed through
  `lib/email/send.ts`, which would silently couple login deliverability to the
  Resend key + domain. See config dependency below.

**Monitoring — Sentry scrub**
- `beforeSend`/`beforeSendTransaction` = `scrubEvent` on all three
  `sentry.*.config.ts`; `sendDefaultPii: false`.
- Redacts Authorization/cookie/api-key headers, cookie strings, sensitive query
  params (incl. in transaction span URLs), nested request-body/extra/contexts
  secrets, and strips user PII to a bare id.
- **Fails CLOSED (NEW guard):** if redaction itself throws, `scrubEvent` returns
  `null` so the SDK drops the event rather than shipping un-scrubbed context;
  a clean error still passes through (never over-drops).

**Recovery — backup freshness classifier (`classifyBackupHealth`)**
- Pure, injectable-clock GREEN/AMBER/RED decision pinned at every boundary
  (7d/10d/6h). Ordering invariants hold: a newer `running` row does **not** mask
  an older failure; classifier fails toward red/amber, **never false-green**;
  `readBackupHealth` fails to amber on an unreadable table.

---

## NEEDS A LIVE KEY OR CEO ACTION (not verifiable by unit tests)

Each item is a config/operational step; the code behind it is unit-proven above.

1. **Resend outbound — live key + verified domain.** `RESEND_API_KEY` is unset
   everywhere today, so `sendEmail` returns `no_key` and no quote/invoice/
   reminder actually leaves the product. Action: set a restricted
   `RESEND_API_KEY` and verify the `crewflow.uk` sender domain (SPF/DKIM) in
   Resend.
2. **Resend delivery-events webhook is DARK (two-switch).** Needs BOTH
   `NEXT_PUBLIC_FEATURE_RESEND_EVENTS=true` AND `RESEND_WEBHOOK_SECRET`; while
   dark every request 404s before touching data. End-to-end bounce/open/click
   attribution is unverifiable until the webhook endpoint + signing secret are
   configured. Signature + classification logic is unit-proven.
3. **Auth (magic-link / reset) deliverability = Supabase Auth SMTP config.**
   Deliverability depends on the Supabase **Auth → SMTP** dashboard settings,
   not this codebase. This is the outstanding founder/CEO step and no unit test
   can prove the actual send.
4. **Sentry is integrated but DARK — no DSN.** `SENTRY_DSN` /
   `NEXT_PUBLIC_SENTRY_DSN` unset ⇒ `monitoringEnabled` false everywhere ⇒
   nothing captured. Action: set the DSN in Vercel (release tagging uses
   `VERCEL_GIT_COMMIT_SHA`, injected by Vercel). Capture + release tagging +
   source-map upload are unverifiable without a live DSN.
5. **PITR is OFF.** RPO ~24h (off-platform cadence) vs ~2min with PITR; ~$100/mo;
   CEO-deferred until paying customers. Decision pending.
6. **Backup monitoring is pull-only — no push alert on stale/failed backup.**
   `/admin/ops` shows GREEN/AMBER/RED but nothing pages an operator if it goes
   RED unseen. Biggest reliability gain for low/zero cost.
7. **Backup operational confirmations** (from #985): confirm the backup is
   actually running (`/admin/ops`), confirm encryption-key custody (`backup.key`
   in the vault), re-rehearse restore on a cadence (fresh project incl. the
   post-2026-10-30 Data-API re-grant).

---

## Ordered external-action list

1. Confirm the off-platform backup is actually running — `/admin/ops`. *(zero cost, do first)*
2. Confirm encryption-key custody — `backup.key` in the vault. *(zero cost)*
3. **Add a push alert on stale/failed backup** — today it is pull-only. *(biggest reliability gain, low/zero cost)*
4. Set `RESEND_API_KEY` (restricted) + verify the `crewflow.uk` sender domain (SPF/DKIM) — unblocks all transactional email.
5. Configure Supabase **Auth → SMTP** — unblocks magic-link / password-reset deliverability.
6. Set `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` in Vercel — turns on error monitoring.
7. Enable the Resend delivery-events webhook — `NEXT_PUBLIC_FEATURE_RESEND_EVENTS=true` + `RESEND_WEBHOOK_SECRET` + endpoint — for bounce/open/click attribution.
8. Decide PITR (RPO ~24h → ~2min; ~$100/mo; currently deferred).
9. Re-rehearse restore on a cadence; shorten off-platform cadence / move the executor off the laptop.
