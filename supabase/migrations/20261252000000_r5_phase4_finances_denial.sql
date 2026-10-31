-- ============================================================================
-- R5 Phase 4 (slice 2) — finances read denial for staff.
-- ============================================================================
-- The cost LEDGER (finances: amounts, VAT, supplier bills, PO costs) is barred
-- from non-admin staff. The app already gates the finances page with
-- requireCapability("costs","view") (owner full; admin only if granted) and its
-- own comment states "RLS remains the floor" — but the base-table SELECT policy
-- was still org-wide, so a staff member could read the whole ledger directly via
-- the Data API. This narrows SELECT to is_org_admin, making RLS the real floor.
--
-- COST ENTRY IS PRESERVED. INSERT/UPDATE/DELETE policies are UNCHANGED. The one
-- write path that reads its row back (approveExpenseDraft →
-- server/services/expense-drafts.ts, an owner/admin approval action that does
-- `insert(finances).select("id")`) runs as an admin, so the RETURNING read still
-- passes under the narrowed SELECT. Staff cost capture is the expense_drafts
-- submission flow (a separate table, unchanged), not a direct finances read.
--
-- NOT stock_movements: deliberately left to its own slice. stock_movements is
-- BOTH commercial (it carries unit cost / valuation) AND operational (quantity
-- on hand, which staff legitimately see), so a blanket admin-only SELECT would
-- over-restrict legitimate stock visibility and could break goods-received
-- confirmation read-backs. The right fix is column-level (mask cost/valuation)
-- or a staff-safe quantities view — a design decision, not a timed narrowing.
--
-- LOCKOUT ANALYSIS: owners/admins unaffected (is_org_admin). Only non-admin
-- staff lose the direct ledger read — the intended Phase 4 tightening.
-- ROLLBACK: recreate with `using (org_id in (select current_org_ids()))`.
-- ============================================================================

drop policy if exists "finances: members can select" on public.finances;
create policy "finances: members can select" on public.finances
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));
