# First Customer Support — founder runbook

Escalation ladder: **L1** CrewFlow UI/HQ → **L2** provider dashboard (Supabase / Resend / Vercel / Sentry) → **L3** engineering session → **L4** direct DB (last resort; log what you did). Every scenario below was path-verified on build `c469e7fd`. None of the routine ten needs SQL.

## The ten common tickets

| Ticket | Path | Typical time |
|---|---|---|
| **"I can't log in"** | L1: HQ → Customers → org — status pill (suspended/pending/cancelled all bounce to /access-pending; reactivate is on that page) + last-login tile. Recovery actions → **Resend invite**. L2 if needed: Supabase → Auth → user (exists? confirmed? banned?). | 5–10 min |
| **"I forgot my password"** | L1: point at /login → "Forgot your password?" (also magic link or Google). Auth email now rides Resend SMTP (verified 2026-08-29). L2: Supabase Auth logs + Resend log if it doesn't arrive. | 5 min |
| **"Worker can't see today's job"** | L1: check the worker has a **rota entry today** (Staff → Rota) — Today's rota on My Day is the worker's main pointer; also check job `assigned_to` + status ≠ cancelled and membership exists. Known quirk: the "My jobs" panel currently always shows empty (P2, fix queued) — rota + Jobs tab are the working paths. | 10 min |
| **"I sent the wrong invoice"** | L1: invoice page → **Void this invoice** (reason required; keeps history, drops it from what's owed everywhere — verified live). Re-raise the correct one. If any payment is recorded, void is refused by design — record-keeping says raise a credit/correction manually and get engineering advice. Warn the customer already holds the wrong PDF. | 5 min |
| **"My quote isn't showing"** | L1: /quotes status filter (draft vs sent vs accepted); check `sent_at`. If the CUSTOMER can't see it: re-send, and test the public `/q/{token}` link yourself. | 10 min |
| **"Why can't my employee see invoices?"** | Working as designed — Money/Sales are owner-admin only (server-enforced, not just hidden). Either promote them to admin or explain the boundary. | 2 min |
| **"The RAMS link isn't working"** | L1: Site & safety → Worker links — the token list shows expired/revoked; revoke + issue a fresh link (old links show a clean invalid-link page, no data). | 10 min |
| **"I accidentally cancelled this job"** | L1: job page → set status back — reopen goes to **New** (only cancelled→new is allowed; completed jobs can't be cancelled at all). History/finances/safety all survive cancellation — verified. | 5 min |
| **"My customer didn't get the email"** | L1: re-send from the invoice/quote page (failures show inline). L2 (delivery truth): **Resend dashboard → Logs** — invoice/quote sends go direct to Resend, so bounce/spam/quota lives there, not in-app. Check their spam folder; sender is hello@/auth@crewflow.uk. | 10–15 min |
| **"My totals look wrong"** | L1: explain the model — Reports revenue counts **paid** invoices; voided invoices count nowhere; VAT (cash scheme) follows payments not invoices; ageing ≠ cash position. Walk /reports vs /invoices filters together. L4 only if still divergent (forensic cross-foot). | 15–30 min |

## What still needs which tool (honest map)

- **HQ handles:** org/user lookup, status + reactivation, resend invite, impersonation (reason required, 24 h cap, fully audited, red banner, exit button), alerts/decisions, email-queue stats, ops traffic-light.
- **Provider dashboards needed for:** true email delivery status (Resend logs); Auth/SMTP config + auth logs (Supabase); deploy rollback (Vercel → previous deployment → instant rollback); error detail (Sentry — no in-app link yet, bookmark it).
- **SQL still required for (rare):** requeueing a permanently-failed queue email; listing a customer's non-owner users without impersonating; forensic totals reconciliation. Nothing on the routine list.
- **Engineering required for:** anything touching a paid invoice that needs reversing (no credit notes yet), restoring hard-deleted records (customer delete is FK-protected but final), schema-level surprises.

## Incident runbook

**1. CrewFlow down.** `curl https://crewflow.uk/api/health`. `ok:true` → partial: check Sentry for the failing route. Deployment bad → Vercel → Deployments → previous good → **Instant Rollback** (safe: app stateless, migrations additive — never roll back a migration, always fix forward). `db` not ok → next item.

**2. Supabase down / DB unreachable.** First check the dashboard for project `jzntbskdqdopzwdqwvkp` — a **paused project presents as DNS NXDOMAIN** (exactly the 25 Aug incident). Resume/restore, wait for healthy, re-check `/api/health`; the app recovers by itself. Otherwise status.supabase.com. Nothing to do on Vercel.

**3. Email down.** Two independent systems. *App mail* (quotes/invoices/notifications): Resend dashboard → Logs; `/admin/ops` email panel for the digest queue. *Auth mail* (login links/resets): Supabase → Auth → SMTP (Resend SMTP, port 587 — 465 breaks it; that was the 29 Aug lesson) + Auth logs.

**4. Customer locked out.** HQ customer page: status, last login, resend invite; reset flow for passwords; Supabase Auth for the account itself; impersonate to see what they see.

**5. Accidental data issue.** Scoped mistake → in-app tools: invoice **void**, job **cancel/reopen**, import **rollback**. Large/destructive → STOP, note the exact UTC time, and treat PITR as the nuclear option: a restore is **project-wide and destructive** (all tenants lose everything after the restore point) — with more than one customer live, prefer surgical repair with engineering. PITR steps: docs/backup-recovery-runbook.md.

**6. Failed deployment.** Vercel instant rollback (seconds). Migration failed mid-apply: stop, don't ship the app, decide fix-forward vs restore with engineering.

## Database incident — evidence-backed drill record (2026-08-29)

**CREWFLOW DATABASE INCIDENT procedure:** 1) detect (`/api/health` db flag, Sentry, customer report) → 2) assess scope (single record vs corruption vs loss) → 3) freeze writes if corruption is spreading (Vercel: pause deploy/enable maintenance; worst case suspend the org in HQ) → 4) identify the safe restore point (**note the exact UTC time of the bad event immediately**) → 5) preserve forensics (screenshot, export affected rows via GDPR ZIP/CSVs before any restore) → 6) restore (scoped: in-app void/cancel/import-rollback; full: Supabase dashboard → Backups — **daily physical backup today; restore is project-wide and destructive**) → 7) validate restored env (migration tip `20261220…`, RLS/trigger counts, spot-check org/jobs/invoices, `/api/health`) → 8) no DNS/app cutover needed (app is stateless; Vercel instant-rollback covers app-layer) → 9) customer comms: what window is lost (RPO), when service resumed → 10) post-incident: re-run integrity checks, write up, fix the cause.

