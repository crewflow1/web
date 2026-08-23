# CrewFlow Homepage — Creative Direction (Stripe/Apple bar, CrewFlow identity)

Benchmark = the *level* of Stripe / Apple / Linear / Vercel. We do **not** clone
them. We extract principles and express them in CrewFlow's own construction-tech
identity. If it reads as a good Tailwind SaaS template, a wall of cards, or
obviously AI-generated — it has failed.

## The five laws (from the benchmark study)
1. **Restraint is the default.** Few words, one accent (gold), lots of air.
   Confidence is signalled by what's omitted. No feature lists in the hero.
2. **Type is the hero.** One statement ≤10 words (no "and"), then one sentence
   of scope. A 3–4× size jump from headline to body reads as confidence.
3. **Real product UI, cropped to the one thing.** The app is a first-class,
   crafted object — never a lossy full-window screenshot, never a fake
   dashboard. Crop to prove the sentence beside it.
4. **Motion explains a relationship or state change** — never decorates.
   150–260ms, ease-out, ≤24px travel, fires once, paused offscreen, reduced-
   motion-safe. Scroll-scrubbing reserved for the ONE signature moment.
5. **Self-similar modular sections.** Design the unit once (eyebrow → ≤6-word
   heading → one line → one cropped visual → optional "Explore →"), then vary
   content, not layout. A short homepage (8–9 sections), Linear-length.

## Honesty constraint (non-negotiable — overrides "quantify everything")
We have **no customer logos, no metrics, no testimonials** we can truthfully
show yet. So we do NOT imitate Stripe's logo wall / stat spray. Our proof is:
the **real product UI**, **honest capability specifics** (RAMS, CIS, retention,
valuations…), and **real company facts** (UK-built, backups/PITR, UK GDPR). Any
product visual not yet a real seeded screenshot is a **marked placeholder**
(`data-proof="placeholder"`) recorded in the ledger and replaced before CEO
review. Never a fabricated dashboard, number, logo or quote. Product-truth
(LIVE only) is absolute — no AI receptionist, no dark providers, no native apps.

## Visual system (buildable spec)
- **Palette:** ground `navy-950 #070E17` / `navy-900 #0B1622`; panels
  `navy-800/850`; hairlines `#24384C`; **one accent** gold `#EAB23C`; functional
  blueprint `#2E5C8A`, positive `#1C9E6F`, danger `#D6533C`. Text ramp
  `#F3F6FA / #AEBECD / #7F92A6` (all ≥AA). Gold is for one hero word, the
  primary CTA, and a single key mark — never a wash, never a gradient sea.
- **Type:** Clash Display (headings, weight 600–700, tracking −0.02 to −0.03em),
  Satoshi (body). Scale (fluid, clamp): hero **clamp(2.75rem, 6vw, 5rem)**;
  h2 clamp(1.9rem, 3.2vw, 2.75rem); h3 1.35rem; lead 1.15rem; body 1rem (min);
  eyebrow 0.75rem uppercase tracked. Headline ≤ ~20ch/line; body 55–70ch.
- **Grid & space:** max content **1120–1200px** (`max-w-cf`); 12-col, gutter
  24–32px; section padding **clamp(64px, 9vw, 132px)**; whitespace scales up
  with importance (hero + final CTA get the most). Density lives *inside*
  product frames; the page chrome stays airy.
- **Depth:** elevation from a 1px hairline + one soft shadow on a solid ground.
  No glow, no glassmorphism, no neon, no purple, no blobs.
