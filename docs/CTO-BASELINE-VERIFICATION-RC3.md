# CrewFlow — CTO Baseline Verification & GO/NO-GO (RC3)

**Independent re-verification pass.** Every prior report (including my own) was treated as untrusted; findings below are from Git, file reads, locally-executed gates, and 12 parallel read-only specialist agents. **Constraint disclosed up front:** 6 of 12 agents completed cleanly; the other 6 terminated early on a hard **account monthly spend limit** (not a code fault), each after emitting a key partial finding. Where a claim rests on the prior full audit rather than this pass's independent re-run, it is marked. The candidate under review is **RC3 = `release/rc3-full-platform` (PR #397 → `main`), DO NOT MERGE / DO NOT DEPLOY.**

## 1. Executive summary
RC3 is independently re-confirmed as a coherent, CI-green, migration-safe production baseline. **No new release blockers were found.** The independent pass verified the highest-risk items directly: RC3 is a true superset of `main` (airtight ancestry), the `20261007` security fix genuinely closes the accepted-quote side-channel, the previously-unaudited CX/onboarding cluster is wired + tested + non-duplicative, and 8,067 tests execute green locally. The findings that emerged are **minor** (one doc-accuracy correction made here; three low-severity consistency items) and none blocks the baseline. **Recommendation: conditional GO** to a human go/no-go review of PR #397.

## 2. Repository topology (Agent 1 — verified)
`origin/main` `ed6b6ee` **100 migs** → `origin/directive/018-r6` `dc155f4` **151 migs** → `origin/release/rc3-full-platform` `a41aee2` **170 migs**. RC3 is **398 commits ahead of `main`, 0 behind**; `git merge-base --is-ancestor origin/main HEAD` = 0 and every one of main's 100 + directive's 151 migrations is contained. Correction to my earlier wording: RC3 is a **containment superset preserving ~180 merge commits** (full PR history), not a linearized branch — verified by ancestry, which is airtight. CX #364–366 present (commits + files); all three release-recovery fixes present; WhatsApp #360–362 and telephony #113 provably absent.

## 3. Branch strategy
One candidate branch → `main`, superseding the stale RC2 #375 (stopped at #374/158 migs) and RC #363. No unnecessary release branches created; **RC3 is kept** (no RC4 needed — the audit found it current and correct).

## 4. PR inventory (Agent 9 — partial; prior audit + this pass)
~58 open PRs. Disposition: the linear feature set #367–#396 + directive chain + #187/#188 are **in RC3** (close as included on merge); **close as superseded** #119, #182 (content byte-identical in main/stack); **close as release-meta** #363, #375; **close as obsolete** #171, #268, #267; **defer** #360–362 (WhatsApp — migration-timestamp collision), #113 (failing CI + phone = product decision), #121/#128/#136/#137/#148 (re-date/conflict/feature-freeze). Agent 9 independently confirmed #121's `detect.ts` is the *full* entity-detector (genuinely pending, not superseded). *I cannot fully re-verify all 58 this pass (agent hit the spend limit); the disposition rests on the prior full archaeology + these spot-confirmations.*

## 5. Migration inventory (Agent 2 — partial; prior audit)
170 files; **0 duplicate timestamps**; 70 new, all timestamped after main's applied max. `tenant_attachments.target_table` CHECK grows monotonically to **15 targets, none dropped**. One irreversible: `20260812` (LR5.4B). Agent 2 independently re-confirmed **63 SECURITY DEFINER functions, 0 missing `set search_path`** before terminating. *Full dup-timestamp/ordering/destructive re-scan this pass was cut short by the spend limit; those specifics rest on the prior full migration audit, which the green CI integration gate (applies all 170 on fresh Postgres) corroborates.*

