-- Portal completion — general customer file upload.
--
-- The portal_uploads table (20260620000000) already models every file a
-- customer sends through their token: payment_proof, site_photo, signed_doc,
-- message_attachment, other. Until now the ONLY upload surface wired up was
-- payment_proof (against an invoice). We now add a general "send us a file"
-- surface that is NOT tied to an invoice — it anchors to the customer
-- themselves (target_table='customers', target_id = the customer id, both
-- already allowed) and needs its own `kind` so the staff inbox can filter these
-- general submissions apart from payment proofs and the rest.
--
-- ADDITIVE + F-1 SAFE: this only WIDENS the existing kind CHECK to admit one new
-- value. No existing row is touched, no column added/dropped, no data migrated.
-- Every prior value (payment_proof, site_photo, signed_doc, message_attachment,
-- other) is preserved verbatim, so nothing already stored can be invalidated.

alter table public.portal_uploads
  drop constraint if exists portal_uploads_kind_check;

alter table public.portal_uploads
  add constraint portal_uploads_kind_check
  check (kind in (
    'payment_proof',
    'site_photo',
    'signed_doc',
    'message_attachment',
    'customer_file',
    'other'
  ));