- **Signature motif — "setting-out":** a faint blueprint grid + thin structural
  lines, corner tick-marks / coordinates / dimension annotations (like a
  drawing's setting-out). Cheap CSS/SVG. Used to *connect* things (the workflow)
  and to frame the hero — not as wallpaper everywhere.

## Homepage narrative (short, deliberate pacing)
1. **Hero** — extreme restraint. Eyebrow (technical, gold). H1 ≤10 words. One
   scope sentence. Primary **Book a demo** + ghost **Explore the platform**
   (→ /product). One signature visual: a light product frame emerging from the
   dark on the setting-out grid. No stats, no logos.
2. **The problem** — one honest line: the construction company run across six
   disconnected tools (spreadsheets, WhatsApp, paper diary, separate books).
   Small, tonal, sets up the answer. Cut if it doesn't earn its space.
3. **★ Signature moment — "One job, end to end."** The connected-workflow: a
   job travels through CrewFlow — Lead → Quote → Job → Site (RAMS/diary/
   drawings) → Variation → Valuation → Invoice → Cash → Control. Numbered
   stages (Linear 1.0–n.0), each a cropped light product frame, connected by
   structural setting-out lines, revealed once on scroll (IntersectionObserver).
   Reduced-motion → the same as a clean static diagram. THIS is what people
   remember; it *is* the proof that CrewFlow runs the company.
4. **Six pillars** — presented richly (NOT six equal cards): an *index* /
   chaptered navigator with one product surface, outcome-first per pillar, each
   linking to its /product/[pillar] page. Breadth as structure, not sprawl.
5. **Differentiation** — "Not a job app. A construction ERP." The tier-defining
   live capabilities: RAMS, CIS, retention, staged valuations, drawings, job
   costing, worker sign-off. Short, specific, confident.
6. **Objections** — honest, brief: switching (done-with-you migration, runs
   alongside Xero), mobile (mobile-first web), card payments (bank transfer, no
   fees), data (backups/PITR/UK GDPR), lock-in (CSV export, no tie-in).
7. **Pricing/value** — one transparent line (£500/mo + £1,000 setup, everything
   in, no per-seat), anchored below the value; link → /pricing. Not shouted.
8. **Final CTA** — the most air on the page. Book a demo + Explore the platform.
9. **FAQ** — native `<details>`, the real honest answers.

Cut anything that doesn't advance the story. More is not better.

## Product-frame treatment
Light UI floating in graphite: browser/device framing, radius 14–16px, one soft
large-radius shadow, subtle overlap/bleed to imply "there's more", occasional
gentle perspective. Crop to the ONE screen that proves the point; keep it
legible. Callouts restrained (a single label/metric max, and only if true).
Decorative frames `aria-hidden`; each carries an `sr-only` caption of the real
screen. Placeholders clearly tagged and ledgered.

## Accessibility & performance (built-in, not bolted-on)
One `<main>`, one `<h1>`, skip link, ordered headings, AA contrast (verify gold/
muted on their real grounds), keyboard-safe CTAs with visible focus, reduced-
motion honoured, decorative frames out of the a11y tree. RSC/SSG; motion via
CSS/IntersectionObserver (no scroll-scrub libs, no WebGL/canvas); lazy heavy
below-fold; preload only the H1 face + LCP; no layout shift; watch First Load JS.

## Mobile is its own experience
Re-authored copy (shorter), purpose-built portrait framing of product (crop, not
shrink), persistent/obvious CTA, one column, ≥44px targets, tighter section
padding (~56–80px), the signature moment simplified to a clean vertical stepped
diagram. Verify 320/375/390/430/768/1024/1280/1440/1728. No horizontal overflow.

## Build process (per section)
DESIGN → IMPLEMENT → RENDER → SCREENSHOT → CRITIQUE (creative-director +
adversarial) → COMPARE TO BAR → FIX → mobile + desktop → continue. Never
code-the-whole-page-then-ask. The critique reviews the *render*, not the code.

## Quality rubric (score honestly /100; do not inflate)
Art direction · Typography · Visual hierarchy · Product storytelling ·
Originality · Construction specificity · Motion · Interaction detail · Mobile ·
Accessibility · Performance · Copy · Product truth · Conversion · Overall.
**Gate to pass:** overall ≥ 95 AND every category ≥ 90 AND creative-director
accepts AND adversarial reviewer finds no obvious template pattern AND
product-truth passes AND mobile ≥ desktop AND a11y passes AND perf not
compromised. If it scores 82, say 82, then fix. Repeat until the render earns it.

## Temporary visuals ledger (must be replaced before CEO review)
- `components/marketing/product-frame.tsx` placeholders (`data-proof="placeholder"`)
  — every use on the homepage is a stand-in for a REAL seeded CrewFlow
  screenshot. (Populate this list as sections are built.)

## LOCKED DECISIONS (from the construction-tech creative memo)
**Identity — "The Setting-Out System":** datum grid + margin grid-refs; dimension
lines (`<Dim>`); ONE annotation leader-line per product frame; coordinate/revision
tags as eyebrows/captions; the **light product frame** (paper-white `#F7F9FC`, 1px
border, soft shadow, 1px inset top highlight) as the "built object" set into the
graphite board; a structural load-path line (`scaleX`, blueprint→gold); hairline
rules + tabular numerals; semantic status pills (emerald/gold/red) as the ONLY
other colour. Depth by material, never glow — no radial-glow wash anywhere.
**Hero copy (locked):** H1 "Run the whole job. From the first call to the last
payment." · sub "Leads, quotes, site paperwork, valuations, CIS and VAT — one
system built for how UK construction actually gets paid." · chips "Set up in
days · Built in the UK".
**Per-pillar outcome lines:** from the memo §4 (all LIVE/deterministic, no AI
brand). **Six-pillar layout:** chaptered index rail (B) as the spine + one
product-surface navigator (A) as the single deep set-piece. NEVER a six-card grid.
**Signature moment — "One job, end to end":** Lead → Quote → Accepted → Site
(RAMS/diary/drawings) → Variation → Valuation → Invoice → Cash → Reporting; light
frames lift + the structural line draws (`Reveal`/IntersectionObserver + `scaleX`);
reduced-motion / no-JS → a finished static setting-out diagram.
**CUT (do not port from the old homepage):** the Sunday phone mock (push notifs +
WhatsApp inbound = DARK), the "keeps-watching" 6-card grid, the six separate full
mockups, the triple radial glow, WhatsApp-as-lead-channel, and any quote
"read-receipt / Viewed" claim (not in product-truth LIVE).
