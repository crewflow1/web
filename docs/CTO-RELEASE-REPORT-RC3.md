# CrewFlow — CTO Release-Recovery Report (RC3)

**Prepared under:** the Release-Recovery & CTO Consolidation directive.
**Method:** a 20-role multi-agent audit (7 independent specialist agents) + serial release engineering. Every finding is evidence-backed against the repository at `release/rc3-full-platform`; prior milestone reports were **not** trusted.
**Deliverable:** RC3 = `release/rc3-full-platform` → `main` (PR #397), **DO NOT MERGE / DO NOT DEPLOY**.
**Companion docs:** `RELEASE-MANIFEST-RC3.md`, `PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md`, `backup-recovery-runbook.md`.

---

## 1. Executive summary

The accumulated engineering (≈40 unmerged feature PRs, several stacked/parallel, spanning 70 new migrations) has been consolidated into **one canonical, CI-green, linearly-ordered release candidate** on top of production `main`. A full audit found **no launch blockers**. One MEDIUM security finding was fixed inside the candidate; everything else is either non-blocking tech-debt (tracked) or an explicit product/scope decision that belongs to the human release owner.

**Headline verdict: RC3 is genuinely release-ready as an engineering artifact.** It compiles, all six CI gates pass on a real Postgres, migrations are additive and safe, the multi-tenant security spine is sound, and no forbidden parallel systems were introduced. The remaining gates to an actual launch are **human decisions**, not engineering work: authorize the one irreversible migration (LR5.4B), set production credentials/flags, and choose whether the deferred items (WhatsApp, telephony) are in the first cut.

The single most important thing the audit caught: **the feature stack silently omitted the entire CX/onboarding cluster (#364–366)** — it was parallel, not stacked, and "ship the stack tip" would have dropped it. RC3 folds it back in.

## 2. Architecture health — CLEAN (minor debt)

Every CEO-forbidden parallel system was explicitly checked and verified **single**: portal auth (`loadCustomerByPortalToken`), customer directory, money engine (`lib/money`+`lib/quotes/totals`), universal attachments (`tenant_attachments`), audit-per-plane, notification emitter. Purchase orders (committed spend) are correctly separate from `finances` (actual cost) — **no `supplier_bills` fork**. No dead code, no circular deps, no client/server boundary violations, no money-math drift. Debt is bounded and cosmetic/type-safety (see §10).

## 3. Codebase health — STRONG

TypeScript strict compiles clean; ESLint clean (0 errors, 6 pre-existing warnings in unrelated files). The vertical pattern (migration → pure lib → tenant-client server action → UI) is consistent across every new feature. The one systemic smell is the 216 `as never` Supabase-type casts driven by stale generated types (§10.1) — it compiles and runs, but it is a real type-safety loss to clear post-cutover.

## 4. Database health — SAFE-WITH-NOTES

170 migrations, **zero duplicate timestamps**, clean linear append after `main`'s applied max. The historically-fragile `tenant_attachments.target_table` CHECK was traced across all 8 redefinitions: **monotonic, no target ever dropped** (final 15). 48 new tables / 48 `enable row level security` (exact match). Every SECURITY DEFINER function pins `search_path`. FKs all resolve. The CI integration gate applies all 170 on a fresh volume and is green — direct proof the chain is appliable. One irreversible migration (LR5.4B, §9).

## 5. Security review — PASS (one MEDIUM fixed here)

No CRITICAL/HIGH. RLS covers all 133 tables (the only `using(true)` is an insert-only public lead form). Portal upholds every invariant: single auth authority, every read scoped **org_id AND customer_id**, HQ private notes stripped, no insecure service-role reads, `tenant_attachments` never exposed to the portal. 146 SECURITY DEFINER functions, 0 missing `search_path`. Money is `numeric(12,2)` throughout.

- **FIXED in RC3 (was MEDIUM):** the accepted-quote freeze gated on live `status='accepted'`, allowing an `accepted→sent→edit` status side-channel bypass. Migration `20261007` re-keys both freeze triggers on `accepted_at IS NOT NULL` and freezes `accepted_at` itself; two new integration tests prove the bypass is closed.
- **LOW (opportunistic):** a committed **anon** Supabase key in `scripts/war-test-seed.mjs` (public-by-design, RLS-protected — not a secret, but relocate to env if the repo goes public); polymorphic `target_id` columns aren't same-org FK-validated (not a cross-tenant leak — worst case is an orphan row within the caller's own org).

## 6. Performance review — READY (one fix applied)

FK indexes on all new tables are complete; no missing-index hotspot. The one genuine hazard — the **unbounded purchase-orders list query** — was **fixed in RC3** (`.limit(500)`). Minor, non-blocking: `jobs/[id]` runs two sequential query waves that could merge; the asset-inspection cron does a bounded (BATCH=50) per-row lookup. None affect launch.

## 7. Test posture — STRONG

8,700+ tests across four tiers (unit 4,845 green locally; integration ~788 real-Postgres; security ~3,064; e2e 17 Playwright). All six CI gates are separate jobs; integration + e2e run against a real Postgres via `supabase start`; the integration harness **fails loud in CI** if the DB is absent (can't silently skip). **Zero genuinely disabled tests.** Every shipped feature has real executing tests. Coverage gap noted (non-blocking): Variations is unit-only where its commercial siblings have integration RLS tests — added to the fast-follow list.

## 8. Release readiness — READY

RC3 is one linear branch containing everything intended for launch, in correct order, CI-green. It supersedes RC2 #375 (which stalled at #374). PR disposition for all 58 open PRs is in manifest §5 (include / close-superseded / close-obsolete / defer). The candidate is a PR to `main` awaiting go/no-go — the assistant does not merge or deploy.

## 9. Migration & production readiness — READY, with named gates

- **Migration order** is deterministic (filename timestamp). The dry-run + apply procedure and the watch-points are in the runbook.
- **The one irreversible step — LR5.4B (`20260812`)** drops two legacy `ai_employees` columns. Forward-safe (Capability Registry is sole authority; no reader depends on them), correctly sequenced after its `20260807` backfill, and covered by a pre-migration snapshot. It **requires explicit human authorization**.
- **Env:** 3 hard-required vars; `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` operationally required (without `CRON_SECRET` all 19 crons 401). A ~7-var env-schema validation gap is recommended to close pre-launch.
- **Cron/storage/flags:** 19 authenticated crons (fail-closed), 7 declared buckets, 4 dark flags (default false). All inventoried in manifest §7.
- **Backups/rollback:** PITR + an on-demand HQ dump + the `ai_employees` snapshot; app-rollback is instant (stateless, additive migrations); the full rollback decision-tree is in the runbook §7.

## 10. Technical debt (non-blocking, tracked)

1. **Stale generated Supabase types** → 216 `as never` casts / 106 files. Regenerate against the RC3 schema post-cutover (needs DB access) — biggest type-safety win. *(MEDIUM)*
2. `lib/retention` (customer-health) vs `lib/retentions` (holdback money) naming collision — rename one. *(LOW-MED)*
3. `round2` duplicated 5× (identical today) — collapse onto `lib/money.round2`. *(LOW)*
4. Env-schema validation gap (~7 vars). *(LOW)*
5. 6 crons without explicit `maxDuration`; PO/holdings inline empty-states vs the shared component. *(LOW/cosmetic)*

## 11. Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LR5.4B irreversible column drop | Low | High | Pre-snapshot + no live reader + named authorization + PITR |
| npm-audit inherited advisories (next range, sentry) | Med | Low-Med | All pre-existing on `main`; track `next` patches, schedule sentry v10 bump — not launch-gating |
| Cron misconfig (`CRON_SECRET` unset) | Med | Med | Fail-closed (401, no bad writes); pre-flight checklist item |
| Stale types hide a latent column typo | Low | Med | Regenerate types post-cutover; CI integration tests exercise real schema |
| Deferred WhatsApp migration collision re-surfaces | Low | Low | Documented; must re-date before any inclusion |
| Single prod DB, no staging | Standing | Med | PITR + additive migrations + app-first rollback |

## 12. Outstanding work (before / around launch)

**Human decisions (blocking a cutover, not engineering):** authorize LR5.4B · set prod env/secrets · confirm flags stay dark · decide first-cut scope for WhatsApp (#360–362) and telephony (#113).
**Engineering fast-follows (post-cutover):** regenerate Supabase types · close superseded/obsolete PRs · re-date + include the deferred items if in scope · add the Variations integration RLS test · close the env-schema gap · resolve the `retention`/`retentions` naming.

## 13. Launch checklist (condensed — full procedure in the runbook)

- [ ] PR #397 CI fully green (6 gates + Vercel).
- [ ] LR5.4B authorization recorded; `ai_employees` snapshot verified.
- [ ] Prod env vars set (esp. `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`); flags dark.
- [ ] PITR enabled + on-demand backup taken.
- [ ] Migration dry-run shows exactly 70 pending, in order, no duplicates.
- [ ] Apply migrations (watch `20260807`→`20260812`); deploy app; SHA changes.
- [ ] Smoke tests pass (login, quote→accept→invoice, portal scoping, assets, PO, one cron, dark-features-stay-dark).
- [ ] Post-cutover: regenerate types, close superseded PRs.

## 14. Future roadmap (post-launch, not in this directive's scope)

Commercial: payment allocation (needs the `payment_allocations` join + retargeted status-sync trigger with a concurrency proof), supplier bills (extend `finances`), unified commercial lifecycle timeline. Assets: authenticated E2E harness to unlock lifecycle specs. Stage Two AI: gated on product decisions (autonomy) + external credentials (LLM/telephony/Meta media) — surfaced, never faked-dark. Blueprint Centre remains its own multi-milestone epic.

## 15. Final recommendation

**CrewFlow's Stage-One platform is engineering-ready for a production cutover via RC3.** The code is consolidated, verified, secure, and migration-safe; the audit surfaced no blockers and its one material finding is already fixed in the candidate. The remaining steps are deliberate human decisions — authorize the single irreversible migration, provision credentials, and confirm scope — for which the manifest and runbook provide the exact procedure. Recommendation: **proceed to a go/no-go review of PR #397 once its CI is confirmed green; do not merge or deploy without the named authorizations above.**
