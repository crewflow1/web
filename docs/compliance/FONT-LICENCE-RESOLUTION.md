# Font licence resolution: Clash Display and Satoshi

Date: 2026-11-17. Branch `design/self-hosted-fonts-compliance` (off `main` @ `d24295e8`). Owner: fonts workstream. Not legal advice.
Follows finding A4 in `LICENCE-REMEDIATION.md` (branch `compliance/licence-sbom`).

**Outcome in one paragraph.** The ITF Free Font License lets CrewFlow self-host Clash Display and Satoshi on its own website, but forbids making the font files available through a public repository. `crewflow1/web` is public and has carried the six WOFF2 files since `f38d3d6c` (2026-06-15). This branch removes them from the tree and supplies them at build time from a private source, checked against pinned SHA-256 hashes. Builds without that source (CI, forks, local dev without the kit) use an OFL fallback pair and still succeed. A guard test fails if any ITF font is committed again. Production looks exactly as it does today once the founder adds one secret (section 6). **The files are still in public git history** (section 5). Removing them from the tree does not stop that on its own.

## 1. The licence terms (read, not summarised from third parties)

Source: the ITF Free Font License (FFL) shown on fontshare.com, **Version 2.0, 17 Aug 2026**. It was read on 2026-11-17 from the site's JavaScript bundle (`www.fontshare.com/js/main.d962d2d8.js`). The terms page renders client-side, so a plain HTML fetch shows nothing. The files' own name tables point to `https://fontshare.com/terms`. Version 2.0 post-dates the 2026-06-15 download, and the earlier text was not retrievable. The founder should keep the licence PDF from the kit (FOUNDER-CONFIRMATIONS Q2).

Operative clauses (short quotes):

