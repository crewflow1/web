-- ============================================================================
-- R5 Phase 4 (slice 4) — purchase_order_line_items read denial for staff.
-- ============================================================================
-- Migration 20261250 locked the purchase_orders HEADER to is_org_admin, but the
-- commercially-sensitive detail — per-line unit costs, quantities and line
-- totals — lives in purchase_order_line_items, whose SELECT was still org-wide
-- (members-can-select). So staff were denied the PO header yet could still read
-- every PO line's pricing directly. This closes that gap (adversarial-review
-- HIGH): the lines are now admin-only, matching their parent.
-- INSERT/UPDATE/DELETE unchanged. Owners/admins unaffected.
-- ROLLBACK: recreate with `using (org_id in (select current_org_ids()))`.
-- ============================================================================

drop policy if exists "po_line_items: members can select" on public.purchase_order_line_items;
create policy "po_line_items: members can select" on public.purchase_order_line_items
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));
