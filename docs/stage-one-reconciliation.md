> ⚠️ **STALE — superseded 2026-07-26.** Point-in-time Stage-One reconciliation. **Current
> canonical roadmap:** [roadmap/MASTER-ROADMAP-POST-20261037.md](./roadmap/MASTER-ROADMAP-POST-20261037.md)
> (+ [roadmap/STATUS.md](./roadmap/STATUS.md)). Kept for history only.

# Programme E — Stage One repository-grounded reconciliation

**Date:** 2026-07-21 · **Method:** independent 5-agent CTO audit (architecture,
database, backend, frontend, DevOps, security, performance, QA, product, UX,
construction-domain, technical-debt, documentation) + direct verification
against the repository and the live production database. Every claim below is
grounded in files / git / the prod DB, not prior reports.

## Verified baseline (facts)

| Fact | Value | Evidence |
|---|---|---|
| Production | **LIVE** at crewflow.uk | HTTP 200; Vercel prod Ready 2026-07-20 |
| `main` | `94eeea8` "reopen production after RC3 cutover" | git |
| `main` migrations | **170**, tip `20261007` | `git ls-tree origin/main` |
| **Prod** migrations | **171**, latest **`20261008`** | prod `schema_migrations` (read-only) |
| Unmerged (not in prod) | #398 (types + `20261008`), #399 (supplier bills `20261009`), #400 (payment allocation `20261010`), #401 (commercial lifecycle) | branch tips + CI |
| RLS coverage | **100%** (145 tables) | migration grep, 2 "gaps" were parser artifacts |
| SECURITY DEFINER search_path | **100% pinned** (150 fns) | verified 3 ways; 16 "unpinned" were false positives |
| Migration chain | clean; fresh-apply proven by CI + prod | no dup timestamps, monotonic |
| Forks | **none** | single payment ledger, single tenant audit log |
| TODO/FIXME/HACK | **0** | grep |

## The core failure: documentation truth, not code

