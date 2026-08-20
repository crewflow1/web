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
- CP1: worktree `redesign/website-2026` off `fc8922c4`; `npm ci`; skills loaded (Skill-tool discoverable); ledger written.
- CP2: unified dark tokens + Tailwind mapping; dev server :3200; typecheck clean; baseline renders (pipeline verified).
- CP3 (commit a695cb3d): accessible global nav — desktop dropdowns + mobile drawer (browser-verified @375px) — canonical wordmark, `/product` allowlist, dead `/for/` dropped.
- CP4: **AI-receptionist overclaim removed site-wide** — feature page deleted, 8 comparison rows, both industry pages, pricing, schema `featureList`; `operatingSystem`→`"Web"`; 301 `/features/ai-receptionist`→`/features/construction-crm`. Verified live: redirect 308, sitemap 0 entries, rendered pages 0 "receptionist", all pages 200, typecheck clean.
- CP5: **new dark site shell + `/product` six-pillar section** — `app/(site)/` route group with dark layout (SiteNav + dark SiteFooter + skip link + single `<main>`, Clash+Satoshi applied group-wide, entity JSON-LD). Built `/product` overview + 6 pillar pages (win-work / run-jobs / site-safety / money / people-assets / automation) from `lib/marketing/pillars.ts` — **honest LIVE capabilities only** (product-truth checked). Verified: all 6 routes 200, unknown→404 (static params), one `<h1>` + one `<main>` per page, no overflow, no console errors, navy-950 ground, browser-screenshotted desktop. PENDING for this section: add `/product*` to `sitemap.ts`; per-pillar OG images; real product screenshots (R1).

