# PWA Foundation + Offline Application Shell (Programme F)

Programme E let a user download an authorized drawing and view it offline **from an
already-loaded page**. It deliberately stopped short of a **cold, no-network launch**:
if the crew closed the tab in a basement and re-opened CrewFlow with no signal, they
got the browser's network-error screen. Programme F closes that gap. It adds the
**PWA foundation** (installable, hardened manifest, icons) and a **service worker**
that serves CrewFlow's **own offline application shell** — and, from that shell, opens
the **real** Programme E viewer on the drawings already on the device.

The service worker is the dangerous part of any PWA: it is long-lived code that sits
between every request and the network, on a shared device, and it persists across
deploys. The whole design below exists to make it **safe enough to ship** — a strict
deny-by-default cache allowlist, versioned caches with automatic cleanup, no
self-`skipWaiting`, and a runtime proof that it never caches a single byte of private
data. **Zero new infrastructure, zero new runtime dependency, zero server cost.**

## What ships
- **`public/sw.js`** — a small (~110-line) hand-written service worker. No Workbox, no
  `next-pwa`, no build-time codegen — nothing to audit but the file you can read.
- **`lib/pwa/cache-policy.ts`** — the pure, unit-tested request **classifier** that
  decides what may be cached. The worker mirrors it verbatim (a worker can't import
  bundled modules); a security test asserts the worker still enforces the rules.
- **`app/offline/page.tsx`** — the public offline shell route.
- **`app/(app)/_components/sw-register.tsx`** — registration + a non-blocking update prompt.
- **`app/(app)/_components/offline-identity-marker.tsx`** — records "who is signed in on
  this device" so the offline shell can scope what it shows (see Security).
- **`app/manifest.ts`** — hardened Web App Manifest (already existed; extended).
- **`public/icons/*`** — 192 / 512 / maskable-512 PNG install icons.

## The cache policy — deny by default (the security core)

`classifyRequest()` sorts every request into one class; **only two are cacheable.**

| Class | What | Strategy |
|------|------|----------|
| **A — static** | `/_next/static/**` (content-hashed, immutable) | cache-first ✅ cacheable |
| **B — icon/shell** | `/offline`, `/manifest.webmanifest`, `/icon.svg`, `/favicon.ico`, `/icons/**`, `/pdf.worker.min.mjs` | cache-first ✅ cacheable |
| **C — navigation** | top-level document navigations | network-first → `/offline` on failure ❌ never cached |
| **D — private** | `/api/**`, `/auth/**`, and **every** authenticated app surface (`/jobs`, `/invoices`, `/dashboard`, …), **all cross-origin** (Supabase REST/Storage, signed URLs, telemetry), and **all non-GET** | network-only ❌ never cached |
| **E — blueprint** | `/jobs/*/blueprints/f/*` (the authorized document bytes) | network-only — **Programme E's IndexedDB owns these**, the SW never touches them ❌ never cached |

The default is **never cache**. A new private route added anywhere in the app is class
D automatically (deny-by-default), so a future feature cannot silently start caching
user data by omission. `isCacheable()` returns true for **only** class A and B.

**Why the pdf.js worker is class B.** `/pdf.worker.min.mjs` is a public static asset
with no auth and no user data, but the offline viewer paints **nothing** without it. It
is therefore a legitimate shell asset, cache-first, and warmed on download (below).

## The service worker lifecycle

- **install** → precache the public shell (`/offline`, manifest, icons) with
  `Promise.allSettled` of individual `cache.add`s, so one 404 can't poison the whole
  precache. **It does not `skipWaiting`.**
- **activate** → delete every `crewflow-pwa-*` cache **not** in `CURRENT_CACHES`, then
  `clients.claim()`. This is the rollback mechanism (below).
- **fetch** →
  - non-GET → ignored (network).
  - navigations → `fetch(request)` first; **only** on a genuine network failure serve
    the precached **public** `/offline`. Authenticated HTML is fetched but **never
    written to cache**, so no private page can ever be replayed to another user.
  - same-origin class A/B → cache-first; a network response is cached **only** if
    `res.ok && res.type === "basic"` (same-origin), via the **single** `cache.put` in
    the file.
  - everything else (D/E/passthrough) → network-only, no `respondWith`.

### Updates never swap code mid-task
A new worker **installs and then waits** — it never calls `skipWaiting()` on its own, so
a user is never swapped to new code mid-drawing or mid-form. `SwRegister` detects the
waiting worker and shows an accessible, non-blocking bar — *"A new version of CrewFlow is
available. [Refresh]"* — and only on the user's click posts `{type:"SKIP_WAITING"}`,
after which exactly one `controllerchange`-driven reload occurs. First install activates
immediately (no waiting worker → no prompt).

