-- Security wave S2b — compliance_documents evidence immutability (adversarial-review follow-up).
--
-- The final red-team found that S2 froze tenant_attachments but left its SIBLING evidence
-- table compliance_documents (insurance / permit / contract certificates) freely mutable: a
-- member/admin could direct-PATCH /rest/v1/compliance_documents repointing storage_path to a
-- different object in their OWN org, or rewriting size_bytes/mime_type — silently swapping which
-- file a compliance certificate resolves to, untraced (direct REST bypasses the app's audit
-- trail). Within-tenant (the 20261031 org-path trigger + RLS block cross-tenant), but squarely
-- the evidence-rewrite threat this wave exists to close. The app NEVER UPDATEs this table
-- (upload sets storage_path at INSERT; only select/insert/delete are used), so freezing the
-- evidence-identity columns breaks nothing.
--
-- Mirrors tg_tenant_attachment_evidence_immutable (20261033): a write-once BEFORE UPDATE guard
-- on storage_path / size_bytes / mime_type for EVERY role incl. service_role. Column-scoped —
-- benign edits (title, expires_at, notes) remain allowed. This is an INTEGRITY fix; it does NOT
-- change who may update the row (the member-level UPDATE RLS policy is left as-is — the
-- member-vs-admin question is a separate product decision, deliberately not made here).
--
-- Additive + reversible: one function + one trigger, no schema/data change. Rollback: drop both.

create or replace function public.tg_compliance_document_evidence_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.storage_path is distinct from old.storage_path then
    raise exception 'compliance_documents.storage_path is immutable (document %)', old.id using errcode = 'check_violation';
  end if;
  if old.size_bytes is not null and new.size_bytes is distinct from old.size_bytes then
    raise exception 'compliance_documents.size_bytes is immutable once set (document %)', old.id using errcode = 'check_violation';
  end if;
  if old.mime_type is not null and new.mime_type is distinct from old.mime_type then
    raise exception 'compliance_documents.mime_type is immutable once set (document %)', old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists compliance_documents_immutable_evidence on public.compliance_documents;
create trigger compliance_documents_immutable_evidence
  before update on public.compliance_documents
  for each row execute function public.tg_compliance_document_evidence_immutable();
