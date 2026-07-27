# Deployment & Google Search Console Readiness

The exact steps to get the SEO work live and indexed. Covers the brief's
Phase 1 (merge & deploy + verify) and Phase 2 (Search Console readiness).

> **Status:** all SEO work is integrated onto current `main` on the branch
> **`seo/phase-2-authority`** (a worktree at `../web-seo`). It typechecks clean
> and **passes a full production build** (60+ marketing pages incl. the free
> tools prerender static/SSG). It is **not pushed or deployed** — that needs a
> real production build with live secrets, which the sandbox doesn't have.

---

## Why I didn't auto-deploy (read this)

1. **Production build can't be verified here.** The sandbox has blank env
   secrets, so a real `next build` only passes with placeholders. A live deploy
   must be built with real secrets — that's your environment, not mine.
2. **Pushing to `main` = a live production deploy** (Vercel). That's the highest
   blast-radius action there is; it should be a deliberate human action behind a
   green CI, per the branch → preview → human-approved-merge workflow.
3. **`main` had diverged** (premium homepage redesign + a small SEO pass #161).
   I rebased cleanly onto it, but you should eyeball the result in a **preview
   deploy** before promoting — especially the design note below.

So this branch is **deploy-ready**, and the steps below make it a one-PR action
for you.

---

## ⚠️ One design decision for you

`main`'s homepage uses a premium dark/gold `mkt-*` design system
(`app/_marketing/marketing.css`). My 60+ marketing pages use the prior
light slate/amber Tailwind theme. They're high-quality and fully consistent
**with each other**, but visually lighter than the new homepage.

- **Functionally** this is fine — Google doesn't care, and the pages are premium.
- **For brand polish**, you may want them harmonised to the `mkt-*` theme. That's
  a bounded job (the pages render from ~6 shared components in
  `components/marketing/`), but it needs **visual QA in a preview**, which I
  couldn't do here. **Recommendation:** ship to a preview, look at it, then
  decide harmonise-now vs ship-now-polish-later. SEO value doesn't depend on it.

---

## Deploy steps (for you)

```bash
# 1. Push the integration branch (preview deploy on Vercel)
cd ~/Code/web-seo            # the prepared worktree, branch seo/phase-2-authority
git push -u origin seo/phase-2-authority

# 2. Open a PR into main
gh pr create --title "SEO: technical foundation + content engine + free tools" \
  --body "Adds robots/sitemap/manifest, JSON-LD, OG images, 55 marketing pages, 4 free calculators. Rebased clean onto main; homepage redesign untouched."

# 3. Review the Vercel PREVIEW deploy (not prod). Verify the checklist below.
# 4. Merge the PR -> triggers the PRODUCTION deploy.
# 5. Run the post-deploy verification below against crewflow.uk.
```

When you're done with the worktree: `git worktree remove ../web-seo` (the branch
stays).

---

## Pre-merge verification (on the preview URL)

- [ ] `https://<preview>/robots.txt` returns the rules + sitemap line.
- [ ] `https://<preview>/sitemap.xml` lists 63 URLs (all 200, none private).
- [ ] `https://<preview>/manifest.webmanifest` loads.
- [ ] Open 5 random marketing pages — each returns 200, has one `<h1>`, a
      canonical, OG tags, and renders correctly.
- [ ] `https://<preview>/api/og?title=Test&eyebrow=Feature` renders a 1200×630
      PNG (this is the one thing I couldn't verify — edge runtime).
- [ ] Each calculator at `/tools/*` computes correctly in the browser.
- [ ] Homepage still looks right (the redesign is untouched) and its footer now
      links to the new hubs.
- [ ] No console errors; no broken internal links (crawl with Screaming Frog).

## Post-deploy verification (on crewflow.uk)

- [ ] All of the above, on production.
- [ ] **Rich Results Test** (search.google.com/test/rich-results) on the homepage
      + a feature + a comparison + a tool: Organization, WebSite,
      SoftwareApplication, BreadcrumbList, FAQPage all valid, no errors.
- [ ] **Schema Markup Validator** (validator.schema.org) — no errors.
- [ ] Canonicals all self-reference the apex `https://crewflow.uk/...`.
- [ ] `www.crewflow.uk` 301-redirects to apex.
- [ ] **Lighthouse SEO** = 100 on homepage + a few marketing pages (Performance
      should be strong — pages are static with ~1.6 kB page JS).

---

## Google Search Console (and Bing) setup

1. **Add the property** for `crewflow.uk` (Domain property via DNS TXT — covers
   http/https + www/apex).
2. **Submit the sitemap:** `https://crewflow.uk/sitemap.xml`.
3. **Request indexing** for the priority pages (homepage, `/features`,
   `/compare`, top comparison + feature pages, `/tools`).
4. **Set international targeting** to the UK (or rely on `en-GB` + .uk signals).
5. **Check Coverage** after a few days: aim for all 63 URLs "Indexed". Watch for
   "Discovered/Crawled – currently not indexed" on the location pages (thin-content
   signal — see `06-programmatic-and-internal-linking.md`).
6. **Enhancements panel:** confirm Breadcrumbs + FAQ + Sitelinks searchbox
   (n/a — we don't emit one) + Logo are detected.
7. Repeat add-property + sitemap in **Bing Webmaster Tools** (and import from GSC).
8. **Monitor monthly:** impressions, clicks, average position, indexed count,
   and the rich-result reports.

---

## Performance / Core Web Vitals (Phase 9)

The new pages are already in good shape — static prerender, ~1.6 kB page JS,
system-rendered OG, no heavy client libs. To lock in great CWV:

- **LCP:** marketing hero is text + CSS (no large hero image to block). If you add
  hero images, use `next/image` with `priority` and explicit dimensions.
- **CLS:** all images that get added must have width/height; the calculators
  reserve their result area, so no layout shift on compute.
- **INP:** calculators are trivial local state — no INP risk. Keep third-party
  scripts (analytics) `afterInteractive`/deferred.
- **Fonts:** Inter via `next/font` (already `display: swap`, self-hosted) — no
  layout shift, no render-blocking. The marketing redesign uses local fonts in
  `app/_marketing/fonts` — keep them `next/font/local` with `display: swap`.
- **Caching:** static pages get Vercel's CDN edge caching automatically. The OG
  route is edge-rendered + cacheable.
- **JS/CSS:** Tailwind is purged at build; marketing CSS is scoped. Keep bundles
  lean — avoid pulling heavy client libs into marketing pages.

Run PageSpeed Insights on the homepage + 2–3 marketing pages after deploy and
fix anything below "Good". Most likely there's nothing to fix on the new pages.