### Rollback (rehearsed procedure)
Because a worker outlives the page that installed it, a bad worker can't be fixed by a
normal deploy alone — the fix has to reach already-installed workers. CrewFlow's
mechanism:

1. **Every cache name is versioned** — `crewflow-pwa-static-v1`, `crewflow-pwa-shell-v1`.
2. To ship a corrected worker, **bump `CACHE_VERSION`** (`v1` → `v2`) in *both*
   `public/sw.js` and `lib/pwa/cache-policy.ts` (the security test would fail if they
   diverge) and deploy.
3. Browsers byte-diff `/sw.js`, install the new worker, and on `activate` it **deletes
   every `crewflow-pwa-*` cache that isn't current** — the bad version's caches are gone
   with no user action.
4. **Kill switch / full retreat:** to remove the PWA entirely, deploy a worker whose
   `install`/`activate` calls `self.registration.unregister()` then
   `caches.keys().then(ks => ks.map(caches.delete))`. Because the old worker checks for
   an update on navigation, installed clients self-heal on their next online visit.

Rehearsed locally: `CACHE_VERSION` `v1`→`v2` on a running install shows the `v1` caches
deleted on activate and `v2` repopulated, with no manual storage clear. **The offline
shell is never the *only* copy of anything** — a bad shell degrades to the normal online
app the moment the network returns.

## The offline shell (`/offline`)
A **public** route (middleware-excluded, no auth) so it renders with zero connectivity
and is safely precacheable. When the app is launched or deep-linked with no network, the
SW serves this page instead of Chrome's error screen. It:
- reads the **offline identity marker** (last signed-in `userId+orgId` on this device),
- lists the drawings **that identity** downloaded (Programme E IndexedDB), and
- opens the **real** `BlueprintViewer` on the local bytes — same viewer, same pdf.js
  hardening, same OFFLINE-COPY banner, same "editing disabled offline."

It shows **no server-fetched data** — only what Programme E deliberately persisted.

### Why the viewer is a *static* import here (a real bug, fixed)
Next's App Router splits code **per route**. A `next/dynamic(() => import(viewer))` in the
offline route produces a **lazy chunk owned by that route**, only fetched when `/offline`
itself loads — which happens **offline**, too late to cache. Warming the viewer from the
*blueprints* route caches a *different* chunk. The offline shell therefore imports the
viewer **statically**, so it rides in the offline route's **own prefetchable chunk** that
`router.prefetch("/offline")` fetches online and the SW caches. pdf.js stays lazy (the
viewer `import()`s it internally) and the viewer only renders on user action, so the
public shell's SSR is unaffected. Without this, the shell listed drawings but painted a
blank canvas offline — proven and then fixed by the real-offline E2E.

### Warming — "Available offline" means *genuinely* openable offline
Saving a drawing for offline (`_offline-controls.tsx`) does a best-effort, time-bounded
warm **after** the verified byte write: `router.prefetch("/offline")` (shell route chunk),
`import("./_pdf-viewer")` + `import("pdfjs-dist")` (viewer + pdf.js), and a drained
`fetch("/pdf.worker.min.mjs")` (the render worker). All of these are class A/B, so the SW
caches them cache-first. It's **opt-in on download** — no eager per-page cost for users
who never save a drawing.

## Security model (honest)

The **new** attack surface Programme F introduces is the service worker's `CacheStorage`.
Everything below is about proving it cannot become a data-leak or a stale-auth path.

- **The SW caches ZERO private data.** By the allowlist, only class A (hashed static) and
  class B (public icons/shell/worker) are ever written. Navigations, `/api`, Supabase,
  signed URLs, session cookies and blueprint bytes are **never** cached. This is asserted
  three ways: unit tests on the classifier, a source-contract test on `sw.js` (single
  `cache.put`, gated on `isStaticAsset||isShellAsset` + `type:"basic"`; no
  `createSignedUrl`/`token`/`access_token`), **and a runtime browser test** that — after
  an authenticated download + browsing + API/blueprint/Supabase traffic — reads the actual
  `CacheStorage` and asserts **every** entry is an allowlisted public asset.
- **No private HTML replay.** Navigations are never cached; only the **public** `/offline`
  is served on failure. One user's authenticated page can never be replayed to another.
- **Account-switch (shared-device) safety.** Two independent controls, no new hole:
  1. the SW cache holds nothing user-identifying (above), so switching accounts exposes
     nothing through it; and
  2. the offline **document bytes** remain governed by Programme E — IndexedDB partitioned
     by `userId+orgId`, re-checked against the server-trusted identity on every read, and
     **purged on logout** before `signOut()`. The offline shell scopes its list to the
     **current** identity marker, so it never lists a previous user's drawings.
