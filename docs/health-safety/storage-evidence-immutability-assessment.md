# Security assessment — H&S evidence storage-byte immutability

**Status:** assessment only (no implementation). Produced 2026-07-25 after the Toolbox Talks release (PR #422, prod main `69c32ce`, migration tip `20261030`).
**Question:** should "storage-object byte immutability" be the next security milestone, and how should it be built?
**Verdict:** **Yes — as a small, self-contained milestone.** The prevention fix is far cheaper and lower-risk than expected because the app already routes *all* storage mutations through the service role, so the offending policies are unused. Recommended: **Milestone 1 (prevention, ~½ day) then Milestone 2 (cryptographic tamper-evidence, ~1–2 days)**. Do **not** build the heavy cross-schema RLS option.

---

## 1. Verified threat model (from code, not assumption)

Bucket `tenant-attachments` (private, `public=false`, created `20260623`). Path scheme (`server/services/tenant-attachments.ts:96`):
`${orgId}/${targetTable}/${targetId}/${attachmentId}.${ext}`.

`storage.objects` RLS (`20260626000000_storage_rls_hardening.sql`) for `tenant-attachments`:
- SELECT — any org member (path segment 1 ∈ `current_org_ids()`)
- **INSERT — any org member** (org-scoped)
- **DELETE — org admin** (`is_org_admin(path segment 1)`)
- UPDATE — *no policy* → denied for authenticated (only service_role)

The Toolbox freeze trigger (`tg_tenant_attachment_freeze_delivered_toolbox`, `20261028`) freezes the **`tenant_attachments` row** once the target talk leaves draft — but does **not** protect the storage **object bytes**.

**Attack (verified reachable):** an org **admin**, via a crafted direct Storage API call with their own JWT (not the app):
1. `DELETE` the frozen evidence object at its known path (admin delete policy allows it), then
2. `INSERT` different bytes at the same path (member insert policy allows it).

The frozen row still points at that path; the signed-URL flow now serves the swapped bytes. The frozen `size_bytes`/`mime_type`/`filename` are the *only* tamper signal (weak: a same-size swap is invisible; no automated check exists).

**Root cause:** the app performs **every** storage mutation with `createAdminClient()` (service role) — upload, orphan-cleanup, delete, and even signed-URL creation (`tenant-attachments.ts:98/125/181`, `components/attachments/actions.ts:110`). The tenant-JWT INSERT/DELETE policies are therefore **dead weight the app never exercises**, yet they are exactly what opens the direct-API vector.

## 2. Blast radius

- **Actor:** org **owner/admin** (delete is the binding gate) — an *insider* at the highest tenant privilege. Not a worker, not external, not anonymous (bucket is private, signed-URL only).
- **Scope:** own org only (RLS path-prefix confines to `org_id`). **No cross-tenant** exposure. **No data loss to other tenants.** **No privilege escalation across orgs.**
- **Reachability:** **not through the app UI** (app deletes are gated by the freeze trigger + role check, and byte-writes go through service-role). Requires a deliberate, technical, hand-crafted Storage API request.
- **Surfaces affected:** the *shared* `tenant-attachments` bucket → toolbox-talk signed sheets **and** RAMS/permit/completion-cert/snag/site-diary/asset attachments. `compliance-docs` (admin-insert + admin-delete) has the same admin-swap shape.
- **Detectability:** frozen row `size_bytes`/`mime` mismatch (manual, partial). No cryptographic guarantee today.

**Severity:** genuine **P1-class evidence-integrity** gap for a platform now making compliance-evidence claims — but **insider-admin, own-org, app-unreachable, non-cross-tenant, partially-detectable**. **Not an emergency** (no external/anon exposure, no cross-tenant leak, no data loss). Priority **HIGH, not urgent**.

## 3. Should it be the next security milestone? — Yes

- The platform now ships four evidence surfaces live (toolbox talks, RAMS, permits, completion certs); "tamper-evident record an inspector can trust" is a stated promise. This gap undercuts it for insiders.
- It is **cheapest to close now**: prod has **0 H&S evidence rows**, so no hash backfill and no data migration for existing evidence.
- The prevention fix turns out to be tiny and low-risk (see Option D). High value / low cost ⇒ do it next.

## 4. Options evaluated & ranked

### ✅ Rank 1 — Option D: service-role-only destructive storage ops (PREVENTION)
Drop the unused authenticated **INSERT** and **DELETE** policies on `tenant-attachments` (and the admin INSERT/DELETE on `compliance-docs`). With no permissive policy, authenticated writes/deletes default-deny; **only the service role** (server-only, freeze-trigger-gated app paths) can mutate bytes. Keep SELECT (harmless; downloads already use service-role signed URLs anyway).
- **Why best:** closes the vector **entirely and platform-wide**, with **near-zero app risk** — verified that *all* app storage mutations use `createAdminClient()`, so nothing depends on the tenant-JWT policies. No cross-schema coupling, no per-target lifecycle logic, no path-parsing-in-RLS fragility, no per-delete performance cost.
- **Residual:** prevention only (no proof-of-integrity if the service-role path itself were ever abused) → covered by Option C.
- **Effort:** ~½ day incl. tests.

### ✅ Rank 2 — Option C: per-attachment sha256 frozen as evidence (DETECTION / non-repudiation)
Mirror the existing **`blueprints.ts`** precedent: compute `createHash("sha256")` of the bytes on upload, store `content_sha256` on `tenant_attachments` (immutable), and verify (re-hash) on PDF render / an audit path.
- **Why:** makes any byte swap **cryptographically detectable and provable** — the evidentiary property a court/HSE inspector actually wants; complements D (defence-in-depth even against a future service-role-path bug). Proven pattern already in the repo → low novelty risk. Uniform across all attachment targets.
- **Design notes:** the hash must be immutable — set on insert, then frozen (extend the freeze trigger to cover `content_sha256`, or reject updates to it). Because toolbox allows **appending** attachments after issue, the hash must live on the **row** (per-attachment), not only in the issue-time snapshot.
- **Effort:** ~1–2 days (column + upload hash + immutability guard + a verify surface + tests).

### ⚠️ Rank 3 — Option A: RESTRICTIVE `storage.objects` policy freezing delivered-evidence bytes
A restrictive DELETE/UPDATE policy that denies when the object's target record is frozen.
- **Why not primary:** achieves the same prevention as D but with **far more coupling and risk** — a storage-RLS function that parses the object path and joins to `toolbox_talks`/`risk_assessments`/`permits_to_work`/`completion_certificates`, each with its own "frozen" definition; per-delete performance cost platform-wide; a bug could block legitimate deletes. D gets the same result by *removing* surface instead of *adding* it. **Keep only as a fallback** if some future feature genuinely needs tenant-JWT storage writes (none does today).

### ❌ Rank 4 — Option B: immutable/versioned object keys
Keys are already unique random UUIDs; the vector is delete-then-reinsert at a chosen key, which versioning doesn't prevent. At best a detection side-effect (a swap 404s). **Fold the "never reuse a key" idea into C**; not a standalone fix.

## 5. Recommended milestone plan

### Milestone 1 — "Evidence bytes are service-role-only" (do first)
**Migration plan** (`20261031…_storage_evidence_service_role_only.sql`, additive/reversible):
- `drop policy "tenant-attachments: members can insert"` and `"tenant-attachments: admins can delete"` on `storage.objects`.
- `drop policy "compliance-docs: admins can insert"` and `"compliance-docs: admins can delete"`.
- Leave SELECT policies intact. Add a header documenting that all byte mutation is service-role-only, gated by the app's freeze triggers + role checks.
- **Pre-flight:** confirm (grep already done) no tenant-JWT storage write/delete/upsert anywhere; confirm no browser-direct-to-storage upload (uploads go through server actions). Re-verify before shipping.

**Regression-test plan:**
- Integration (real Postgres + storage): as an **admin JWT**, a direct `storage.from('tenant-attachments').remove([path])` and `.upload(path,…)` must now **fail** (RLS denied). As a **member JWT**, insert must fail.
- App happy-path unaffected: `uploadTenantAttachment` → row+object created; `getAttachmentSignedUrl` → signed URL resolves; `deleteTenantAttachment` on a **draft** target → row+object removed; on a **frozen** target → row delete blocked (existing freeze test) so bytes are never reached.
- Security source-contract: assert the two buckets have **no** authenticated INSERT/DELETE policy.
- Regression sweep: compliance-docs upload/download/delete still work through the app (service role).

### Milestone 2 — "Cryptographic tamper-evidence" (fast-follow)
**Migration plan:** add `content_sha256 text` to `tenant_attachments`; extend the evidence freeze to make it immutable once set (and for frozen targets). Backfill unnecessary (0 evidence rows in prod today).
**App plan:** in `uploadTenantAttachment`, `createHash("sha256").update(bytes).digest("hex")` → persist on the row (mirror `blueprints.ts`). Expose/verify on the evidence PDF footer and/or a re-hash audit endpoint.
**Test plan:** unit (hash is deterministic + stored); integration (hash immutable — update rejected on a frozen row); a verify test that a byte swap through the service role is caught by hash mismatch; PDF/evidence surface shows the digest.

## 6. Non-goals / guardrails
- Do **not** change live RAMS/permit **lifecycle** semantics; this milestone is storage-layer only (it protects their attachment bytes without touching their DB lifecycle).
- Do **not** build Option A's cross-schema storage-RLS unless Milestone 1's pre-flight uncovers a real tenant-JWT storage dependency.
- Do **not** regenerate `types.ts` opportunistically.
- Ship migrate-first, CI-green, **no merge/deploy without explicit authorization** (production is `69c32ce`).

## 7. One-line recommendation
Make **Milestone 1 (Option D)** the next security milestone — a tiny, verified-safe, platform-wide closure of the insider byte-swap vector — immediately followed by **Milestone 2 (Option C)** for court-grade tamper-evidence, reusing the `blueprints.ts` sha256 pattern.
