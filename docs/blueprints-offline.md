# Blueprint Offline Read (Programme E)

Construction crews work in basements, plant rooms, and half-built structures where
signal drops. Programme E lets a user **download an authorized drawing for offline
use** so the **real** blueprint viewer renders it from local bytes with no
connectivity — and does so without weakening the online security model. It is
**offline READ only** (download + view). Offline authoring/sync is explicitly out
of scope. **Zero Supabase migration, zero new runtime dependency, zero server cost.**

## Architecture — pure IndexedDB, one atomic record

`lib/blueprints/offline-store.ts` stores each cached revision as **one IndexedDB
record = `{ metadata + Blob }`** in a single object store (`crewflow-blueprints-offline`
→ `drawings`). Chosen over IndexedDB-metadata + Cache-API-bytes (no cross-store
transaction → partial-write hazard; Cache API has no node test fake) and Cache-API-only
(can't answer "is this cached for the current user?" cheaply). One store gives an
**atomic write** (metadata + bytes commit together or not at all), native Blob
storage (disk-backed — not pinned in the JS heap, iOS-safe), and full testability
under `fake-indexeddb`.

- **Document data needs no service worker.** Offline **document data** (Programme E) is
  served from IndexedDB by the already-loaded page. The offline **app shell** (a cold
  no-network launch) is a separate PWA concern, now shipped as **Programme F**
  (`docs/pwa.md`). Crucially, Programme F's service worker **still never caches the
  document bytes** — they remain owned by this IndexedDB store (cache class E =
  never-cached). The two layers compose without the SW ever touching private bytes.
- **Split for testability:** pure helpers (`offlineKey`, `recordMatchesPartition`,
  `isValidOfflineMeta`, `buildOfflineMeta`, `hasRoomFor`, `bytesToHex`,
  `isOfflineSupported`) unit-test with no IndexedDB; the async adapter
  (`put/get/getByVersion/list/remove/clearForUser/clearAll`) tests via `fake-indexeddb`.

## Storage model
- **Metadata** (`OfflineBlueprintMeta`): schemaVersion, userId, orgId, blueprintId,
  versionId, version, revision, revisionDate, drawingName, fileName, mimeType,
  sizeBytes, sha256, downloadedAt, currentAtDownload. **Nothing else** — no customer/job PII.
- **Bytes**: a `Blob` (the authorized drawing), keyed with the metadata in one record.

## Security model (honest)
- **Never persisted** (grep-enforced by `__tests__/security/blueprint-offline.test.ts`):
  signed Supabase URLs, auth/refresh tokens, session cookies, service-role, magic-link
  codes, storage paths, secrets. We store **bytes + safe metadata only** — a signed URL
  is temporary authorization, not an offline identifier.
- **Partition by `userId + orgId`.** Key = `${userId}::${orgId}::${versionId}`. Keying
  by `versionId` alone would leak across users on a **shared device** (IndexedDB is
  origin-scoped, not session-scoped). Every read re-checks `recordMatchesPartition`
  against the **server-trusted** current identity (from `requireOrgContext`, threaded as
  a prop — never read from stored data), so a tampered local record can't cross the user
  boundary. Proven: another user/org reads `null`.
- **Two-authority model.** Online, **RLS is the authority** — the viewer does its normal
  RLS-gated fetch first; the cache is fallback-only, never an authorization bypass (a
  cross-tenant version 404s and never falls through). Offline, the **partition guard +
  logout purge** are the authority.
- **Logout purge (the load-bearing shared-device control).** A server action can't touch
  IndexedDB, so `app/(app)/_components/sign-out-button.tsx` (a client wrapper on the real
  logout in both `(app)` and `onboarding` layouts) calls `clearAll()` **before** the
  server `signOut()`. Proven by E2E: download → real Sign out → `/login` → **IndexedDB empty**.
- **Honest browser-storage stance (§20):** CrewFlow does **not** encrypt IndexedDB.
  Confidentiality rests on OS/browser-profile isolation + app-level partition + the logout
  purge. We deliberately **do not** add app-level crypto with a key co-resident in the same
  browser (that is obfuscation, not security). The enforceable shared-device guarantee is
  precisely: **after a user signs out, their cached bytes are gone.**
- **Membership revocation (§21, documented limitation):** a **truly-offline** device
  cannot be remotely purged. Online, revocation is immediate (the RLS-gated fetch 404s;
  the cache is never an authorization path). On reconnect, auth/membership validation
  gates access. A never-reconnecting device retains its cache until logout or a future TTL
  eviction — the standard offline-first trade-off, stated plainly.

## Download flow (§9, §10)
Register-card control (`_offline-controls.tsx`): **Download for offline** → fetch the
current revision's bytes via the existing RLS-gated `/jobs/[id]/blueprints/f/[versionId]`
route → size cap (reuses `MAX_BLUEPRINT_BYTES`, 50 MB) → **quota check**
(`navigator.storage.estimate()` with a one-drawing margin; `QuotaExceededError` caught) →
SHA-256 (`crypto.subtle`) → **atomic** IndexedDB write → refresh UI. States:
Not downloaded · Downloading… · **Available offline** · Storage full · **Offline copy
outdated** (stale) · Removing… · Removed · Download failed (retry). "Available offline" is
shown **only after** the verified write.

## Viewer integration (§14, §15, §16, §26)
- **One byte source.** `lib/blueprints/byte-source.ts` `loadBlueprintBytes()` is
  **online-first**: it does the same `fetch(src, {credentials:"same-origin"})` and only on
  a genuine failure falls back to the cached bytes for this user+org+version. With nothing
  cached and `preferOffline` false, it is byte-identical to the previous behaviour — the
  online path is unchanged. `navigator.onLine` is a **signal** (prefer-cache fast-path), never a gate.
- **Same viewer, same hardening.** The bytes flow into the identical pdf.js
  `getDocument({ isEvalSupported:false, enableXfa:false, disableAutoFetch:true })` +
  worker + canvas caps. No second viewer, no loosened config.
- **OFFLINE COPY indicator** (not colour-only): a `data-offline-copy` banner
  "⤓ OFFLINE COPY · Rev C · Editing is unavailable offline." when rendered from cache.
- **Editing disabled offline (§26):** "+ Add pin" and "✎ Markup" are `disabled` when
  offline / showing a cached copy — pins/markup are server mutations that would fail or
  anchor to a stale copy. Online authoring is unchanged.
- **Integrity:** on read, the stored bytes are re-hashed vs `sha256` (+ size); a corrupt
  record is evicted and the viewer falls through to the network/error path.

## Stale revision (§17)
The register island compares the cached `version` to the drawing's current version. If an
**older** revision is cached: "⚠ Offline copy: Rev C. Rev D is now current." + **Download
Rev D** + **Remove** — never silently replaces or deletes Rev C (a site user may need the
historical copy). One revision per drawing is cached; replacement is explicit.

## Annotations offline (§27)
Deliberately **document bytes only**. Pins/markup require connectivity (they are
version-scoped DB reads); offline the viewer shows the drawing with editing disabled.
Caching an annotation snapshot is a bounded future extension, not shipped here.

## Mobile + accessibility (§24, §25)
44px controls, `aria-live` status, `role="alert"` errors, indicator carries meaning in
text (not colour), keyboard-operable Remove. No horizontal overflow.

## Testing
- **Unit (26):** cache key + user/org partition, metadata validation, schema-version guard,
  quota decision, checksum/`bytesToHex`, integrity-evict, remove, `clearForUser`/`clearAll`
  (logout), `too_large`, unsupported-API fallback, and the online-first `decideByteSource`.
- **Security (8):** partition rejection, never-persist grep (no URL/token/path/service-role),
  keyed-by-user+org+version, integrity-on-read, online-first (cache never an auth bypass),
  logout purge wired before `signOut`, both layouts use `SignOutButton`.
- **Authenticated E2E (`e2e/blueprint-offline.spec.ts`, via the #409 harness — no fixme):**
  (1) logged-out boundary; (2) **download → Available offline → real bytes in IndexedDB →
  block the `/f/` route → the real viewer paints from cache → OFFLINE COPY → editing
  disabled → Remove → honest error card when removed** (zero unexpected console errors);
  (3) **Sign out purges the cache** (shared-device gate). The offline trigger is a Playwright
  route-block of `/jobs/*​/blueprints/f/*` (isolates offline document data from the app shell).
- **Regression E2E:** the viewer/pins/markup/compare authenticated journeys stay green.

## Cost (§36)
Browser storage: **$0 server idle cost**, no realtime/cron/queue/edge/Redis. Offline
re-opening **reduces** repeated Supabase Storage egress (bytes served from the device).

## Known limitations / future
- ~~No offline app-shell (cold no-network launch)~~ — **shipped as Programme F**
  (`docs/pwa.md`): a PWA service worker serves a public `/offline` shell that opens this
  same viewer on the device's downloaded drawings, with a strict deny-by-default cache
  allowlist that never caches the document bytes.
- No offline authoring/sync — later roadmap (the pin/markup models are already
  client-id/idempotency-friendly for it).
- `navigator.storage.persist()` not requested — cached data may be browser-evicted;
  surfaced honestly rather than promised.
- Account-switch purge is covered by the logout purge today; a belt-and-suspenders
  `onAuthStateChange` listener is a small future add.
- One cached revision per drawing (explicit replacement).
