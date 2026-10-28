# 02 — Cross-tenant / privilege-bypass audit (RLS · SECURITY DEFINER · Data-API grants · storage)

Auditor: principal DB-security review (read-only). Tree: `/Users/moetalibi/Code/web-main`, `origin/main` tip `aedb9279` (= live prod). No app code, migrations, or prod state was modified. All reasoning is from static reads + read-only greps of the repo and migrations.

## Summary / verdict

This is a mature, heavily-hardened multi-tenant codebase. The two systemic CI gates named in CLAUDE.md are present, non-vacuous, and wired to real-Postgres introspection — they close the SECURITY-DEFINER-org-RPC class and the Data-API-grant class *by construction*, not by spot fixes. Every request-reachable `createAdminClient()` path I sampled re-derives tenant scope from a trusted source (authed session via `requireOrgContext`, resolved API key's `orgId`, or the portal token chokepoint) and pins `org_id` (and, where applicable, `customer_id`) on every query. Storage signed URLs are generated only from ownership-verified rows.

**No CONFIRMED-REACHABLE cross-tenant read/write or privilege-escalation was found.** The findings below are defence-in-depth / test-coverage observations (P2–P3), all either THEORETICAL or fail-closed (deny, not expose).

### Counts

| Area | Total | Guarded / safe | Flagged |
|---|---|---|---|
| SECURITY DEFINER functions (migration files containing `security definer`) | 174 files (~190 distinct fns) | client-executable uuid-arg class **systemically gated** by `_introspect_secdef_org_rpcs()` + CI test; recent fns (20261237–40) statically re-verified guarded | **0** unguarded/un-allowlisted |
| `createAdminClient()` call sites (non-test) | 421 | request-reachable paths sampled across v1 API, customer portal, finances/photos/proof routes, server actions — all org/customer-pinned | **0** confirmed IDOR |
| Data-API grant discipline (migrations > baseline `20261230`) | 9 migrations | all new tables service-role-only or RPC-only; no blanket client grants anywhere in tree | **0** live; **1** P2 coverage gap in the guard test |
| Storage buckets / signed URLs | 14 signer sites | path always read from an ownership-verified row; byte-writes/deletes service-role; portal paths derived from token identity | **0** |

**CONFIRMED-REACHABLE P0/P1: 0.**

---

## What was verified (positive controls)

### 1. SECURITY DEFINER org-RPC class — systemically gated
- `__tests__/integration/rls/secdef-org-rpc-guard.test.ts` introspects the WHOLE class via `public._introspect_secdef_org_rpcs()` (migration `20261116000000_secdef_org_rpc_membership_guard.sql`). Class predicate (verified in the function body): `p.prosecdef AND 'uuid'::regtype = any(p.proargtypes) AND (anon or authenticated EXECUTE)`. Each member must either body-match the canonical `current_org_ids()` + `42501` guard, or sit in an explicit, reasoned `ALLOWLIST`. A new unguarded member fails CI.
- Effect tests additionally prove, over the real anon→PostgREST path, that the six historically-leaking fns (`next_po_number`, `next_certificate_number`, `next_grn_number`, `next_material_request_number`, `cis_statement_ledger_fingerprint`, `cis_monthly_return_ledger_fingerprint`) and the two state helpers (`purchase_order_receipt_state`, `material_request_fulfilment_state`) deny anon with `42501` and admit `service_role`.
- The introspection RPC itself is locked to `service_role` (revoke from anon/authenticated at create, re-asserted) with its own privilege-lockdown test — so it cannot become an attack-surface oracle.
- The newest report RPCs I read (`20261237`–`20261240`: `reports_top_customers_by_revenue`, `report_aged_receivables`, `report_aged_payables` [+ `is_org_admin`], `report_profit_labour_hours`, `report_profit_stock_cogs`, `reports_jobs_per_week`, `reports_revenue_per_month`) all prepend the canonical `current_org_ids()` + `42501` guard as their first statement and carry an explicit `grant execute ... to authenticated` (no anon grant — anon's `current_org_ids()` is empty ⇒ `42501`). All correct.
- No SECURITY DEFINER function keys tenancy on a non-uuid type (grep for `org*/slug/tenant ... text` params returned nothing), so the `uuid`-arg class boundary is complete for this schema's org-key convention.

### 2. Public API (`/api/v1/*`) — org-pinned + dark
- Single chokepoint `lib/public-api/guard.ts::guardPublicApiRequest` resolves the bearer to a `ResolvedApiKey` (revoked/expired re-checked against Postgres every call), enforces the exact per-resource scope, rate-limits by key id, and is gated behind the `FEATURE_PUBLIC_API_JOBS` flag (dark ⇒ 404 before auth).
- Every route pins `.eq("org_id", guard.key.orgId)` on the admin-client query, including the by-id read/update (`app/api/v1/customers/[id]/route.ts:114,149-150`): a foreign id returns 404 (no cross-org oracle) and updates zero rows. Per-route grep confirmed org pins present on all 14 routes.

### 3. Customer portal — single token authority + customer-level ownership re-checks
- `app/customer-portal/_helpers.ts::loadCustomerByPortalToken` is the ONE auth authority: UUID-shape check, `portal_token` lookup (and named-contact `customer_contacts.portal_token` path), expiry enforcement, fail-closed to null. It returns the token-resolved `customer.id` / `customer.org_id`; downstream never trusts a request-supplied id.
- Actions re-verify ownership with `org_id` **and** `customer_id` (not just org), closing within-org cross-customer IDOR:
  - `app/customer-portal/_thread-reply-action.ts:105-108` (ticket `id + org_id + customer_id`).
  - `app/customer-portal/_reports.ts:146-148` (`id + customer_id + org_id` + `isPortalVisible` defence-in-depth).
  - `app/customer-portal/_attachments.ts::verifyPortalAttachment` (flag + `ownsTarget` on `id + org_id + customer_id`).
  - `app/customer-portal/_customer-file-action.ts` and `_pay-action.ts` derive storage path, `org_id`, `customer_id` entirely from the token identity.

### 4. Authenticated server actions / routes — scope from session, not request
- `server/auth/session.ts::requireOrgContext` derives the active org from the authed session + an `active_org_id` cookie **validated against the caller's own memberships** (`getOrgForUser` → `loadMembershipsWithOrgs` with `.eq("user_id", userId)`); impersonation is re-validated server-side (super-admin + email match + 24h cap), never from the cookie alone.
- Admin-client actions pin `ctx.org.id` (e.g. `app/api/finances/route.ts`, `app/api/finances/[id]/route.ts`, `app/(app)/invoices/[id]/proof-actions.ts:56-57` which also `requireManagementRole` and pins `kind`). `portal_uploads` (RLS-enabled, zero client policies ⇒ service-role-only) is reachable staff-side ONLY through the org-pinned admin read.

### 5. Storage / signed URLs
- `app/api/jobs/[id]/photos/[path]/route.ts` and `.../photos/route.ts` pin the job by `id + org_id` (active-org pin, not merely RLS) and validate `storagePathBelongsToOrg(p, ctx.org.id)` before signing/deleting — blocks a crafted path segment.
- Portal download `app/customer-portal/[token]/documents/attachments/[id]/route.ts:39-49` signs only `verified.storage_path` from `verifyPortalAttachment` (ownership re-checked), TTL 60s, `Cache-Control: private, no-store`.
- All 14 `createSignedUrl(s)` sites read the path from a row already scoped by org (± customer); none sign a request-supplied path.

### 6. Grant discipline (Supabase 30-Oct change)
- `__tests__/security/migration-data-api-grant-guard.test.ts` enforces, from baseline `20261230000000`, that any new client-reachable table carries an explicit grant or a `data-api:exempt:` marker. Self-tests prove it both flags and clears.
- Post-baseline migrations are clean: `20261234` `hq_sales_sourcing_pool` / `hq_sales_sourcing_imports` are service-role-only (no client policy, no grant — correct); `20261237`–`20261240` add only guarded RPCs; no blanket `grant ... on all tables ... to anon/authenticated` exists anywhere in `supabase/migrations/`.

---

## Findings

### F-1 (P2, THEORETICAL, defence-in-depth) — Data-API grant guard only couples a policy to a grant within the *same* migration
- **File:** `__tests__/security/migration-data-api-grant-guard.test.ts:164` (`if (!created.has(table)) continue;`).
- **Mechanism:** The detector flags a missing client grant only when the `create table` and the client-reachable `create policy` live in the *same* migration. After 30-Oct-2026 a table CREATEd in migration A (> baseline) with no client policy gets no auto-grant; if a later migration B (> baseline) adds a client policy for `anon`/`authenticated` but no grant, B's policy is on a table not in B's `created` set, so the guard treats it as a grandfathered pre-existing table and clears it.
- **Reachability:** THEORETICAL and future-facing — no such split exists today (every post-baseline table is service-role-only). **Fail-closed if it ever occurs:** the runtime effect is PostgREST `42501` (feature breaks / read denied), i.e. a correctness break, **not** a cross-tenant exposure.
- **Smallest robust fix (no policy weakened):** extend the guard to also scan, for each migration > baseline, `create policy` statements whose target table was CREATEd in *any* migration > baseline (track the set of post-baseline-created tables across files) and require a grant or exempt marker in the migration that first makes it client-reachable. Pure additive test change.

### F-2 (P3, informational) — SECDEF presence-predicate is a body-string match; the authoritative proof is the integration/effect tier
- **File:** `_introspect_secdef_org_rpcs()` body — `guarded = functiondef ILIKE '%current_org_ids%' AND LIKE '%42501%'`.
- **Mechanism:** A function could in principle reference `current_org_ids` and the literal `42501` in a comment/non-gating position and still body-match. This is mitigated in the test suite by the EFFECT tests (anon denied `42501` over the real PostgREST path) for the fixed set, and by the allowlist requiring a human to vouch for anything that passes by other means. The residual risk is a *new* function that string-matches but is not actually gated and is not in the effect-probe set.
- **Reachability:** THEORETICAL; depends on the integration + security tiers actually running in the merge gate (CLAUDE.md states all four tiers run in `.github/workflows/ci.yml`). No current function exhibits this.
- **Smallest robust fix:** for any newly-added client-executable secdef-uuid fn, add it to an effect-probe list (anon ⇒ `42501`) rather than relying on the body-string lane alone. Optional hardening; current posture is already strong.

### F-3 (P3, by-design, informational) — Impersonation renders HQ super-admin as `role: "owner"` and relies on RLS to bound writes
- **File:** `server/auth/session.ts:414-439` (`loadOrgContextForImpersonation`).
- **Mechanism:** During a validated impersonation the HQ user is handed a synthetic `membership.role = "owner"` for the target org though they hold no membership row. The code's own comment notes writes are bounded only because RLS/policies refuse a user with no membership row; reads are "read-only-ish." This is a deliberate, server-validated, time-capped (24h) privileged path with a visible banner, gated by `isSuperAdminEmail` + `getActiveImpersonation`.
- **Reachability:** Not attacker-reachable (requires a super-admin account + an active, server-validated impersonation session). Flagged only so the trust-in-RLS assumption for this path is explicit and stays covered by the impersonation isolation tests.
- **Fix:** none required; keep the impersonation-isolation test coverage that asserts a synthetic-owner context cannot write target-tenant rows.

---

## Top 5 (most important first)
1. **F-1** — grant guard's same-migration coupling could silently miss a future split-migration client table (THEORETICAL, fail-closed to `42501`). P2.
2. **F-2** — SECDEF `guarded` body-string predicate is a presence check; authoritative proof is the effect tier (THEORETICAL). P3.
3. **F-3** — impersonation synthetic-owner relies on RLS to bound writes (by-design, super-admin-only). P3.
4. **Positive:** v1 API + customer portal + authenticated actions all re-derive tenant scope and pin `org_id`(+`customer_id`); no IDOR found across sampled admin-client paths.
5. **Positive:** storage signed URLs never sign a request-supplied path; all 14 signer sites read an ownership-verified row; byte writes/deletes are service-role-only.
