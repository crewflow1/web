# Launch PR-Queue Status — authoritative snapshot

**Generated:** 2026-10-30 · **Repo:** `crewflow1/web` · **Base:** `main` (migration tip `20261241000000_admin_capability_model`)
**Supersedes the merge-readiness view in `STREAM-PR-MERGE-READINESS.md` (#994) and `RELEASE-CANDIDATE-INTEGRATION.md` (#995), which are now partly stale** (new R5 PRs #980/#981 pushed this sprint; #988 gitleaks still failing; CI re-triggered).

All CI states below were observed directly via `gh pr checks` / `statusCheckRollup` on 2026-10-30. States marked "PARTIAL" mean the full `ci.yml` matrix never ran on the PR head — only `gitleaks` + `Vercel` reported.

---

## 1. Status table (launch-relevant PRs)

| PR | Head SHA | Purpose | Mergeable (state) | CI result (observed) | Tests: behavioural / source | Migration prefix(es) | Depends on | Founder/prod gate | Class |
|----|----------|---------|-------------------|----------------------|------------------------------|----------------------|------------|-------------------|-------|
| **#975** | `f9bfe2da47` | R5 P1 — `job_assignments` model + backfill (additive, DARK) | MERGEABLE / CLEAN | **ALL PASS** (9/9) | behavioural (RLS integration `job-assignments.test.ts` on real PG) + source | `20261242000000` | — (foundation of R5) | **YES** — migration apply-held | **READY (code)**; apply founder-gated |
| **#977** | `e0666369db` | R5 P2 — jobs assignment-aware SELECT (ACCESS POLICY) | MERGEABLE / CLEAN | **PARTIAL** — gitleaks+Vercel pass; full matrix **never ran** | behavioural (RLS `jobs-assignment-access.test.ts`) — **unverified by CI** | `20261243000000` | **#975** (table) | **YES** — access-policy + migration | **NEEDS-WORK** (re-trigger CI) |
| **#980** | `5556bb8c59` | Multi-worker assignment UI (add/remove/history; revokes access) | MERGEABLE / **UNSTABLE** | **security FAIL** (2×); rest pass | behavioural (`assignment-actions.test.ts`) | none | **#975** (reads `job_assignments`) | review | **NEEDS-WORK** (see §3) |
| **#981** | `295bcaf71e` | R5 P3 s1 — operational child-table RLS + caller reconciliation | MERGEABLE / CLEAN | **PARTIAL** — gitleaks+Vercel pass; full matrix **never ran** | behavioural (4 RLS integration suites) — **unverified by CI** | `20261244000000`, `20261245000000` | **#975, #977** | **YES** — access-policy + migration | **NEEDS-WORK** (re-trigger CI) |
| #982 | `b94e875a02` | Stripe sales-led lifecycle unit coverage + gap report | MERGEABLE / **UNSTABLE** | **e2e FAIL** (unrelated asset-inspection flake); rest pass | source-oriented unit (stripe lifecycle/webhook-sig) | none | — | none (test-only) | **NEEDS-WORK** (flake / superseded — see §3) |
| #983 | `d5af3a9157` | Resend + Sentry verification coverage + gap report | MERGEABLE / CLEAN | ALL PASS | behavioural+source (email wrappers) | none | — | none | **SUPERSEDED by #989** → close |
| **#984** | `2783777e35` | AI quote-drafting + insights permission/cost/isolation coverage | MERGEABLE / CLEAN | **ALL PASS** | behavioural (imports real `askAi`, hostile-input) + source completeness | none | — | none (test-only) | **READY** |
| #985 | `a37a28e5a8` | Backup/DR posture verify + freshness classifier unit-pin | MERGEABLE / CLEAN | ALL PASS | behavioural (freshness) + source | none | — | none | **SUPERSEDED by #989** → close |
| **#986** | `55f5e0bc6e` | Portal — gate public quote accept/decline to actionable statuses | MERGEABLE / CLEAN | **ALL PASS** | behavioural (`accept-quote-by-token`) + real fix in `quotes/actions.ts` | none | — | review | **READY** |
| #987 | `efeeb190d9` | Pin HQ access gate (behavioural + completeness) | MERGEABLE / CLEAN | ALL PASS | behavioural (imports real `requireHqApi/Page`) | none | — | none | **SUPERSEDED by #990** → close |
| #988 | `bfd0062654` | Stripe sandbox lifecycle harness + mocked coverage | MERGEABLE / **UNSTABLE** | **gitleaks FAIL**; rest pass | behavioural+source (stripe) | none | — | none (test-only) | **NEEDS-WORK** (secret-scan hit) |
| **#989** | `cc71116d27` | Comms + recovery launch readiness (consolidates #983+#985 + fail-closed/auth-isolation) | MERGEABLE / CLEAN | **ALL PASS** | behavioural + source | none | supersedes #983, #985 | review | **READY** |
| **#990** | `500f352af1` | Demo-promote provisioning consistency (follow-up to #987) | MERGEABLE / CLEAN | **ALL PASS** | behavioural (`promote-consistency` + HQ gate) | none | supersedes #987 | review | **READY** |
| #991 | `54c76f3e6e` | Record-only Stripe lifecycle coverage (follow-up to #988) | MERGEABLE / CLEAN | ALL PASS | source-oriented unit | none | logically after #988 | none | **READY** (test-only) |
| #992 | `60c1c0c3ae` | First-customer simulation E2E (multi-actor) | MERGEABLE / **UNSTABLE** | **e2e FAIL + gitleaks FAIL** | behavioural (Playwright) | none | — | none | **NEEDS-WORK** (see §3) |
| **#993** | `e87cee7d21` | Portal — close 2 void-invoice leaks (PDF route + bulk zip) | MERGEABLE / CLEAN | **PARTIAL** — gitleaks+Vercel pass; full matrix **never ran** | source-assert test + **real behavioural fix** (route + bulk-download) | none | — | review | **NEEDS-WORK** (re-trigger CI) |
| #994 | `8c216488b3` | Docs — stream-PR merge-readiness matrix | MERGEABLE / **UNSTABLE** | **gitleaks FAIL**; rest pass | docs-only | none | — | none | **NEEDS-WORK** (docs secret-scan); partly stale |
| #995 | `2a5faac69c` | Docs — RC integration + deploy/rollback pack | MERGEABLE / CLEAN | ALL PASS | docs-only | none | — | none | **READY** (docs); partly stale |
| #996 | `5d30a22443` | Docs — R5 indirect-leak sweep (SECDEF report RPCs bypass staff isolation) | MERGEABLE / CLEAN | ALL PASS | docs-only | none | — | **informs R5** | **READY** (docs) |

### Non-launch open PRs (context only)
| PR | Head | Note |
|----|------|------|
| #842 | `035c4be6` | dependabot openai 4→7 — **CONFLICTING**, major-version, hold |
| #843 | `a645af8e` | dependabot twilio 5→6 — mergeable, routine |
| #844 | `37d83aed` | dependabot tailwind-merge 2→3 — mergeable, major, review |
| #845 | `ae9a36a7` | dependabot resend 4→6 — **CONFLICTING**, hold |
| #903 | `5fbd0f69` | research/local-ai-benchmark — explicitly "not for merge" |
| #919 | `316fd008` | dependabot npm-minor-and-patch group (21 updates) — mergeable, review as a batch |

---

## 2. Migration-prefix check (collision scan)

| Prefix | PR(s) | Collision? |
|--------|-------|------------|
| `20261242000000` | #975 | no |
| `20261243000000` | #977 | no |
| `20261244000000` | #981 | no |
| `20261245000000` | #981 | no |

**No duplicate migration prefixes across open PRs.** All four are sequential and land cleanly on the main tip `20261241000000`. They **must be applied in order 242 → 243 → 244 → 245**, i.e. #975 → #977 → #981.

### ⚠️ File-content collisions (same path edited by >1 PR — WILL conflict on merge)
These are **not** migration collisions but same-file overlaps; merge order must account for them:

- `docs/hardening/R5-MIGRATION-APPROVAL-PACK.md` — **#977 and #981** (merge #977 first, rebase #981).
- `__tests__/email/{send-wrapper,transactional-send,transactional-templates}.test.ts` — **#983 and #989** (#989 supersedes #983).
- `__tests__/ops/backup-health-freshness.test.ts`, `server/services/ops-snapshot.ts`, `docs/ops/BACKUP-RECOVERY-STATUS.md` — **#985 and #989** (#989 supersedes #985).
- `__tests__/security/{hq-access-gate,hq-gate-completeness}.test.ts` — **#987 and #990** (#990 supersedes #987).
- `__tests__/stripe/lifecycle-transitions.test.ts` — **#982 and #988** (pick one stripe harness; see §3).

**Resolution:** close #983, #985, #987 in favour of their consolidating supersets (#989, #989, #990). Pick ONE stripe PR as canonical.

---

## 3. NEEDS-WORK / BLOCKED detail

- **#980 (security FAIL — real, from its own diff):** the F-1 bare-select guard flags `app/(app)/jobs/[id]/_assignments.tsx:89` (set-read on `job_assignments`, neither F-1-policed nor `COVERAGE_REVIEWED`) and `app/(app)/jobs/[id]/page.tsx:337` (bare `.from("purchase_orders").select(...)` with no `.range/.limit/.single`); the loud-read **shape-ledger** count drifted (expected `55 discard / 35 soft-data / 4 count-only`). Must paginate the new reads + update the guard ledgers. Also **functionally depends on #975** (reads a table that only exists in #975's migration).
- **#977 / #981 / #993 (PARTIAL CI):** the full `ci.yml` matrix (typecheck/tests/security/integration/e2e) **never executed** on these heads — only `gitleaks`+`Vercel`. Their RLS/leak behaviour is **CI-unverified**. Re-trigger CI (empty commit or close/reopen) before judging mergeable. For the two access-policy PRs this is a hard gate.
- **#988 / #992 / #994 (gitleaks FAIL):** secret-scan hits inside the diff — stripe test-key fixtures (#988 sandbox harness), the first-customer-sim fixtures (#992), and example tokens in docs (#994). Fix by redaction or a reviewed `.gitleaksignore` fingerprint. (This is the "#988 gitleaks being fixed" item.)
- **#982 / #992 (e2e FAIL):** the e2e failure is an **unrelated asset-inspection flake** (`asset-inspections … save progress` URL assertion `?saved=status`, 20s timeout) — not caused by either diff (#982 is stripe unit tests; #992 is a new e2e spec). Re-run; if it persists it is a pre-existing flake to fix separately, not a blocker for these diffs' own content.
- **Stripe cluster (#982, #988, #991):** overlapping coverage of the same lifecycle. Recommend **#988** as the canonical sandbox harness (after gitleaks fix) with **#991** (record-only) stacked on it, and **close #982** (its unique `webhook-route-signature` assertions should be folded into #988 if not already present).

---

## 4. Coordinated merge order (waves)

> Branch → preview → **human-approved** merge. Nothing here merges or applies autonomously. Migrations apply **only** on explicit founder action, in prefix order.

**Wave 0 — green test-only / docs, zero schema, zero access change (merge anytime):**
`#984` (AI coverage) · `#986` (portal quote-status fix) · `#989` (comms+recovery; close #983, #985) · `#990` (demo-promote; close #987) · `#991` (stripe record-only) · `#995` (docs) · `#996` (docs).

**Wave 1 — fix-then-merge (resolve before including):**
`#988` (fix gitleaks) → then `#991` rebases cleanly · `#993` (re-trigger CI; it ships a real leak fix) · `#992` (fix gitleaks + confirm e2e flake) · `#994` (fix gitleaks; docs, partly stale — refresh or supersede with this file).

**Wave 2 — R5 access-policy chain (ordered, migration-apply founder-gated):**
`#975` (migration `242`) → `#977` (migration `243`, re-trigger CI first) → `#981` (migrations `244`+`245`, re-trigger CI first). Merge code in this order; apply migrations in prefix order in the same sequence. `#996`'s indirect-leak finding (SECDEF report RPCs bypass staff isolation) should be remediated **as part of / before** this chain goes live.

**Wave 3 — R5 UI (after Wave 2 code + migration live):**
`#980` — only after #975 is merged **and** the F-1/shape-ledger security failures are fixed.

**Hold / out-of-band:** dependabot #842/#845 (conflicting), #843/#844/#919 (routine, separate review); #903 (never merge).

---

## 5. Founder-approval & credential gates (explicit)

| Gate | Applies to | Why |
|------|-----------|-----|
| **Migration apply** (prod, in prefix order) | #975 (`242`), #977 (`243`), #981 (`244`,`245`) | Single prod Supabase, no staging; additive but changes RLS/read access. Apply-held by design. |
| **Access-policy sign-off** | #977, #981, #980 | These change *who can read jobs and operational child rows* (assignment-aware). Product/founder must confirm the staff-isolation policy before it goes live. |
| **No new credentials required** | all above | No dark provider is activated by any PR in this queue; no secret/env change needed to merge. The gitleaks failures are fixture/doc hygiene, **not** real secrets to rotate. |
| **AI providers stay dark** | #984 | Test-only; governor/provider remain off. |
| **Stripe stays record-only / sandbox** | #982, #988, #991 | No live charge path enabled; harness is mocked/sandbox. |

---

*Observed-CI caveat: CI states reflect `gh pr checks` at generation time (2026-10-30). PARTIAL and FAIL rows should be re-polled immediately before any merge.*
