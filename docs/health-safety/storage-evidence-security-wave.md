# Storage evidence security wave — implementation record

**Branch:** `feat/storage-evidence-security-wave` (off prod `69c32ce`). **Unmerged, undeployed.**
Migrations `20261031`–`20261034`. 14-agent audit + build; a second adversarial wave follows.

## What shipped

### S0 (P0) — cross-tenant read fix `20261031` + app signer guards
The audit's red-team found a **live prod cross-tenant read primitive**: the signed-URL minters
(tenant-attachments, compliance-docs, blueprints, job-docs) sign `row.storage_path` on the
service-role client after only an RLS row-read, and the backing tables gate INSERT on `org_id`
only — nothing binds `storage_path` to the org. A member could insert an org-A row pointing at
an org-B object and mint a signed URL for it (precondition: knows the path, which leaks in any
shared 60s URL). **NOT introduced by this wave — present in prod today.** Fixed in both layers:
a JWT-gated BEFORE INSERT/UPDATE trigger on all four tables (`split_part(storage_path,'/',1) =
org_id`), plus a `storagePathBelongsToOrg` guard in every signer (covers pre-existing rows;
job-docs also pins the signing bucket to an allowlist).

### S1 — storage mutation lockdown `20261032`
Every app storage byte-mutation uses the service role; the authenticated `storage.objects`
INSERT/UPDATE/DELETE policies on all 8 buckets were **dead code that opened the byte-swap
vector**. Dropped → default-deny mutation → service-role-only (mirrors `portal-uploads`). SELECT
policies left untouched (job-photos' gallery genuinely uses tenant-JWT reads).

### S2 — content_hash + universal write-once immutability `20261033`
SHA-256 of the exact uploaded bytes, frozen as evidence metadata (well-formed-hex CHECK; mirrors
the `blueprint_versions` precedent, hardened). A **universal** BEFORE UPDATE trigger makes
`content_hash`/`storage_path`/`size_bytes`/`mime_type` write-once for **every** target (the prior
freeze was toolbox-only — a real gap for snag/site-diary/inspection photos), composing with the
toolbox freeze. Hashing overhead is negligible (<1 ms–9 ms per file).

### S4 — RAMS draft→terminal integrity fix `20261034`
Closed the same forgery-bypass class the toolbox P0 (20261030) fixed: a draft RAMS could be
PATCHed straight to `withdrawn`/`superseded`, skipping the issue gate. Now a draft may only be
issued or edited. **Integrity fix, not a role change.** Permits were verified clean (their
lifecycle trigger enforces the full transition matrix, rejecting `draft→closed`).

## Open decisions surfaced to the CEO (deliberately NOT decided here)

1. **RAMS/permit terminal-transition authorization (product policy).** The directive framed this
   as a "parity gap," but the audit found RAMS *and* permits are **member-level in both app and
   DB today** (unlike toolbox, whose app already required owner/admin — which is why 20261030 was
   a transparent backstop). Admin-gating RAMS withdraw/supersede or permit close/cancel would
   **change live product policy**, which directive §19 ("enforce product policy, don't replace
   it") and §31 ("stop if product policy is ambiguous") forbid me to do unilaterally. Domain note:
   on-site permit close by a non-admin *responsible person* is a legitimate pattern. **Positive
   regression tests pin the current member-level behaviour** so any change is deliberate. If you
   want the toolbox standard applied to RAMS/permits, that's a one-migration follow-up (mirror
   20261030: `is_org_admin` gate on the terminal transitions + app `isManager` gate + hide the
   buttons) — say the word.

2. **GDPR / org-teardown storage erasure.** Delivered toolbox evidence is currently un-deletable
   through any app path while the org exists (the freeze blocks all roles), and there is **no
   customer-account-deletion routine** — the only org-DELETE call sites are demo/bootstrap
   rollback, and even those cascade only DB rows, leaving storage **bytes orphaned** (storage
   isn't FK-linked to orgs). A real "erase my data" request has no supported mechanism today. This
   needs a deliberate GDPR/teardown design (a service-role erasure path that sweeps storage) — a
   product/legal decision, tracked as the next milestone.

## Deferred (assessed, no code)

- **S3 evidence manifest** — S2's per-file `content_hash` + universal immutability already deliver
  byte tamper-evidence platform-wide; a manifest frozen into each issue snapshot would be
  redundant for detection and would fork four evidence domains. Deferred.
- **Download-time verification** — store-on-upload only; verify at evidence-export time (not
  on-render: signed URLs stream bytes straight from Storage, so per-view re-hash = recurring
  egress). No cron, no proxy.
- **content_hash NOT NULL** — kept nullable for historical rows (no backfill / no re-upload of
  customer files); new evidence is always hashed by the upload path.
