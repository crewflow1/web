# PR #1019 — Production Release Plan (migrations-first)

> **Apply-held.** Nothing here runs without explicit founder approval. This is the
> decision pack for releasing the valuation active-org pin
> (`fix/pin-valuation-rpcs-active-org`, migration `20261267000000`).

## 1. What ships

A single additive migration + its callers:

- `supabase/migrations/20261267000000_pin_valuation_rpcs_active_org.sql` — DROPs
  the old `certify_valuation(uuid)` / `generate_valuation_invoice(uuid, date)`
  and re-creates both taking the caller's **active org** (`p_org_id`) with the
  canonical `current_org_ids()`+`42501` guard and an org-pinned valuation fetch.
- `app/(app)/jobs/[id]/valuation-actions.ts` — passes `p_org_id: ctx.org.id`.
- `lib/supabase/types.ts` — regenerated `Args`.
- Tests only otherwise.

**Sole runtime consumers:** the two server actions above. Verified there is **no**
internal DB caller, trigger, cron, API route, or edge function calling either RPC.

## 2. Migration-tip reconciliation (done)

| Item | Value |
|---|---|
| Prod migration tip (applied, #1018 / `e85a377c`) | `20261266000000` |
| This PR's migration | `20261267000000` (next free, **above** tip) |
| Collision scan (open branches, `266–270` range) | none — `267` is free |
| Drift | none (prod history in sync per #1018 release) |

**Independent of the R5 chain.** This fixes the pre-existing valuation RPCs (from
`20261192`), not R5. The R5 branch migrations (`20261242`–`20261251`, PRs #975/#977
+ the local phase-3/4/5 chain) carry prefixes **below** the applied tip `266` and
must be **re-stamped to `268+`** before they can apply in order — that is separate,
pre-existing R5 debt (tracked in docs PRs #1002 / #1003 / #1006) and **must not be
bundled with this release**. Because #1019 claims `267`, the re-consolidated R5
chain should begin at `268`.

## 3. Deployment-compatibility assessment (point 6)

This is a **breaking signature swap** (old signatures dropped). There is no app
code that can call both shapes, so there is a brief incompatibility window between
the migration applying and the new Vercel build going live:

- **Migration applies, old build still serving:** old code calls the 1-arg RPC →
  `function does not exist` → certify/generate error until the new build is live.
- Window length = migration apply → Vercel promotion (minutes).

**Risk rating: LOW**, because:
1. `certify_valuation` / `generate_valuation_invoice` are **low-frequency,
   admin-only** actions (interim valuations on construction jobs), not hot paths.
2. The vulnerability being fixed (a dual-org admin acting outside the active org)
   is **currently unreachable in prod** — prod has ~0 multi-org users (verify at
   release time). So even keeping the old path briefly would expose nothing today.
3. Only these two actions are affected; a failed attempt is a retry, not data loss.

**Recommended:** accept the minimal window — release in a low-traffic slot and
apply the migration immediately before promoting the build. If strict zero-gap is
required, use the optional two-phase variant in §7.

## 4. Pre-release gates (all must be green)

1. **CI green** on #1019 (every mandatory check).
2. **Founder approval** to merge + apply (this pack).
3. **Backup fresh + verified:** run `scripts/ops/off-platform-backup.sh`; confirm
   a `success` row in `ops_backup_runs` and `/admin/ops` freshness is GREEN
   (encryption key custody confirmed). Capture the backup id/timestamp.
4. **Tip confirmed:** `supabase migration list --linked` shows tip `20261266000000`,
   no drift, history in sync.

## 5. Restore verification

- Confirm the backup from step 4.3 is **restore-proven** within policy (the DR drill
  already proves schema replay + exact-match data restore). A full restore drill is
  **not** required for a one-function-signature change, but backup freshness must be
  GREEN before proceeding.
- **PITR is OFF** (CEO cost decision) — in-place RPO ≈ last backup. This change makes
  no data writes on apply, so a data-restore is not an expected rollback path.

## 6. Deployment order (migrations-first)

1. Merge #1019 → `main` (squash) after CI green + approval.
2. **Apply the migration to prod FIRST:** `supabase db push --linked` (or
   `migration up --linked`) applies `20261267000000`. Do this in the chosen
   low-traffic window.
3. **Promote the new build:** ensure the Vercel deploy of the merged `main` is live
   (new code passing `p_org_id`). Keep step 2→3 as tight as possible.
4. **Post-apply verification (read-only on prod):**
   - `supabase migration list --linked` → tip now `20261267000000`.
   - Catalogue check: only `certify_valuation(uuid,uuid)` and
     `generate_valuation_invoice(uuid,uuid,date)` exist; the old `(uuid)` /
     `(uuid,date)` are gone (same query used in isolated verification).
   - App health: `/api/health` OK; a real certify/generate by an admin succeeds
     (or confirm via the next genuine valuation — do **not** fabricate a prod
     invoice solely to smoke-test).
5. **Record** tip `266 → 267` in the release log.

## 7. Rollback

Because the app and DB are coupled by the signature, rollback is **both**:

1. **Revert the app:** redeploy the previous Vercel build (`e85a377c`) so live code
   calls the 1-arg shape again.
2. **Restore the old signatures:** apply the inverse SQL — drop the new signatures
   and re-create the `20261192000000` definitions:
   ```sql
   drop function if exists public.certify_valuation(uuid, uuid);
   drop function if exists public.generate_valuation_invoice(uuid, uuid, date);
   -- then re-run the certify_valuation(uuid) + generate_valuation_invoice(uuid,date)
   -- bodies + grants + comments exactly as in 20261192000000.
   ```
   (Ship this as a forward rollback migration `20261268000000`, not a history edit —
   migrations are forward-only.)
3. Order on rollback is the inverse: revert app first (so no live code needs the new
   sig), then restore old signatures.
4. **Last resort only** (catastrophic, unrelated): restore from the §4.3 backup —
   not expected, since the migration writes no data.

## 8. Optional: strict zero-gap (two-phase) variant

If the window in §3 is unacceptable:

- **Phase A migration:** CREATE the new `(…, p_org_id)` signatures **and keep** the
  old ones; deploy the new app (now calling the pinned path). Both exist; new code
  uses the safe one.
- **Phase B migration:** once the new build is fully live, DROP the old signatures.

This removes the window at the cost of a second migration + a short period where the
old (unpinned) signature still exists — acceptable only because the exploit is
currently unreachable (~0 multi-org users). Given the low frequency, §6 (single
migration, tight window) is recommended over this.

---

### Founder decision required
Approve: (a) merge #1019, (b) apply `20261267000000` to prod via §6, (c) the §3
window trade-off (or elect §8). R5 chain re-stamping is **not** part of this
decision.
