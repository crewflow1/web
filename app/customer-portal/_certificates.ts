import { createAdminClient } from "@/lib/supabase/admin";
import { isPortalVisible } from "@/lib/site-reports/portal";
import type { CertificateSnapshot } from "@/lib/completion-certificates/snapshot";

/**
 * Customer-portal completion-certificate reads. Mirrors `_reports.ts`: the portal
 * runs on the RLS-bypassing admin client, so every read is scoped IN CODE by
 * customer_id + org_id and re-checked with `isPortalVisible` (issued + published +
 * not withdrawn). Only the frozen customer-safe snapshot is ever returned.
 */

export type PortalCertificate = {
  id: string;
  certificate_number: string;
  status: string;
  issued_at: string | null;
  snapshot: CertificateSnapshot | null;
  portal_published_at: string | null;
  portal_withdrawn_at: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = PortalCertificate;
type EqChain = {
  eq: (k: string, v: unknown) => EqChain;
  maybeSingle: () => Promise<{ data: Row | null }>;
  order: (k: string, o: { ascending: boolean }) => Promise<{ data: Row[] | null }>;
};
type SelChain = { select: (c: string) => EqChain };

const visible = (c: { status: string; portal_published_at: string | null; portal_withdrawn_at: string | null }) =>
  isPortalVisible({ status: c.status, portal_published_at: c.portal_published_at, portal_withdrawn_at: c.portal_withdrawn_at });

const COLS = "id, certificate_number, status, issued_at, snapshot, portal_published_at, portal_withdrawn_at";

export async function loadPortalCertificate(customerId: string, orgId: string, certId: string): Promise<PortalCertificate | null> {
  if (!UUID_RE.test(certId)) return null;
  const admin = createAdminClient();
  const { data } = await (admin.from("completion_certificates" as never) as unknown as SelChain)
    .select(COLS)
    .eq("id", certId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data || !data.snapshot || !visible(data)) return null;
  return data;
}

export async function listPortalCertificates(customerId: string, orgId: string): Promise<PortalCertificate[]> {
  const admin = createAdminClient();
  const { data } = await (admin.from("completion_certificates" as never) as unknown as SelChain)
    .select(COLS)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .eq("status", "issued")
    .order("issued_at", { ascending: false });
  return (data ?? []).filter((c) => c.snapshot && visible(c));
}
