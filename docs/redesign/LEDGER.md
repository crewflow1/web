# CrewFlow Website Redesign — Execution Ledger

**Branch:** `redesign/website-2026` · worktree `/Users/moetalibi/Code/web-redesign` · off `origin/main fc8922c4`.
**Finish line:** FULL REDESIGN BUILT + FULL QA + PREVIEW READY + AWAITING CEO APPROVAL. **No prod merge/deploy.**

## Hard boundaries (never cross without explicit CEO approval)
- No merge to main / no production deploy / no prod DB writes / no prod customer data.
- No customer data in screenshots.
- No activating AI receptionist / telephony / Stripe / comms / external providers.
- Never market a built-dark feature as live. Never fabricate proof (testimonials/logos/metrics).
- No changes to Stripe/Twilio/Vapi/payments/receptionist code.

## Brand decision (locked by CEO)
KEEP premium **DARK** marketing identity (graphite-navy + gold). Product stays **LIGHT**, shown inside device/browser frames as the proof layer — deliberate contrast. Unify to ONE dark marketing design system. One gold `#EAB23C`, one navy `#0B1622`, Clash Display + Satoshi site-wide.

## Product IA — six pillars
1. **Win Work** (CRM, leads, scoring, quotes, follow-ups, pipeline)
2. **Run Jobs** (jobs, scheduling, ops centre, variations, docs, customer portal)
3. **Site & Safety** (RAMS, toolbox, permits, diaries, worker sign-off, blueprints, evidence)
4. **Money** (invoices, staged/valuations, retention, job costing, cash, VAT, CIS, payroll, expenses, POs)
5. **People & Assets** (workforce, rota, timesheets, worker portal, fleet, assets, stock, suppliers, procurement)
6. **Automation & Intelligence** (deterministic automation/workflows/reminders/reporting/lead-scoring — LIVE only)

## Product-truth guardrail
Authority: `~/.claude/skills/crewflow-brand-design/references/product-truth.md`.
- **MUST FIX (overclaims):** AI receptionist (dark) on `/features/ai-receptionist`, all 8 comparison "Included" rows, `industries.ts` plumbers+heating, `pricing/page.tsx`, `features/page.tsx`, and `schema.ts:128 featureList`; `schema.ts:114 operatingSystem "Web, iOS, Android"` → `"Web"`.
- **LIVE & marketable:** full ERP (leads/CRM, quotes+e-sign, jobs+scheduling, staff/payroll, H&S/RAMS/permits/toolbox, CIS, retention, valuations, PO 3-way matching, fleet, assets, stock, portal, blueprints, PWA/offline, deterministic automation).
- **DARK — never market as live:** generative AI, telephony/receptionist, SMS/WhatsApp, live accounting sync, HMRC/CIS filing, open banking, public API, portal card payments, self-serve billing, native apps, calendar sync, telematics, weather.

## Preserve (from recon)
`components/ui/{modal,tokens,badge,stat-tile,table,button}` · `app/_marketing/{motion,fonts}.ts` · `components/marketing/sections.tsx` structure · SEO engine (`lib/seo/*`, sitemap/robots/`api/og`) · 4 calculators · demo funnel flow · branded PDF library (product side).

## Wave plan + status  (✅ done · 🔨 in progress · ⏳ pending)
- **A. Design system + global shell + nav + footer + a11y foundation** — 🔨
  - unified dark tokens (`app/_marketing/tokens.css`) + Tailwind mapping — 🔨
  - fonts (Clash+Satoshi) site-wide for marketing — ⏳
  - global responsive nav (mobile drawer, a11y) — ⏳
  - global footer (new IA) — ⏳
  - skip link + `<main>` + landmarks — ⏳
- **B. Homepage + product overview** — ⏳
- **C. Six pillar pages (parallel, worktree-isolated)** — ⏳
- **D. Feature pages + pricing + comparison/industry migration** — ⏳
- **E. Real product proof (screenshots — feasibility-gated, see risks)** — ⏳
- **F. SEO cleanup + redirects + structured data (+ remove AI-receptionist overclaim)** — ⏳
- **G. CRO + analytics event architecture + forms** — ⏳
- **H. Responsive + a11y + perf hardening** — ⏳
- **I. Full visual/regression QA + adversarial reviews** — ⏳

## Feasibility risks (honest)
- **R1 — Real product screenshots:** need the authenticated app + an isolated DB; prod is off-limits. Verifying whether local Supabase/preview is feasible. If not → build art-directed frames + slots; capture deferred to a seeded preview env (per CEO note). Will NOT fabricate screens.
- **R2 — Vercel preview is SSO-gated** (401 anon) → verify via local dev server + browser; branch-push preview handed to CEO.
- **R3 — npm ci** feasibility/time — in progress (bg `b3cszxrkt`).

## Checkpoints
- CP1: worktree `redesign/website-2026` created off `fc8922c4`; `npm ci` started; skills loaded (now Skill-tool discoverable); ledger written.
