# R5 Branch Re-consolidation Plan

**Status:** PLAN ONLY — the coordinator executes the surgery. Nothing here has been pushed, force-pushed, merged, or applied.
**Author:** read-only git/gh analysis, 2026-10-31.
**Repo:** `crewflow1/web` (origin `https://github.com/crewflow1/web.git`).

R5 read-side staff-isolation work was split across three origin refs by two actors. This document
establishes the **exact current state** of each ref, the **safe re-consolidation sequence**, and the
**precise commands** — with every irreversible step flagged. It supersedes guesswork in the task brief
where the evidence contradicts it (see "Correction to the working hypothesis" below).

---

## 1. Current state of every ref (verified)

All SHAs confirmed against `git ls-remote origin` and `gh pr view` on 2026-10-31. `origin/main` tip = `ea2a502c`.

| Ref (origin) | PR | Head SHA | PR base | Contents | Migrations vs main |
|---|---|---|---|---|---|
| `feat/r5-phase3-operational-rls` | **#981** (OPEN) | `9b3651cc` | `feat/r5-phase2-jobs-rls` | **FULL R5 stack** — 17 commits, Phase 1→5 + all review fixes. Contains **every** fix incl. `4064db6a` (cost-entry BLOCKER) and `67aa2657` (migration `20261254`). | `242,243,244,245,247,248,249,250,251,252,253,254` |
| `r5/consolidated-operational-rls` | **#997** (OPEN) | `108bf4c5` | `main` | Full stack **minus the last 4 commits** — stops at the "sprint-2 approval pack". **MISSING** the BLOCKER fix `4064db6a` and migration `20261254`. | `242,243,244,245,247,248,249,250,251,252,253` (**no `254`**) |
| `feat/jobs-assignment-reconciliation` | **#998** (OPEN, **CI-GREEN**) | `c98a9a00` | `main` | Independent transactional jobs-assignment model. **DO NOT DISTURB.** | `242,246` |

**Canonical working branch** = local `feat/r5-phase3-operational-rls`. At analysis time it equals `origin/feat/r5-phase3-operational-rls` (`9b3651cc`) **plus uncommitted in-flight WIP** in the working tree:
- modified `server/services/material-request-writes.ts`
- modified `__tests__/security/material-requests.test.ts`
- new `supabase/migrations/20261255000000_r5_material_request_own_lookup_rpc.sql`

This is the "+ more coming" the brief refers to. It is **not yet committed** and therefore **not on any origin ref**.

### Exactly what #997 is missing (the 4 commits `108bf4c5..9b3651cc`)

| SHA | Kind | What it does |
|---|---|---|
| `65b15a17` | docs | stock_movements least-privilege masking design note |
| **`4064db6a`** | **fix (BLOCKER)** | preserve member-open cost entry under finances SELECT narrowing — edits `app/api/finances/route.ts` + `__tests__/integration/rls/commercial-denial.test.ts` (no migration) |
| **`67aa2657`** | **fix (HIGH)** | Phase 4 slice 4 — purchase_order_line_items read denial — **adds migration `20261254000000_r5_phase4_po_line_items_denial.sql`** + test |
| `9b3651cc` | docs | sprint-3 approval pack |

The two substantive gaps are `4064db6a` (a caller-code BLOCKER fix) and `67aa2657` (migration `20261254`). Shipping #997 as-is would release the finances SELECT narrowing **without** the member-open cost-entry preservation (a regression) **and without** PO-line read denial.

---

## 2. Correction to the working hypothesis (IMPORTANT — read before acting)

The brief hypothesised that a coordinator "may have pushed a full R5 stack onto #981, **possibly clobbering** #981's original 244/245-only scope." **The evidence disproves the clobber:**