| Topic | Clause | Effect for CrewFlow |
|---|---|---|
| Self-hosting on our site | §01: "You may self-host the Font Software on your own servers or infrastructure for use on your own websites and applications" | **Allowed.** This covers serving the WOFF2 from crewflow.uk through Vercel's edge, including `@font-face` / `next/font`. |
| Media / apps | §01: any media incl. websites and apps; §01 allows embedding "in mobile or desktop applications" | Allowed for our own pages and apps. |
| Internal copies | §01: the files may be "shared internally among its employees" (stated not to be redistribution); backups allowed | A **private** store that only employees can open is allowed. |
| Redistribution / public repos | §02: may not be "made available to any other person or entity … This includes distributing the Font Software through another font website, font library, marketplace, repository … publicly accessible servers" | **A public Git repository holding the files is a breach.** This is the A4 problem. |
| Contractors | §02: you may not give the files to "external designers, agencies, contractors" | **Even a private repo is wrong if outside contractors can read it.** Keep the files out of `crewflow1/web` completely. The private font store must be employees-only. |
| SaaS / third-party use | §02: may not make the fonts available to third parties through a "SaaS platform", e.g. "as a selectable font" | Use only on CrewFlow's own marketing/legal pages, as today. **Never** add them to a customer-facing font picker, branded-document template or customer PDF. |
| Modification | §02: no modification, incl. "subsetting, format conversion" | We serve the kit files byte-for-byte. Production serves the three Clash files with SHA-256 identical to the repo files (checked 2026-11-17). `next/font/local` renames, it does not subset. |
| Credit | §01: "You may, but are not required to" credit ITF | Optional. Already credited on `/third-party-notices` (PR #1113). |
| Fontshare CDN/API | Preamble allows delivery "directly from servers used by Indian Type Foundry"; §06: the API is used "at its own risk" and may be withdrawn "without prior notice" | Allowed, with no availability promise. |
| Breach / cure | §08: a curable breach gets a written notice and "30 days" to fix it. Immediate termination is for "deliberate or material unauthorized … redistribution" | Inadvertent and quickly fixed is the curable case. On termination we must stop use and delete the files. |

## 2. Options considered

| Option | Licence | Privacy | Appearance | Effort / risk | Verdict |
|---|---|---|---|---|---|
| **(a) Self-host as now, but take the files out of git and provision them at build from a private store** (OFL fallback when absent) | Compliant: self-hosting on own infrastructure; private store is internal | Unchanged. No third-party request; CSP stays `font-src 'self'` | **Identical.** Same bytes, same `next/font` output (section 4) | One secret in Vercel. If the token is missing or expired, the build falls back, or fails if `CREWFLOW_FONTS_REQUIRED=1` | **Chosen** |
| (b) Load from Fontshare's CDN/API | Allowed, but "at its own risk", no availability promise (§06) | Every visitor's IP, user-agent and page URL go to ITF's servers. That needs a lawful basis, a privacy-notice entry and an international-transfer assessment under UK GDPR. A German court awarded damages against dynamic Google Fonts embedding (LG München I, 3 O 17493/20, 20 Jan 2022) | Close, but loses `next/font` preload and metric-matched fallback, so risks FOUT/CLS | CSP change (`style-src`/`font-src`, owned by the CSP workstream). Runtime dependency on a third party | Rejected |
| (c) Switch to open-licence fonts | No restriction (OFL-1.1) | Unchanged | **Visibly different** (see below) | Brand change | Rejected as primary. Used as the build fallback |
| (d) Only make the repo private | Stops ongoing public availability (incl. history) | Unchanged | Identical | One setting. Leaves the files in a repo contractors may read (§02). The problem comes back if the repo is ever public again | Complementary, not sufficient alone |

**Option (c) candidates (measured, not guessed).** Chosen by ranking all 1,753 Google Fonts entries in Next's bundled capsize metrics against Clash/Satoshi (cap height, x-height, average width per weight). The shortlist was then rendered in Chromium on the real hero and body copy:

| Role | Current | Best OFL match | Rendered width vs current (500/600/700 or 400/500/700) | Cap / x-height (per 1000) | Why |
|---|---|---|---|---|---|
| Display | Clash Display 670 / 504 | **Bricolage Grotesque** | 101.2% / 100.0% / 99.1% | 660 / 525 | Closest widths. `ch` unit within 9% of Clash (Funnel Display: −22%), so the `max-w-[16ch]` hero keeps its 3-line wrap |
| | | Funnel Display | 101.1% / 99.2% / 97.8% | 675 / 500 | Best cap/x-height, but its narrow "0" re-wraps the hero to 4 lines |
| | | Space Grotesk | 104.0% / 101.5% / 99.4% | 700 / 496 | Wider at 500 |
| Body | Satoshi 716 / 484 | **Figtree** | 102.6% / 100.4% / 99.3% | 700 / 500 | Closest letterforms (round geometric o/a/y) and closest average width |
| | | Commissioner | 102.2% / 99.9% / 97.9% | 713 / 500 | More condensed grotesk feel |
| | | Hanken Grotesk | 102.3% / 99.8% / 97.6% | 697 / 493 | Narrow "0" (ch −18%) |

Side-by-side rendering: [`font-licence-candidates.png`](font-licence-candidates.png). It is an image of rendered text, which §01 allows; it is not font software. The candidates are near on metrics but none matches Clash Display's wide, tight display letterforms. This is why (c) fails the founder's "preserve appearance" requirement.

## 3. Decision

**Option (a), plus making `crewflow1/web` private going forward** (section 5). Option (a) is the simplest compliant path: it keeps the site byte-for-byte as it is, costs nothing and adds no third-party request. Making the repo private has a CI-minutes consequence that the founder must accept first (section 5).

## 4. Implementation (this branch)

| Change | File |
|---|---|
| Removed the six ITF WOFF2 files from the tree (`git rm`) | `app/_marketing/fonts/{ClashDisplay-Medium,Semibold,Bold,Satoshi-Regular,Medium,Bold}.woff2` |
| Slot manifest: for each of 6 slots, the licensed file name + byte size + SHA-256, and the fallback file + SHA-256 (hashes are not the font) | `app/_marketing/fonts/manifest.json` |
| Build-time provisioner (plain Node, no deps). Source order: `CREWFLOW_FONTS_DIR` (local kit folder) → `CREWFLOW_FONTS_TOKEN` (private GitHub repo via the contents API) → OFL fallback. All-or-nothing, SHA-256-verified, token only in the `Authorization` header and redacted from every message. Never fails unless `CREWFLOW_FONTS_REQUIRED=1`. Skips rewriting identical files. Writes `active/provenance.json` (mode + source) | `scripts/fonts/provision-marketing-fonts.mjs` (+ `.d.mts` types) |
| Wired into `predev` and `prebuild`, after the existing pdf-worker copy. Vercel runs `prebuild`: the gitignored `public/pdf.worker.min.mjs` it generates is served by crewflow.uk (HTTP 200, checked 2026-11-17) | `package.json` |
| `next/font/local` now reads `./fonts/active/{display,body}-NNN.woff2`. Same exports, same `--font-clash` / `--font-satoshi` variables, same fallback / `adjustFontFallback` / preload settings | `app/_marketing/fonts.ts` |
| OFL fallback: Bricolage Grotesque 500/600/700 + Figtree 400/500/700, Latin subset WOFF2 from Fontsource 5.3.0 (`@fontsource/bricolage-grotesque`, `@fontsource/figtree` via jsDelivr), each with its OFL-1.1 text | `app/_marketing/fonts/fallback/` |
| Ignore rules: `app/_marketing/fonts/active/`, `.fonts-private/`, and any `*ClashDisplay*` / `*Satoshi*` font file anywhere | `.gitignore` |
| Guard (security tier). Fails if any tracked font file (1) is named Clash/Satoshi, (2) is byte-identical to a pinned licensed hash, (3) is not on the approved OFL list, or (4) carries "Indian Type Foundry" / "Fontshare" in its decoded name table (own WOFF2/WOFF/sfnt decoder, with positive controls). Also checks the ignore rules, the fallback hashes + OFL texts, and that `fonts.ts` only loads generated paths | `__tests__/security/restricted-font-binaries.test.ts` |
| Provisioner unit tests: no-source fallback, dir source, GitHub source (URL + header, token never in URLs/logs/results), HTTP 401 → all-or-nothing fallback, token redaction from thrown errors, hash mismatch, `REQUIRED` behaviour, unsafe repo/path rejected before any request, idempotent re-run, real manifest + committed fallbacks verify | `__tests__/fonts/provision-marketing-fonts.test.ts` |

### Parity evidence

Method: production build (`npm run build` + `next start` on :3000) and Playwright Chromium full-page screenshots, `reducedMotion: reduce`, animations disabled, DPR 1, at 1280x800 and 390x844, of `/` (home), `/pricing` and `/login`. Before = `main` @ `d24295e8` with the fonts in git. After = this branch, with the six files copied from git history into the gitignored `.fonts-private/` to simulate the private store, and `CREWFLOW_FONTS_DIR=.fonts-private`. Pixel diff over every RGB value (`pngjs`, threshold 0).

| Check | Result |
|---|---|
| Noise floor: two shots of the same `main` build | 0 differing pixels on all 6 |
| **Before vs after (licensed fonts from the private source)** | **0 differing pixels on all 6 screenshots**, same page heights (home 11700 / 11221 px, pricing 3078 / 4587 px, login 1001 / 1001 px) |
| Served font files | Same content-hashed URLs (`/_next/static/media/…-s.p.woff2` etc.) and identical SHA-256 on every page. The H1 computed `font-family` is unchanged |
| Build log | `[fonts] Clash Display + Satoshi provisioned from CREWFLOW_FONTS_DIR (sha256 verified)`, `provenance.json` mode `licensed` |
| **Build with no source** (no token, no dir) | **Build succeeds (rc 0)**. Log: `[fonts] using the OFL fallback typefaces (Bricolage Grotesque + Figtree): no private font source configured …`. Pages render in the fallback pair. The login page is pixel-identical (it uses Inter). Marketing pages differ as expected for a different typeface: page height +0.4% to +2.4%, and no breakage seen |
| `CREWFLOW_FONTS_REQUIRED=1` with no source | Provisioner exits 1 with a clear message (the build would stop before `next build`) |
| Guard negative test | Staging `ClashDisplay-Bold.woff2` plus a copy of `Satoshi-Regular.woff2` renamed `public/brand-body.woff2` makes 4 guard tests fail (name, hash, allowlist, foundry marks). The renamed file is caught by hash **and** by the decoded "Indian Type Foundry" name string. Unstaged afterwards |

The Inter fonts (`next/font/google`, OFL) are untouched.

## 5. Git history: the files are still public

State it plainly: **`git rm` does not remove the fonts from history.** Commit `f38d3d6c` and every later commit up to this branch still contain the six WOFF2 files. Anyone can fetch them from GitHub's history views or a clone of the public repo, and any copy already cloned or archived (forks, CI caches, mirrors, crawlers) is outside our control. `gh repo view` reports **0 forks**, but clones and third-party archives cannot be enumerated.

| Option | What it achieves | Cost / risk |
|---|---|---|
| 1. Leave history, rely on the licence's cure terms (§08: notice, then 30 days to remedy) | Nothing on its own. While the repo is public the files stay publicly available, so the breach continues until someone acts | Free. Weak position if ITF writes |
| 2. **Make `crewflow1/web` private** (repo Settings → General → Danger Zone → Change visibility) | Stops GitHub serving the files, including history and old PR refs, to the public from that moment. This is a remedy in the sense of §08 | One setting, reversible, not destructive. **Does not recall copies already taken.** **Running-cost catch:** `crewflow1` is a personal account, and Actions minutes are free only for public repos. In the last 30 days the repo ran 587 CI runs at about 31 job-minutes each, so roughly 18,000 minutes a month, plus 621 security-scan runs. That is far above the free private quota (2,000 min/month on GitHub Free). CI would stop once the quota is used (default $0 budget) or become metered. Needs a founder decision |
| 3. Ask ITF / Fontshare for written confirmation that removal from the current tree is an acceptable remedy | Written comfort | Free. Discloses the incident. Optional on its own, useful with 1 or 4 |
| 4. Rewrite history (`git filter-repo` dropping the six paths, force-push every branch and tag, then ask GitHub Support to purge cached views and the read-only `refs/pull/*` refs that keep the old commits reachable) | Removes the files from this repo's history while keeping it public | **Destructive**: changes every SHA since 2026-06-15, breaks every open PR (#1090–#1113), worktree and clone, and needs founder approval and a quiet window. Without GitHub Support's purge the old PR refs still serve the files. Does not reach clones. **Not done** |

**Recommendation: option 2, make the repo private, together with this branch. Keep this document as the dated remediation record. No history rewrite.** Option 2 is the only non-destructive way to stop the history being public. It is immediate and reversible. It also stops this document, and the rest of the code, being public. A rewrite is disruptive mid-launch and still needs GitHub Support, and neither option reaches copies already taken. **Before switching, the founder must approve the CI-minutes consequence** (budget, a paid plan, or self-hosted runners, which use no minutes). If that cost is not acceptable, the free fallback is option 4 after the launch PRs have merged, plus option 3. Either way, this branch must land first so that nothing new is published.

## 6. Founder actions (in this order, before merging)

1. **Create a private repo** `crewflow1/crewflow-brand-fonts`, readable by employees only (no outside collaborators, §02). Put the six files at its root with their kit names: `ClashDisplay-Medium.woff2`, `ClashDisplay-Semibold.woff2`, `ClashDisplay-Bold.woff2`, `Satoshi-Regular.woff2`, `Satoshi-Medium.woff2`, `Satoshi-Bold.woff2`. Take them from your Fontshare kit, or export the exact bytes from history: `git show f38d3d6c:app/_marketing/fonts/<name> > <name>`. They must match the SHA-256 in `app/_marketing/fonts/manifest.json`. If a fresh kit download matches those hashes, that also proves the files are unmodified (open item in Q2).
2. **Create a fine-grained personal access token**: resource owner `crewflow1`, repository access "Only select repositories → crewflow-brand-fonts", permission **Contents: Read-only**, nothing else. Pick an expiry and diarise renewal (`crewflow1` is a personal account, so no organisation approval step).
3. **Vercel → Project → Settings → Environment Variables:**
   - `CREWFLOW_FONTS_TOKEN` = the token. Environments: **Production and Preview**. Mark it Sensitive.
   - `CREWFLOW_FONTS_REQUIRED` = `1`. Environment: **Production only**. A missing or expired token then fails the deploy and the current deployment stays live, instead of silently shipping the fallback typeface.
   - Only if you used a different repo name, branch or folder: `CREWFLOW_FONTS_REPO` (owner/name), `CREWFLOW_FONTS_REF`, `CREWFLOW_FONTS_PATH`.
   - Do **not** add the token to GitHub Actions. CI deliberately builds with the fallback.
4. Merge. Check the production build log for `[fonts] Clash Display + Satoshi provisioned from github:crewflow1/crewflow-brand-fonts@main (sha256 verified)`.
5. **Make `crewflow1/web` private** (section 5).
6. Developers who need the real fonts locally put `CREWFLOW_FONTS_DIR=/path/to/kit` (or the token) in `.env.local`. Without it they get the fallback, which is expected.
7. Keep the Fontshare licence PDF with the company records (Q2).

## 7. Residual items

- The FFL text read is v2.0 (17 Aug 2026), not the version in force at download (2026-06-15). The kit PDF is the record for that.
- The fallback is only ever served by builds without the private source (CI, previews without the token, forks). If it ever reached production, its OFL credit would also belong on `/third-party-notices` (owned by the licence workstream). With `CREWFLOW_FONTS_REQUIRED=1` on Production it cannot reach production.
