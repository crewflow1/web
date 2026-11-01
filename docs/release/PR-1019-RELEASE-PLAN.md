# PR #1019 — Production Release Plan (expand-and-contract, zero-downtime)

> **Apply-held.** Nothing here runs without explicit founder approval. Decision
> pack for releasing the valuation active-org pin (`fix/pin-valuation-rpcs-active-org`).

## 1. What ships (two migrations, applied in separate controlled steps)

- `20261267000000_pin_valuation_rpcs_active_org.sql` — **EXPAND**. Adds the
  active-org-**pinned** overloads `certify_valuation(p_org_id, p_valuation_id)` and
  `generate_valuation_invoice(p_org_id, p_valuation_id, p_due_date)`, and **keeps**
  the old single-arg / `(uuid,date)` signatures as **thin secure wrappers** that
  resolve a single-org caller's one org and delegate to the pinned overload, while
  **refusing** multi-org / anon callers with `42501`.
- `20261268000000_contract_valuation_legacy_wrappers.sql` — **CONTRACT**. Drops the
  two legacy wrappers once the pinned app build is fully live. End state: only the
  pinned signatures remain.
- `app/(app)/jobs/[id]/valuation-actions.ts` — passes `p_org_id: ctx.org.id` (calls
  the pinned overload). `lib/supabase/types.ts` — regenerated `Args`. Tests only otherwise.

**Sole runtime consumers:** the two server actions. Verified: **no** internal DB
caller, trigger, cron, API route, or edge function calls either RPC.

## 2. Why expand-and-contract (independent review of the alternative)

A single drop-and-recreate (the first draft of #1019) is correct at the end state
but has a brief window between the migration applying and the new build going live
where the *old* app calls a now-missing signature → certify/generate error.

Expand-and-contract removes that window **without** adding security risk:

| Phase | Legacy 1-arg path (old app) | Pinned path (new app) | Active-org isolation |
|---|---|---|---|
| EXPAND applied, old build live | single-org admin: delegates to pinned → **works**; multi-org/anon: **42501** | n/a (old build) | **held** — single-org's only org *is* their active org; multi-org forced to pinned |
| new build live | wrapper still present but unused | pinned, org-checked | **held** |
| CONTRACT applied | removed | pinned only | **held** |

So there is **no unpinned window** (the legacy path is itself secure — the
cross-active-org exploit is closed on it too) and certify/generate keeps working
for single-org users (≈all of prod) throughout. **Recommended over the single
migration.** Isolation is preserved in every phase (point 5 ✓).

## 3. Verification evidence (local, real Postgres)

- **End state** (267+268 applied): catalogue shows **only** the two pinned
  signatures; `rls/valuation-active-org-pin` **3/3** (dual-org admin blocked
  cross-org, works in active org; non-admin refused; non-member/anon 42501;
  generated invoice = net £1000 / VAT £200 / draft / org B — money math unchanged),
  `secdef-org-rpc-guard` **15/15**, retention + invoice-snapshot + payments-integrity
  + customer-denormalisation **41/41**, static `job-valuations` **30/30**, grant guard
  **7/7**, typecheck + eslint clean.
- **Expand state** (267 only, 268 held back — verified by moving the contract
  migration aside and resetting): catalogue shows **4** signatures (2 pinned + 2
  wrappers); probe **3/3** — single-org admin's legacy 1-arg call delegates and
  certifies; multi-org admin's legacy call is refused (42501) and the pinned call
  then works; anon refused. (Transient-state probe; not a committed test, since the
  end state has no wrapper.)
- Workflows confirmed working end-to-end in both phases (point 6 ✓).

## 4. Migration-tip reconciliation

| Item | Value |
|---|---|
| Prod migration tip (applied, #1018 / `e85a377c`) | `20261266000000` |
| EXPAND migration | `20261267000000` (next free, above tip) |
| CONTRACT migration | `20261268000000` (above tip) |
| Collision scan (open branches, `266–270`) | none — `267`/`268` free |
| Next free prefix after this release | `20261269000000` |

**Independent of the R5 chain.** R5 branch migrations (`20261242`–`20261251`, PRs
#975/#977 + the local phase-3/4/5 chain) carry prefixes **below** the applied tip
`266` and must be re-stamped to `269+` before they can apply in order — separate,
pre-existing R5 debt (docs PRs #1002/#1003/#1006), **not part of this release**.

## 5. Pre-release gates (all green before apply)

1. **CI green** on #1019 (every mandatory check).
2. **Founder approval** of this plan.
3. **Backup fresh + verified:** `scripts/ops/off-platform-backup.sh`; confirm a
   `success` row in `ops_backup_runs` + `/admin/ops` freshness GREEN + encryption-key
   custody; capture backup id/timestamp.
4. **Tip confirmed:** `supabase migration list --linked` shows tip `20261266000000`,
   history in sync, no drift.
5. **Restore verification:** confirm the §5.3 backup is restore-proven within policy
   (the DR drill already proves schema replay + exact-match data restore). A full
   drill is not required for a function-only change, but freshness must be GREEN.
   PITR is OFF (CEO cost decision) — this change writes no data on apply, so a
   data-restore is not an expected rollback path.

## 6. Recommended release sequence (exact migration IDs)

Migrations are applied **one at a time** with CrewFlow's controlled pattern
(`supabase db query -f <file> --linked` then
`supabase migration repair --status applied <version> --linked`) — **not** a blanket
`db push`, so EXPAND and CONTRACT cannot collapse into one step.

1. **Merge** #1019 → `main` (squash) after CI green + approval.
2. **Backup + verify** (gates §5.3–§5.5).
3. **Apply EXPAND** `20261267000000` to prod (`db query -f` + `migration repair`).
   → Pinned overloads + secure wrappers now live; current (old) build keeps working.
4. **Deploy the pinned app build** — confirm the Vercel deploy of merged `main` is
   live (calls the pinned overload).
5. **Confirm the old build is fully drained** (no instances serving the pre-merge
   build). Low-traffic window recommended but not required (old path stays safe).
6. **Apply CONTRACT** `20261268000000` to prod (`db query -f` + `migration repair`).
   → Legacy wrappers dropped; only pinned signatures remain.
7. **Post-apply verification (read-only on prod):**
   - `supabase migration list --linked` → tip `20261268000000`.
   - Catalogue: only `certify_valuation(uuid,uuid)` + `generate_valuation_invoice(uuid,uuid,date)` exist.
   - `/api/health` OK; next genuine certify/generate by an admin succeeds (do not
     fabricate a prod invoice solely to smoke-test).
8. **Record** tip `266 → 268` in the release log.

## 7. Rollback

- **Between step 3 and step 6** (EXPAND applied, CONTRACT not yet): nothing to undo
  for safety — the wrappers are secure and the old build works. If the new build
  must be pulled, redeploy the previous build (`e85a377c`); the legacy wrappers keep
  serving single-org admins. To fully revert the DB, ship a forward migration
  `20261269000000` dropping the pinned overloads and restoring the `20261192000000`
  bodies (never a history edit).
- **After step 6** (CONTRACT applied): to restore the legacy path, ship a forward
  migration re-creating the two wrappers exactly as in `20261267000000`.
- **Last resort only** (catastrophic, unrelated): restore from the §5.3 backup — not
  expected; the migrations write no data.

---

### Founder decision required
Approve: (a) merge #1019; (b) the §6 expand-and-contract sequence (apply
`20261267000000`, deploy, drain, apply `20261268000000`). R5 chain re-stamping is
**not** part of this decision.