The merged Stage One **code is largely real** and, for retention and variations,
**better-tested than the tracker claimed**. The failure was in the two tracker
docs, which (a) stated *"Nothing is in production yet"* when RC3 is **live**, and
(b) laundered four CI-green-but-**unmerged** branches (#398–#401) into "shipped".
That single inaccuracy cascaded — it hid a **live money-truth defect** and a
**security hole a later migration quietly closed**. All corrected this milestone.

## Findings → disposition

### Genuine gaps — FIXED this milestone (with real-Postgres proof)

| # | Finding (proven) | Fix |
|---|---|---|
| **F1** 🔴 | **Purchase orders reintroduced the cross-tenant FK hole** the team had closed for `invoice_payments` — `20261006` wires `supplier_id`/`job_id`/`purchase_order_id` as bare FKs with no org match and **no guard**; a writer could bind a PO to another org's supplier/job. **On prod.** | New guard `20261011_purchase_order_org_integrity.sql` (BEFORE INSERT/UPDATE, SECURITY DEFINER, pinned search_path) on `purchase_orders` + `purchase_order_line_items`; a trigger not a composite FK because the FKs are `ON DELETE SET NULL`. 3 integration cases. |
| **F3** 🟡 | **Retention no-over-release guard was not race-safe** — `tg_retention_release_guard` summed without locking the parent job (TOCTOU; two concurrent releases could exceed accrued). **On prod.** | `20261012_retention_release_concurrency.sql` adds `SELECT … FOR UPDATE` on the job (same pattern as the payment-allocation guard). 1 concurrency case (real Postgres). |
| — | **Dead module** `lib/customers/rollups.ts` (`computeCustomerRollups`) — zero call sites, superseded by the ledger-based customer page. | Deleted (module + test). |

### Genuine gaps — DOCUMENTED as tracked recommendations (not fixed here, to bound the reconciliation)

| # | Finding | Recommendation |
|---|---|---|
| S-F3 | **Portal invoice-PDF route** (`invoices/[id]/pdf/route.ts`) scopes ownership in JS after fetch-by-id (fail-closed, but the only portal read not scoped at the query level; no source-contract test). | Push scope into the query, or add a source-contract test pinning both JS checks. |
| P-5 | **Portal payment-proof upload** resolves ownership via `quote.customer_id` instead of the authoritative `invoiceCustomerId()` — a quote-less invoice (quote_id is SET NULL) blocks a legitimate upload. A test pins the stale check. | Use `invoiceCustomerId()`; update the pinning test. |
| DB-F2 | **Generated-types drift** — `lib/supabase/types.ts` (last regen 2026-07-16) declares 36 of 145 tables; ~575 casts across 167 files disable write-payload typing, and `tsc` is green **because** the casts blind it. #398 regenerates types but only to prod's schema. | Land #398 **with a CI gate** (`supabase gen types` + `git diff --exit-code`) so schema-without-types-regen fails the build; re-run after #399/#400. |
| A-1 | **No authenticated E2E anywhere in Stage One** — all asset E2E specs are auth-boundary stubs; Site Management has none. Honestly disclosed, but "gate 6 for the platform" oversells it. | Build the passwordless login harness (tracked #25), then author lifecycle E2E. Stop calling auth-boundary stubs "platform gates." |
| DBT-1 | **`round2` duplicated ×5**; **`lib/retention/` (customer-health) vs `lib/retentions/` (holdback)** naming foot-gun. | Consolidate `round2` into `lib/money`; rename one retention dir. (Deferred — touches many imports.) |
| SEC | CSP is **Report-Only** not enforcing; two non-constant-time secret compares; middleware fails-open with `requireOrgContext` as the real gate (no automated "every route gates" check). | Move to enforcing CSP + nonces; `timingSafeEqual`; add a route-gate lint. All low. |

### Roadmap / documentation inaccuracies — CORRECTED

- **`vision2030-stage-progress.md`** — rewrote "Standing reality" (production is LIVE, prod is 1 migration ahead of main, unmerged stack enumerated, the live outstanding-defect flagged); relabelled Financial Ops, Asset Management ("core complete; auth-E2E pending"), Portal (report-decision surfacing NOT shipped), and the Stage-Two execution kernel ("merged in RC3, dark in prod" — it is **not** unmerged); rebuilt the changelog with a PROD/UNMERGED status legend.
- **`roadmap.md`** — the memory-engine migrations (`20260722–20260728`) are in prod via RC3; the "prod migration gated" claim is resolved (corrected).
- **RC3 artifacts** (`RELEASE-MANIFEST-RC3.md`, `CTO-RELEASE-REPORT-RC3.md`, `CTO-BASELINE-VERIFICATION-RC3.md`, `PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md`) — marked **SUPERSEDED** (their "DO NOT MERGE/DEPLOY" language is a pre-cutover record). `CTO-RELEASE-REPORT-RC3.md` §3 cast count corrected to match its own §10 (292, not 216).
- **Accepted-quote immutability** — the original `20261004` freeze had an `accepted→sent→edit` bypass, closed by the **undocumented** `20261007` (re-keyed on `accepted_at`). Documented; the commercial brief's "shipped invariant" now points to the hardened version.
- Stale counts corrected (immutability tests 9→11; portal 7 tabs not 6).

### Documentation coverage gaps — one filled, rest tracked

- **Job Documents** — a SHIPPED, portal-exposed, security-sensitive subsystem (3 migrations on main, staff + portal UI, private/staff split) with **zero docs** (and a stale "not built" note in operator memory). **Filled:** `docs/job-documents.md`.
- Still undocumented (tracked): AI Receptionist engine, notifications system, payroll, review requests, support tickets, impersonation, the core financial base ledger, inbox/inbound.

## Positive confirmations (verified good — stated for balance)

RLS is 100%; SECURITY DEFINER search_path 100%; the migration chain applies cleanly on a fresh DB (CI + prod prove it); no forked systems; `tenant_attachments` CHECK is strictly monotonic (7→15 targets); the portal leak surface is closed (single token authority, query-level org+customer scoping, internal fields omitted from SELECTs, regression tests that fail on drift); impersonation is target-only in prod (BUG-05 closed); admin-client discipline is consistent across 324 sites with no unscoped tenant read; secrets are clean; the auth wall is enforced. Retention and variation lifecycles are genuinely end-to-end and DB-enforced. **No critical or high security vulnerability was found.**

## Bottom line

Stage One is in **markedly better shape than a trust-nothing prior would assume** —
the engineering discipline (DB-enforced invariants, RLS, no forks) is real. The
reconciliation closed one real cross-tenant integrity gap (F1), one concurrency
gap (F3), removed dead code, and — most importantly — **made the trackers tell
the truth**: production is live, the commercial fast-follows are built but
unmerged, and a known money-truth defect sits in prod until #401 lands. The
highest-leverage next action is not new features but **merging the unmerged
commercial stack (#398→#399→#400→#401→E)** so the fixes reach production.
