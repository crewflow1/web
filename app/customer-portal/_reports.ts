import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { isPortalVisible } from "@/lib/site-reports/portal";
import type { ReportSnapshot } from "@/lib/site-reports/schema";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Customer-portal reads for Site Reports.
 *
 * The portal has no customer JWT — the caller has ALREADY resolved the URL token
 * to a customer via loadCustomerByPortalToken. These loaders take that resolved
 * customerId + orgId and are the ONLY portal path to reports. Every query filters
 * by BOTH customer_id and org_id (the token-resolved identity) AND the visibility
 * rule (issued/superseded + published + not withdrawn), so:
 *   - guessing a report id for another customer returns nothing (customer filter);
 *   - a draft / approved / unpublished / withdrawn report is never returned;
 *   - only the FROZEN snapshot is exposed — never live source records.
 * isPortalVisible is re-applied in code as defence-in-depth over the SQL filter.
 */

export type PortalReportListItem = {
  id: string;
  report_number: string | null;
  title: string;
  revision: number;
  status: string;
  period_start: string;
  period_end: string;
  issued_at: string | null;
  portal_published_at: string | null;
};

type OrderChain = {
  order: (k: string, o: { ascending: boolean }) => OrderChain;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: PortalReportListItem[] | null; error: SupabaseReadError | null }>;
};
type ListChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        in: (k: string, v: unknown[]) => {
          not: (k: string, op: string, v: unknown) => {
            is: (k: string, v: unknown) => OrderChain;
          };
        };
      };
    };
  };
};

export async function listPortalReports(
  customerId: string,
  orgId: string,
): Promise<PortalReportListItem[]> {
  const admin = createAdminClient();
  // F-1: page the FULL set (fetchAllRows over a stable UNIQUE order —
  // portal_published_at desc, id asc). This feeds the customer's complete report
  // list AND is one of the four contributors to the documents-library
  // `{documents.length} total` count and the "Download all (zip)" bundle total
  // (portal-bulk-download.ts), so the old `.limit(200)` silently dropped the
  // oldest reports from the list, under-counted the total and omitted them from
  // the customer's own ZIP once they crossed 200 published reports.
  const { data, error } = await fetchAllRows<PortalReportListItem>(
    (from, to) =>
      (admin.from("site_reports" as never) as unknown as ListChain)
        .select(
          "id, report_number, title, revision, status, period_start, period_end, issued_at, portal_published_at",
        )
        .eq("customer_id", customerId)
        .eq("org_id", orgId)
        .in("status", ["issued", "superseded"])
        .not("portal_published_at", "is", null)
        .is("portal_withdrawn_at", null)
        .order("portal_published_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("portal reports: list", error);
  // Defence-in-depth: never trust the SQL filter alone for a customer surface.
  return (data ?? []).filter((r) =>
    isPortalVisible({
      status: r.status,
      portal_published_at: r.portal_published_at,
      portal_withdrawn_at: null,
    }),
  );
}

export type PortalReport = {
  id: string;
  report_number: string | null;
  title: string;
  revision: number;
  status: string;
  period_start: string;
  period_end: string;
  issued_at: string | null;
  snapshot: ReportSnapshot | null;
  supersedes_id: string | null;
};

type LoadChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          maybeSingle: () => Promise<{
            data: (PortalReport & { portal_published_at: string | null; portal_withdrawn_at: string | null }) | null;
            error: SupabaseReadError | null;
          }>;
        };
      };
    };
  };
};

export async function loadPortalReport(
  customerId: string,
  orgId: string,
  reportId: string,
): Promise<PortalReport | null> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId)
  ) {
    return null;
  }
  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("site_reports" as never) as unknown as LoadChain
  )
    .select(
      "id, report_number, title, revision, status, period_start, period_end, issued_at, snapshot, supersedes_id, portal_published_at, portal_withdrawn_at",
    )
    .eq("id", reportId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw readFailure("portal reports: load", error);

  if (!data) return null;
  if (
    !isPortalVisible({
      status: data.status,
      portal_published_at: data.portal_published_at,
      portal_withdrawn_at: data.portal_withdrawn_at,
    })
  ) {
    return null;
  }
  return data;
}
