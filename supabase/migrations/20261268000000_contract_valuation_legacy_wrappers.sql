-- ============================================================================
-- Active-org pin for valuation RPCs — CONTRACT (drop the legacy wrappers).
-- ============================================================================
-- The EXPAND migration (20261267000000) added the active-org-pinned overloads
-- (p_org_id, …) AND kept the old single-arg / (uuid, date) signatures as thin
-- SECURE wrappers so the pre-pin app build kept working during the rollout. Once
-- the pinned app build is fully live (every caller passes p_org_id), the legacy
-- wrappers are no longer referenced and are removed here so the ONLY remaining
-- signatures are the pinned ones.
--
-- DEPLOY ORDER: apply 20261267000000 → deploy the pinned app build → confirm the
-- old build is fully drained → apply THIS migration. (See the release plan.)
-- Dropping the wrappers has no effect on the pinned overloads.
--
-- IDEMPOTENT + SAFE: drop if exists; the pinned (uuid, uuid) / (uuid, uuid, date)
-- functions are untouched.
-- ROLLBACK (if the legacy path must return): re-create the two wrappers exactly
-- as defined in 20261267000000 (single-org resolve-and-delegate + 42501), as a
-- new forward migration — never a history edit.
-- ============================================================================

drop function if exists public.certify_valuation(uuid);
drop function if exists public.generate_valuation_invoice(uuid, date);
