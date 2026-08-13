import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isPortalVisible } from "@/lib/site-reports/portal";
import type { CertificateSnapshot } from "@/lib/completion-certificates/snapshot";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

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
type OrderChain = {
  order: (k: string, o: { ascending: boolean }) => OrderChain;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: Row[] | null; error: SupabaseReadError | null }>;
};
type EqChain = {
  eq: (k: string, v: unknown) => EqChain;
  maybeSingle: () => Promise<{ data: Row | null; error: SupabaseReadError | null }>;
  order: (k: string, o: { ascending: boolean }) => OrderChain;
};
type SelChain = { select: (c: string) => EqChain };

const visible = (c: { status: string; portal_published_at: string | null; portal_withdrawn_at: string | null }) =>
  isPortalVisible({ status: c.status, portal_published_at: c.portal_published_at, portal_withdrawn_at: c.portal_withdrawn_at });

const COLS = "id, certificate_number, status, issued_at, snapshot, portal_published_at, portal_withdrawn_at";

export async function loadPortalCertificate(customerId: string, orgId: string, certId: string): Promise<PortalCertificate | null> {
  if (!UUID_RE.test(certId)) return null;
  const admin = createAdminClient();
  const { data, error } = await (admin.from("completion_certificates" as never) as unknown as SelChain)
    .select(COLS)
    .eq("id", certId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  // Loud fail: null means "not yours / not published" (404) — a query failure
  // must not tell the customer their certificate isn't available.
  if (error) throw readFailure("portal certificates: load", error);
  if (!data || !data.snapshot || !visible(data)) return null;
  return data;
}

export async function listPortalCertificates(customerId: string, orgId: string): Promise<PortalCertificate[]> {
  const admin = createAdminClient();
  // F-1: page the FULL set (fetchAllRows over a stable UNIQUE order — issued_at
  // desc, id asc). The bare `.select().eq().eq().eq().order()` here carried no
  // limit/range, so PostgREST silently clamped it at max_rows (1000). This set is
  // the customer's complete certificate list AND one of the four contributors to
  // the documents-library `{documents.length} total` count and the "Download all
  // (zip)" bundle total (portal-bulk-download.ts) — a clamp dropped the oldest
  // certificates from the list, under-counted the total and omitted them from the
  // customer's own ZIP once they crossed 1000 issued certificates.
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      (admin.from("completion_certificates" as never) as unknown as SelChain)
        .select(COLS)
        .eq("customer_id", customerId)
        .eq("org_id", orgId)
        .eq("status", "issued")
        .order("issued_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("portal certificates: list", error);
  return (data ?? []).filter((c) => c.snapshot && visible(c));
}