- **Signed URLs / tokens never enter any cache** — cross-origin is class D (never cached),
  and Programme E never persists a signed URL. Confirmed by grep-tests in both layers.
- **Scope + CSP.** The worker is same-origin `/sw.js`, scope `/`. The existing CSP already
  allows it — `worker-src 'self' blob:` covers both the service worker and the pdf.js web
  worker; `manifest-src 'self'` covers the manifest. **No CSP change was required.**
- **Middleware bypass.** `sw.js`, `/offline`, `/icons/**`, the manifest, `icon.svg` and
  `pdf.worker.min.mjs` are excluded from the auth middleware matcher, so they're served
  `200` to a logged-out visitor (an expired cookie must never 307-redirect the worker or
  the shell). Proven by an installability E2E.
- **Graceful degradation.** If the browser lacks or blocks service workers, `SwRegister`
  swallows the error and the app behaves exactly as before. The SW is a progressive
  enhancement, never a dependency.
- **Honest browser-storage stance.** As in Programme E, we do not encrypt caches (an
  at-rest key co-resident in the same browser is obfuscation, not security). The shell and
  caches hold **only public assets**; confidentiality of *documents* rests on the
  Programme E partition + logout purge.

## Manifest hardening
`display: standalone`, `start_url: /dashboard`, `scope: /`, `orientation:
portrait-primary`, theme/background `#0F172A`, and a full icon set — SVG (`any`), PNG
192/512 (`any`), and a dedicated **maskable** 512 (safe-zone padded) so Android adaptive
icons don't crop the logo. iOS installs from Safari's Share sheet without a service worker;
Android/Chromium get the install prompt.

## Testing
- **Unit (`__tests__/pwa/cache-policy.test.ts`, 11):** every class, deny-by-default,
  blueprint/api/cross-origin/non-GET never cacheable, the pdf worker **is** cacheable,
  versioned-cache invariants.
- **Security source-contract (`__tests__/security/pwa-worker.test.ts`, 9):** only
  static+shell cacheable; single gated `cache.put`; navigations network-first→`/offline`;
  no signed-URL/token identifiers; versioned caches + activate cleanup; **no install-time
  `self.skipWaiting()`**; manifest ships 192/512/maskable; logout clears identity + IndexedDB
  before `signOut`.
- **Real-offline E2E (`e2e/pwa-offline.spec.ts`, 4) — no mocks:**
  1. installability assets are public (`200`, correct MIME) to a logged-out visitor;
  2. the `/offline` shell renders logged-out;
  3. the **authenticated genuine-offline journey**: register + download → SW controls the
     page → **network truly cut** → offline shell lists the drawing → the **real viewer
     paints from IndexedDB** (OFFLINE COPY, "+ Add pin" disabled) → **cold** deep-link into
     an authenticated route recovers to the shell → reconnect restores normal operation;
  4. **adversarial** — after an authenticated download + browsing, the live `CacheStorage`
     holds **only** allowlisted public assets (no bytes/API/HTML/token/Supabase).
- **Regression:** the full blueprint suite (viewer/pins/markup/compare/offline, 14) stays
  green; the whole unit (4975) and security (3269) suites stay green.

### The Playwright real-offline lesson (why genuine offline needed care)
`context.setOffline(true)` cuts the **page** thread but **not** the service-worker thread —
the worker keeps reaching the network, so it never exercises its own offline fallback (a
subtle way to "prove" offline while never being offline). The authenticated journey
therefore cuts **both** threads with `context.route("**/*", r => r.abort())` **plus**
`setOffline(true)` (the latter also flips `navigator.onLine`). Only then does a cold
authenticated navigation genuinely fail and the SW serve `/offline` — the honest test that
first exposed the missing worker + viewer-chunk caching, which this programme then fixed.

## Cost
**$0 server idle cost** — no realtime/cron/queue/edge/Redis, no new dependency. The SW
*reduces* egress (static assets and the pdf worker served from the device on repeat
visits) and makes repeat loads faster.

## Known limitations / future
- **Offline READ only.** No offline authoring/sync (unchanged from Programme E).
- **`navigator.storage.persist()` not requested** — caches may be browser-evicted under
  pressure; surfaced honestly. A bad shell always degrades to the online app on reconnect.
- **A truly-never-reconnecting device** can't be remotely purged (the standard offline
  trade-off, as in Programme E). Logout purge + partition remain the enforceable guarantees.
- **No background sync / push** — out of scope for this foundation.