## 6. Security review (Agents 3 partial, 10, 12 — verified)
**PASS, no CRITICAL/HIGH.** The independent pass directly re-derived the highest-value item: **the `20261007` fix genuinely closes the `accepted→sent→edit` side-channel** — Agent 3 confirmed the accept flow's single UPDATE (actions.ts ~885–893) sets `status`+`accepted_at` while `old.accepted_at IS NULL` (idempotency guard), so the freeze skips correctly, and the freeze now keys on `accepted_at IS NOT NULL` (+ freezes `accepted_at`). Agent 10 confirmed retention over-release + immutability triggers and generated invoice/PO totals are DB-enforced; Agent 12 confirmed site-report snapshot immutability (DB trigger) + portal org∧customer scoping. Money is `numeric` throughout (no float). LOW items carried: committed **anon** key in a seed script (public-by-design), polymorphic `target_id` not same-org FK-checked (no cross-tenant leak). *The full RLS-per-table + portal sweep this pass was cut short (spend limit); it rests on the prior full security audit (133 tables RLS-enabled) plus Agents 10/12's chain-level confirmations.*

## 7. Architecture review (Agent 4 — verified, complete)
**MINOR-DEBT.** All **13 single-system checks PASS** — customer directory, portal auth, attachment pipeline, notification engine, approval engine, draft engine, audit engine (dual-plane by design), money engine, supplier model, asset model, report model, QR identity — with **no `supplier_bills` fork** (committed spend vs actual `finances` cleanly separate, grep-verified). Client/server boundary disciplined (`import type` + `server-only`); the two claimed fixes (qr-token `server-only`, qr.ts isomorphic) are real. **CX cluster independently assessed:** `sample-data.ts` is a single idempotent seed authority (no duplication of demo-lifecycle); `onboarding/checklist` is a clean vertical. **One real minor drift found:** `lib/comms/readiness.ts` re-derives "is email configured" from raw env instead of reusing the canonical `isEmailConfigured()`, so `/api/health` can report email *ready* while the send-gate is *off* (`COMMS_EMAIL_PROVIDER=off`). Low severity; logged as tech-debt (below).

## 8. Test coverage (Agent 5 — verified, executed)
**STRONG.** Agent 5 executed the gates itself: **typecheck exit 0, lint 0 errors, unit 4,855 pass, security 3,212 pass = 8,067 tests green locally, 0 failures, 0 skips.** Suite hygiene excellent (no `.only/.todo/xit`; one benign fail-loud harness skip; one cosmetic sentinel). The **`20261007` hardening test is present with 11 cases** including the two new side-channel proofs (read-verified). **The CX gap concern is disproven** — comms-readiness (10 cases, ran green), sample-data (3 integration cases), onboarding (checklist/system/auth-flow, all unit green) all have real tests. *Integration (~820) and e2e (17) tiers need live Postgres/app env and were verified by reading + CI, not local execution.*

## 9. Performance review (Agent 6 — partial; verified)
**READY.** Agent 6 confirmed all 8 new RC3 list pages are explicitly bounded (snags/diary/toolbox/site-reports/PO = `.limit(500)`, assets 1000, inspections 100/400/200, holdings 300) — the PO `.limit(500)` fix is present. Only two genuinely unbounded queries remain, both over naturally small data (per-org inspection-template library; single-ticket message thread). FK indexes on new tables solid. *Full npm-audit/env re-scan cut short by spend limit; rests on prior audit (only `qrcode` added, 0 new vulns).*

## 10. Documentation review — one correction made
Release docs present and largely accurate (RELEASE-MANIFEST-RC3, PRODUCTION-DEPLOYMENT-RUNBOOK-RC3, CTO-RELEASE-REPORT-RC3, updated purchase-orders.md + tracker). **Correction (this pass):** my earlier docs stated "216 `as never` casts / 106 files"; the **verified figure is 292 `.from(...as never)` casts, 556 total `as never`, across 165 files** — a ~2.4× undercount, now corrected in the manifest and here. `docs/purchase-orders.md` committed-cost status is correct. No doc references a non-existent feature.

