# CHROME-HQ-QA — real-browser testing, CrewFlow HQ (platform super-admin)

> **Environment:** local dev (port 3001) + local Supabase, real Chromium browser.
> Synthetic superadmin `e2e-hq@crewflow.test` (granted via
> `CREWFLOW_SUPERADMIN_EMAILS`, **no** org membership — correct platform-admin
> shape). **Date:** 2026-11-02.

## Result: the HQ operator console is functional and correctly isolated

| HQ route | What was verified in Chrome | Status |
|---|---|---|
| `/admin` (HQ Home) | "Needs your attention" (decisions awaiting/parked, warning alerts), **Active now** task queue (10 queued), CEO brief, **System health** card correctly flagging "Missing required config: CRON_SECRET" | **PASSED** |
| `/admin/customers` (Customers OS) | lists **all 51 orgs** (cross-tenant platform view — correct for superadmin) with Owner, Subscription, Setup fee, MRR; search + Subscription/Setup-fee/Sort filters; E2E Co row shows "Pat Owner", `past_due` | **PASSED** |
| `/admin/customers/[id]` (E2E Co profile) | full customer profile: MRR/LTV/Onboarding/Migration metrics; operator **Actions** (Open workspace, Email owner, Message, Call, Impersonate, Suspend, Cancel); audit-logged **Recovery actions** (Reset onboarding, Mark setup complete, Resend invite); Financials ("Manual until Stripe lands") | **PASSED** (render + actions present; **not** triggered — Suspend/Cancel/Impersonate are state-changing) |
| `/admin/ops` (System status) | live system health = **Red** (correct: CRON_SECRET missing locally); **env presence table shows presence only, never values** (good secret hygiene): APP_URL/SUPABASE_URL/ANON/SERVICE_ROLE = set; CRON_SECRET = missing·required; RESEND/ANTHROPIC/INTERNAL_ORG = missing·optional | **PASSED** |

HQ nav surfaces observed: Home (Home, Command centre, CEO board, Morning
briefings, Overview, Pulse), Decisions, Workforce, Growth, Customers (Customers,
Onboarding & migration, Billing, Finance AI, Support queue/AI, Customer
success/health, Alerts, Notifications, Internal notes), Governance, Systems
(System status, Analytics, CTO/Design/Documentation/QA/Operations AI,
Impersonation, Launch checklist, Settings).

## Isolation note
The HQ superadmin cannot reach tenant `(app)` routes (no membership;
`requireOrgContext` bounces superadmins) and the owner/staff accounts cannot reach
`/admin` (no superadmin grant). Platform-admin vs tenant separation holds.

## Console/network
HQ Home, Customers OS, customer profile, and Ops loaded with no functional
errors; all data/API/chunk requests returned 200. One trivial asset 404
(favicon/avatar class) observed, non-blocking — logged as OBS-2 (P3).

## Coverage boundary (honest)
This covers the **core HQ operator surfaces** (home, customers, customer profile,
system status). The AI-employee consoles (`/admin/sales`, research,
qualification, outreach, the AI Boardroom), Billing detail, Demos/onboarding
flows, and Governance/Decisions were not each click-tested in this pass and are
marked NOT TESTED in the CSV. State-changing operator actions (promote, suspend,
cancel, impersonate, live charge) were deliberately not triggered.