**What is PROVEN (drill, 2026-08-29):** schema + security controls + app-layer recovery — full replay of all 380 migrations onto a clean database took **26 seconds** and restored 307 RLS-enabled tables, 605 policies, 461 triggers (incl. all append-only/immutability and void/cancel guards), 758 FKs, 1477 indexes; a realistic company re-loaded and the live app rendered it (worker login + My Day verified post-restore).
**Numbers we can honestly state:** schema-restore RTO ≈ 30 s · app redeploy RTO ≈ 5 min · **data RPO today ≤ 24 h** (daily physical backup; WAL archiving verified healthy, 0 failures) · with PITR enabled RPO ≈ 2 min · **data-restore RTO: not yet measured** (dashboard operation; rehearse when the actions below land). No other SLA is promised.

## Pre-customer #1 operational checklist

- [ ] **Enable the PITR add-on** — verified 2026-08-29 via management API: **PITR is currently OFF** (WAL-G on). Supabase dashboard → Database → Backups/Add-ons. This is the single biggest recovery upgrade (RPO 24 h → ~2 min). Billing decision — CEO only.
- [ ] Save `SUPABASE_DB_PASSWORD` in the founder's password manager — without it no off-platform `pg_dump` is possible from any operator seat (verified blocked 2026-08-29).
- [ ] Take one dated off-platform `supabase db dump` once the password is available (belt and braces), and rehearse one dashboard restore on a scratch/forked project to measure data-restore RTO.
- [ ] Bookmark: Sentry project, Resend logs, Supabase Auth logs, Vercel deployments, /admin/ops

## Data export, if a customer asks for their data

Self-serve/admin today: **GDPR ZIP** (`GET /api/gdpr/export` as org admin — every org table as JSON; no UI button, use the URL), accounting CSV (+ Xero/Sage invoice formats), finances CSV, reports CSVs, payroll CSV + payslip PDFs, CIS CSVs/PDFs, every document as PDF (quotes/invoices/RAMS/permits/talks/certificates/statements). **Not covered:** uploaded photos/files in bulk (portal "download all" covers portal-shared docs only) — founder does a storage dump on request. Verdict: yes, we can hand over their business data.