## 11. Technical debt (register)
1. **Stale `lib/supabase/types.ts`** (frozen ~`20260527`; 0 of the new tables typed) → **292 `.from(...as never)` casts / 556 total / 165 files.** Runtime-safe, compile-time DB safety lost platform-wide. Regenerate post-cutover (needs DB). *#1 debt.*
2. **Comms-readiness drift** — `/api/health` can disagree with the real send-gate; unify on `isEmailConfigured()`/`isSmsConfigured()`.
3. **Audit-surface split** (Agent 10) — PO/retention actions record to `admin_activity_log` (HQ, no RLS) rather than the tenant `activity_log`, so they don't surface in the org's own activity feed. Append-only + functionally harmless; consistency fix.
4. **Quote money precision** (Agent 10) — `quotes`/`quote_line_items` money columns are bare `numeric` (app-rounded) while invoices/POs/retention use `numeric(12,2)` + generated totals; `quotes.total` is app-maintained, not DB-generated.
5. `lib/retention` vs `lib/retentions` naming; ~5 inline `Math.round(x*100)/100` vs `lib/money.round2`; duplicated portal-token UUID regex.

## 12. Release risks
LR5.4B irreversible column drop (mitigated: pre-snapshot, no live reader, named auth). Single prod DB, no staging (mitigated: PITR + additive migrations + app-first rollback). Inherited npm advisories (pre-existing on main; not branch-gating). **The spend limit itself** blocks completing the remaining independent agent re-verification — a human action (raise limit) if full re-run is wanted.

## 13. Production readiness
**READY with named gates.** Env: 3 hard-required + `CRON_SECRET`/service-role operationally required (without `CRON_SECRET` all 19 crons 401). 19 authenticated crons, 7 declared storage buckets, 4 dark flags (default false, verified). Deploy + rollback procedure in the runbook. Types-regen recommended post-cutover.

## 14. Remaining blockers
**None technical for RC3 itself** — CI is green (8/8), no CRITICAL/HIGH security, no migration collision, no architectural violation. **Human-owned gates** (not engineering): LR5.4B authorization; production credentials/flags; first-cut scope decision for WhatsApp/telephony. **External:** the spend limit gates finishing the remaining independent re-verification.

## 15. GO / NO-GO recommendation
**CONDITIONAL GO** — proceed to a human go/no-go review of PR #397. The engineering artifact is verified production-ready; the conditions are the human decisions in §14, not code work. No NO-GO condition (blocker) was found in this independent pass.

## 16. Immediate next steps
1. Human: authorize LR5.4B; set prod env/secrets; confirm flags dark.
2. Merge PR #397 per the runbook (dry-run → apply 70 migs watching `20260807`→`20260812` → deploy → smoke).
3. Post-cutover: regenerate `lib/supabase/types.ts`; close the superseded/obsolete PRs (§4).
4. Optional fast-follows: comms-readiness unification; audit-surface consistency; the deferred PRs (re-dated).

## 17. Stage One completion — estimate ~92%
*Estimate, honestly labeled — not a precise metric.* All core operator verticals are shipped, wired, and tested: CRM (leads/customers), jobs, quotes+approval+accept, invoices+payments+reconcile, expenses/finances/tax/payroll, **Site Management** (snags/diary/toolbox/site-reports), **Asset Management** (M1–M5), **Commercial** (variations/immutability/retention/POs/committed-cost), **Customer Portal**, onboarding/CX, compliance, reviews, imports, reports/insights. Remaining ~8%: payment allocation, supplier bills (extend `finances`), the type-safety debt, and polish. **Stage One is substantially complete.**