- `GET /repos/crewflow1/web/issues/981/timeline` shows **zero `head_ref_force_pushed` events** and exactly **17 `committed` events** — i.e. the 17 commits now on the branch were each *added*, never rewritten.
- The local reflog for `feat/r5-phase3-operational-rls` is strictly linear from `e0666369` (its base, `feat/r5-phase2-jobs-rls`) up to `9b3651cc` — only `commit:` / one local `commit (amend)` entries, **no rewind/force**.
- `git merge-base origin/r5/consolidated-operational-rls origin/feat/r5-phase3-operational-rls` = `108bf4c5` (= #997's own tip), proving #997 is a **strict ancestor** of #981.

**Conclusion:** #981 was never clobbered. It simply **grew by fast-forward** from its titled slice-1 scope into the full stack; its PR *title* ("Phase 3 slice 1") is stale relative to its contents. There is therefore **no "pre-clobber head" to restore** — any remote ref rewind would be an *invention*, not a recovery, and would be destructive.

This reframes step (2): it is not "undo a clobber", it is an optional "**re-scope #981's branch back to its titled slice-1 content now that #997 owns the full stack**". The recommended action is instead to **close #981 as superseded** (§4), which loses nothing and needs no force.

---

## 3. Operation 1 — point #997 at the canonical full-fix branch (SAFE, non-destructive)

**Goal:** make `r5/consolidated-operational-rls` (#997) carry the complete fixed stack, incl. `4064db6a` + migration `20261254`.

Because `108bf4c5` (current #997) is a **strict ancestor** of the canonical tip, this is a pure **fast-forward** — no commit is dropped, no `--force`.

### 3a. Decide the push source first

- To publish up to the sprint-3 tip: push `9b3651cc`.
- To also include the in-flight WIP (migration `20261255`): first commit the working-tree WIP onto `feat/r5-phase3-operational-rls`, then push that new tip. (This is the coordinator's call; the FF stays valid as long as the new tip is a descendant of `108bf4c5`.)

### 3b. Pre-flight checks (must both pass)

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/moetalibi/Code/web-main
git fetch origin

# (i) #997 must still be where we measured it (guards against a concurrent push):
test "$(git rev-parse origin/r5/consolidated-operational-rls)" = "108bf4c52fa2b8fd38a99e3f1d83c2e0656fbd5b" \
  && echo "OK: #997 unchanged" || echo "STOP: #997 moved — re-analyse before pushing"

# (ii) the push must be a fast-forward (ancestor check), substituting the chosen source tip:
SRC=feat/r5-phase3-operational-rls   # or the SHA you decided in 3a
git merge-base --is-ancestor origin/r5/consolidated-operational-rls "$SRC" \
  && echo "OK: fast-forward" || echo "STOP: NOT a fast-forward — do not force; re-analyse"
```

### 3c. The push (fast-forward only)

```bash
# Source : local canonical branch tip (feat/r5-phase3-operational-rls, or the SHA from 3a)
# Dest   : #997's head ref r5/consolidated-operational-rls
git push origin feat/r5-phase3-operational-rls:r5/consolidated-operational-rls
```

Equivalent explicit-SHA form (recommended for auditability):

```bash
git push origin 9b3651cc:refs/heads/r5/consolidated-operational-rls
```

**No `--force` / `--force-with-lease`.** If git rejects it as non-fast-forward, **STOP** — someone rewrote #997; do not override, re-analyse.

**Reversibility:** fully reversible — it only advances the ref; the prior tip `108bf4c5` remains reachable in history and in reflogs.

### 3d. Post-push expectations for #997

- `origin/r5/consolidated-operational-rls` now contains migration `20261254` and the `4064db6a` cost-entry fix; `git diff --name-only origin/r5/consolidated-operational-rls origin/feat/r5-phase3-operational-rls` becomes empty (same tip).
- #997's base is `main` and `feat/r5-phase2-jobs-rls` is **not merged to main**, so #997's diff legitimately includes Phase 1 + Phase 2 (migs `242`,`243`) — expected for a *consolidated* PR. This is not an error.
- Re-run #997's CI after the push.

---

## 4. Operation 2 — #981 (NO force-restore; CLOSE as superseded — RECOMMENDED)

Since (a) #981 was never clobbered and (b) #997 now carries the full fixed stack and is explicitly the superseding consolidated PR (its title: "supersedes #977/#981"), the clean action is to **close #981**. Nothing is lost — every commit lives on `r5/consolidated-operational-rls`.

```bash
gh pr close 981 --comment "Superseded by #997 (consolidated R5 read-side staff isolation), which now carries the full fixed stack including 4064db6a (member-open cost-entry BLOCKER fix) and migration 20261254 (PO-line read denial). The branch feat/r5-phase3-operational-rls is retained as the canonical working branch for ongoing R5 WIP."
```

Leaving the branch `feat/r5-phase3-operational-rls` in place keeps the canonical working branch (and its uncommitted WIP) intact. **Reversible** — a closed PR can be reopened.

### 4b. OPTIONAL — re-scope #981 to its original slice-1 content (DESTRUCTIVE — NOT RECOMMENDED)

Only if the coordinator specifically wants #981 to exist again as the atomic "Phase 3 slice 1" PR (migrations `244`/`245` only). The original slice-1 scope resolves to commit **`295bcaf7`** ("union assignment sources + slice-2 safety tables") — verified to contain exactly migrations `20261244` + `20261245` on top of base `feat/r5-phase2-jobs-rls`. (`03d5d029` is `244`-only; `295bcaf7` adds `245`, matching the brief's "244/245 scope" and the PR title "slice 1 + caller reconciliation".)

> ⚠️ **IRREVERSIBLE on the remote ref.** This rewinds `origin/feat/r5-phase3-operational-rls` by 14 commits. It is **only safe AFTER Operation 1 has landed on origin**, because the commits being dropped from this ref (`4064db6a`, `67aa2657`, migration `20261254`, etc.) must already be preserved on `r5/consolidated-operational-rls`. It also **moves the canonical-working-branch identity** to `r5/consolidated-operational-rls`: any future "+ more coming" commits must then target that branch, **not** this one. Because of this, closing #981 (§4) is strongly preferred.

```bash
# PRECONDITION: Operation 1 confirmed on origin (r5/consolidated-operational-rls == 9b3651cc or a descendant).
# Capture/commit any uncommitted WIP in the working tree FIRST (it belongs on the consolidated branch).
# Lease guards against racing another actor: expected current remote tip = 9b3651cc.
git push --force-with-lease=feat/r5-phase3-operational-rls:9b3651cc \
  origin 295bcaf7:feat/r5-phase3-operational-rls
```

If the lease fails, **STOP** — the remote moved; do not retry with `--force`.

---

## 5. Operation 3 — #998 (LEAVE UNTOUCHED)

`feat/jobs-assignment-reconciliation` (#998, `c98a9a00`) is **CI-GREEN**, based on `main`, and independent: it diverges from the R5 stack at the shared ancestor `f9bfe2da` and carries its own migrations `242` + `246`. **No command in this plan references it.** Do not push, rebase, or re-point it.

Coordination note (not an action): migration `20261242_job_assignments.sql` appears on **both** #998 and the consolidated R5 branch — both inherit it unchanged from the shared ancestor `4d7579a3`, so it is byte-identical. The R5 stack skips `246` (uses `242–245, 247–254`), so there is **no migration-number collision** between #997 and #998. Whichever merges second will already have `242` present; the eventual merge-order decision is out of scope for this plan.

---

## 6. Execution order & irreversible-step summary

1. **Op 1** — FF-push canonical tip → `r5/consolidated-operational-rls` (#997). *Reversible.* Re-run #997 CI.
2. **Op 2** — `gh pr close 981` as superseded. *Reversible.* (Do **not** do §4b unless explicitly required.)
3. **Op 3** — nothing; #998 untouched.

**Irreversible steps:** only §4b (the optional #981 rewind) — a `--force-with-lease` that drops 14 commits from `origin/feat/r5-phase3-operational-rls`. It is gated on Op 1 having landed. The recommended path (§4 close) has **no** irreversible step.

**Hard STOP conditions:** #997 not at `108bf4c5` at push time; push rejected as non-fast-forward; `--force-with-lease` lease failure. In every case: do not override — re-run the §1 analysis.