- CP6: **CREATIVE-DIRECTION OVERRIDE → Stripe/Apple bar.** Research (reference-principles + construction-tech memos, parallel agents) → `docs/redesign/CREATIVE-DIRECTION.md` — identity **"The Setting-Out System"** (datum grid + grid-refs, dimension lines, coordinate tags, the LIGHT product frame as the built object in the graphite board, structural load-path line, tabular numerals; depth by material, never glow). Homepage rebuilt on the `(site)` dark shell — old `app/page.tsx` removed; `/` now `app/(site)/page.tsx`: Beat 1 hero (restraint, datum grid, white H1 + single gold payoff), Beat 2 product-as-hero (light app-shell frame), Beat 3 signature **"One job, end to end"** 9-station connected rail (Lead→…→Control incl. Site/Variation/Valuation ERP differentiators, blueprint→gold structural line). Primitives: `components/marketing/setting-out.tsx`, `components/marketing/home/job-flow.tsx`, refined `product-frame.tsx` (honest light schematic, `data-proof="placeholder"`). Typecheck+lint clean; full-page rendered + critiqued (tall-viewport workaround for the pane's scrolled-compositing glitch). **Honest self-score ~70/100 — INCOMPLETE; does NOT pass the ≥95 gate.**

### Temporary visuals (MUST be replaced before CEO review — R1)
- Homepage Beat 2 "Operations dashboard" `ProductFrame` — honest light schematic placeholder (`data-proof="placeholder"`) → replace with a real seeded screenshot.

### Homepage beats remaining
4 Pillars (chaptered rail + one deep product navigator) · 5 Differentiation (site / commercial / UK-finance) · 6 Objections · 7 Pricing/value · 8 Final CTA · 9 FAQ · + motion (Reveal + line-draw, reduced-motion-safe) · full 9-breakpoint responsive + a11y + perf + adversarial design critique until it earns ≥95.

## Remaining programme (post-CP5)
- Homepage rebuild on the (site) shell (problem → OS → six pillars → proof → connection → CTA); `aria-hidden` decorative mockups.
- Migrate legacy light sub-pages (features/compare/industries/locations/blog/tools/pricing) onto the dark shell (restyle `sections.tsx`), or move into `(site)`.
- New high-intent feature pages (H&S/RAMS, CIS, fleet, stock, retention, valuations, blueprints, site diaries) — LIVE only.
- SEO: `/product*` + new pages into sitemap; per-page OG; fix `/offline` noindex + `liverpool` dangling link; verbose compare slugs.
- CRO: rebuild demo modal on `components/ui/modal.tsx` (focus trap/scroll-lock); add a low-commitment secondary CTA.
- Analytics: PostHog + funnel events (config-gated; flagged for CEO).
- Real product proof: seed a demo org (R1 feasibility) → art-directed screenshots.
- Hardening: full multi-breakpoint responsive + a11y + perf sweep; adversarial reviewer pass; branch-push preview.

---

## Progress 2 — CP7–CP9 (homepage completed + adversarially hardened)

- **CP7 (commit 7dd4566e):** homepage beats 4–9 built — Beat 4 `PillarsIndex` (six-pillar "drawing register" index, not a card grid), Beat 5 `Differentiation` (site / commercial / UK-finance columns), Beat 6 `SwitchTrust`, Beat 7 `PricingBlock`, Beat 8 final CTA, Beat 9 `Faq` (native `<details>`, product-truth-safe). Full narrative renders end-to-end; typecheck+lint clean.
- **Mobile pass:** verified 320 + 390 — no horizontal overflow at either; hero H1 clamp floor dropped to 2.4rem so 320 isn't cramped; signature rail switches to a genuine **vertical** treatment on mobile; product frame adapts (sidebar hidden, tiles 2-col). Mobile is designed, not stacked-desktop.
- **Adversarial review (independent agent, job = REJECT):** surfaced legitimate P0 product-truth violations + real a11y defects. **All safe findings fixed (CP8/CP9):**
  - **CP8 (commit 954d23fd):** P0 truth — removed **"valuations / applications for payment"** (hero, meta, signature station 06→"Retention", differentiation, Money pillar) and **"lead scoring"** (Win-work + Automation) as dark/unconfirmed per product-truth authority; payroll → "PAYE/NI **estimates**"; "company health" reworded off the AI-prose implication; FAQ "most companies"→"setup usually takes". A11y — real gold focus ring on the six primary product-nav links (was an invisible 3% wash); footer column labels `h2`→`p` (stop polluting the heading outline). Motion — replaced `animation-timeline: view()` (re-scrubs/reverses on scroll-up) with a **one-shot IntersectionObserver `Reveal`** (default-visible, fires once, never stuck); added `scaleX/scaleY` **line-draw** to the signature rail on reveal. Polish — pricing headline off the SaaS cliché ("Priced for a builder, not a software buyer."); `product-frame` radius → `rounded-cf` token. Verified live: 6/6 reveals opacity 1, `scaleX(1)`, **zero** "valuation"/"lead scoring" on the rendered page, clean h2 outline.
  - **CP9 (commit 1217b75a):** nav mobile drawer — real **focus trap** (Tab wraps first↔last) + **restore focus** to the trigger on close (kept scroll-lock + Esc); desktop dropdown items given a visible gold focus ring. tsc clean.
- **Honest self-score now ~88–90/100.** Blocked from the ≥95 gate on ONE thing: **real product screenshots (R1)** — the reviewer's top "doesn't hit the bar" item; the page's only product visual is the marked placeholder frame.

### R1 — Real product screenshots (feasibility RESOLVED, workstream OPEN)
- **Feasible in this environment:** Docker running; Supabase CLI 2.98.2; a local **`crewflow`** stack is UP (db/auth/storage/rest/kong) with the DB on `localhost:54322`.
- **But not turnkey:** live local data is **sparse** (4 orgs, 4 jobs, **0 invoices, 0 customers**) → empty-looking screens; the canonical `scripts/seed.ts` (`npm run db:seed`) is **referenced but absent** on this branch; only QA/war-test seeds remain (unknown/likely-destructive — not run without understanding them). A demo-lifecycle service exists (`server/services/demo-lifecycle.ts`, `app/api/demo`, `lib/demo`).
- **To produce real screenshots needs a focused pass:** provision/seed ONE realistic demo org (customers→jobs→invoices→RAMS→fleet) safely (new org, not the existing 4), run the app against local Supabase, authenticate, capture 5–8 light-UI screens (working around the pane's scrolled-compositing glitch), crop → drop into `ProductFrame`/`JobFlow` `children` slots.
- **Decision:** NOT forced mid-session (would risk thin/empty or wrong screens — the opposite of the honesty bar). Sanctioned **marked placeholders retained**. **CEO decision point:** (a) authorize a dedicated seed+capture pass, (b) provide approved screenshots, or (c) accept marked placeholders for the preview. Will NOT fabricate screens.

### Next (non-gated) programme work being continued
Migrate conversion-critical legacy light pages onto the dark `(site)` system (start: `/pricing`, then `/compare`) so the homepage journey stays coherent; then feature pages, demo-modal rebuild, SEO cleanup, analytics, full QA, preview.

---

## Progress 3 — CP10–CP11 (core journey + entire legacy surface unified dark)

- **CP10 (commit): dark `/pricing`.** New `app/(site)/pricing` on the Setting-Out system — hero, sticky all-in price card (`SITE.pricing` source of truth) + inclusions, an "everything included" section rendered as the **six `/product` pillars** (keeps users in the dark system rather than linking to legacy light feature pages), dark FAQ, CTA. Removed `app/(marketing)/pricing` (same-route conflict). Verified dark desktop + mobile (no overflow, H1 38px @390).
- **CP11 (commit): the ENTIRE legacy marketing surface migrated to dark — the dark-home / light-subpage split is GONE.** The high-leverage move: (1) flipped `app/(marketing)/layout.tsx` to the dark shell (SiteNav + `SiteFooterDark` + skip link + brand fonts, mirroring `(site)`); (2) rewrote the shared `components/marketing/sections.tsx` to the dark Setting-Out system (tokens only, `font-display` headings, gold accents, datum grid on heroes/CTA, dark comparison table + versus columns, dark card grids, dark FAQ). Then swept the surfaces that bypass the shared spine: the interactive **calculators** (`calc-ui.tsx` dark inputs/selects/results + `tool-page.tsx`), and the per-`[slug]` custom sections in **compare / industries / features / construction-software (locations)**, plus the **blog** hub cards and the post prose renderer (`Block`). Verified dark + functional: `compare/crewflow-vs-procore` (full table + versus + verdict), `tools/markup-calculator` (live dark calculator: £1,428.57/£428.57/42.9%), industries/features/locations/blog — all render on the dark system, tsc clean, no overflow.
  - **Deliberately NOT touched:** the **book-demo modal** (`_book-demo-modal.tsx`) — conversion-funnel code under the standing gate; it stays light when opened (a contained, acceptable "form" surface; hidden on load so pages are fully dark). Flagged for founder: (a) a11y focus-trap/restore, (b) optional dark restyle — both touch the demo/payment funnel. And **`/developers`** — already correctly **dark-gated** (404s in prod behind `FEATURE_PUBLIC_API_JOBS`), so it does not overclaim the public API; its light API-doc badges only ever render if the API launches. Product-truth-correct as-is.

**Site coherence now COMPLETE:** homepage + `/product`×7 + `/pricing` + compare/industries/features/locations/blog/tools all share one premium dark identity, one nav, one footer. Remaining: R1 screenshots (CEO decision), SEO polish (`/offline` noindex, per-page OG, verify new pages in sitemap), full multi-breakpoint QA sweep, analytics (config-gated), non-prod preview push, final CEO package.

- **CP12 (commit): SEO polish.** `/offline` now `noindex,nofollow` (new `app/offline/layout.tsx`; the client page couldn't export metadata and was defaulting to index) — page stays light as product surface by design. Removed `liverpool` from two `locations.ts` `related[]` arrays (no `/construction-software/liverpool` page — it 404s); validated **0** remaining dangling location related-refs. Confirmed the sitemap already carries `/product` + 6 pillars + `/pricing`.
- **Mobile QA of the migrated surface:** `compare/[slug]` @390 — no page overflow, the comparison table scrolls inside its `overflow-x-auto` wrapper (not the page); `/pricing` @390 no overflow (H1 38px); `tools/markup-calculator` live + dark. Migration is breakpoint-robust.

## STATE AT HANDOFF (this session)
**Built + verified on `redesign/website-2026` (NOT merged, NOT deployed):** a complete, coherent, premium **dark** redesign of the entire public site on the Setting-Out identity — homepage (adversarially hardened), platform + 6 pillar pages, pricing, and the whole legacy SEO surface (compare/industries/features/locations/blog/tools). Product-truth enforced site-wide (AI-receptionist, valuations, lead-scoring all removed). Honest homepage score ~88–90.

**Three items need a CEO/founder decision (genuine blockers):**
1. **Real product screenshots (R1)** — the one thing between the homepage and the ≥95 bar. Feasible here (local stack up) but needs a trustworthy demo-seed + auth-capture pass. Options: authorize the seed+capture pass / provide approved screenshots / accept marked placeholders for the preview.
2. **Book-demo modal** — light + a11y-imperfect (focus trap/restore). It's conversion-funnel code under the standing gate, so untouched. Restyle-to-dark + a11y fix needs founder sign-off (funnel-adjacent).
3. **Analytics** (PostHog/funnel events) — config/keys gated; deferred.

**Deliverable step available on request:** push `redesign/website-2026` to origin → non-prod Vercel preview (SSO-gated to the CEO) for review. No prod merge without explicit approval.