## 18. Stage Two completion — estimate ~40% built / 0% activated
*Estimate.* Substantial AI substrate exists **dark**: HQ AI employee framework, Capability Registry, Voice Receptionist conversation engine, AI-reply pipeline, semantic memory, WhatsApp **inbound**. But it is **effect-free and unactivated** (flags default false; several pieces need external credentials + product decisions), and the outbound/autonomy layers (WhatsApp #360–362, telephony #113, booking execution) are deferred. So Stage Two is meaningfully *built* but **0% live** and gated on decisions outside engineering.

## 19. Long-term roadmap
Post-baseline: regenerate types; payment allocation + supplier bills; unified commercial lifecycle timeline; authenticated E2E harness (unlock lifecycle specs). Stage Two activation (receptionist autonomy, WhatsApp, telephony) behind product decisions + credentials, one dark→live flag at a time with the existing review/audit rails. CIS/HMRC/regulated accounting remains explicitly out of scope pending a CEO decision.

## 20. CTO recommendation
**Adopt RC3 as the production baseline via a human go/no-go on PR #397.** The independent re-verification — as far as the spend limit allowed it to run — found the candidate genuinely production-ready and surfaced no blocker, only minor non-blocking debt (the largest being stale generated types, a clean post-cutover fix). Do not build a new feature until this baseline is merged. If full independent re-verification of the remaining domains (migrations, security sweep, deps, docs, assets, PR archaeology) is required before sign-off, raise the account spend limit and re-run those six agents; on the evidence available, the verdict would not change. **Do not merge or deploy without the named human authorizations.**

---

# COMPLETION SIGN-OFF — remaining six audits (second pass)

The six audits cut short by the spend limit were completed inline against the repository (evidence quoted below), since the subagents had demonstrably failed on the account limit. **No blocker found; RC3 is declared the canonical production baseline and frozen.**

| Audit | Result | Key evidence (verified this pass) |
|---|---|---|
| **Migration** | PASS | 170 files, **0 duplicate timestamps**, **no back-dated new migration** (all 70 new > main's max 20260729), only destructive op in the new set = `20260812` LR5.4B (known/mitigated). `tenant_attachments` final CHECK = **15 targets, none dropped**. |
| **Security** | PASS | **48 new tables / 48 `enable row level security` (exact)**, **0 permissive `using(true)` policies** in new migrations. `20261007` freeze independently re-read: keys on `old.accepted_at is not null` (line 25) + freezes `accepted_at` (line 33) → side-channel closed. `search_path` present across definer functions. |
| **Dependencies/DevOps** | READY | Only 2 new deps vs main (`qrcode`,`@types/qrcode`). Node pinned `>=20`, Next `^15.0.4`, supabase-js `^2.105.4`. 64 npm-audit findings **all inherited from main** (1 critical = next advisory range). Nit: `engines.pnpm` set but repo uses `package-lock.json` (npm). |
| **Documentation** | CORRECTED | Cast-count inconsistency fixed (216/106 → **292 `.from` / 556 total / 165 files**). Migration counts (170/100/70), tenant_attachments (15), LR5.4B all match reality. |
| **Asset Management** | COMPLETE | 6 asset migrations all RLS-enabled; custody single-open invariant = partial unique idx `asset_assignments_one_open_idx`; transfer RPC atomic SECURITY INVOKER; inspection snapshot write-once; cost privacy admin-only ×4 verbs. 9 unit + 11 integration-RLS + 4 e2e test files. |
| **PR Archaeology** | CONFIRMED | 59 open PRs. Merge RC3 #397 → main; close superseded (#375, #363, #182, #119) + obsolete (#171, #268, #267); defer #113/#121/#128/#136/#137/#148. |

**Re-verified gates (HEAD `576e252`):** local typecheck 0 · lint 0 errors · unit 4,855 passed; CI 8/8 green incl. integration + security + e2e on real Postgres.

**RC3 STATUS: FROZEN — CANONICAL PRODUCTION BASELINE (pending human deploy authorization).** No further commits to `release/rc3-full-platform` except a genuine release-blocker fix.
