import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPortalVisible } from "@/lib/site-reports/portal";
import type { ReportSnapshot } from "@/lib/site-reports/schema";

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

type ListChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        in: (k: string, v: unknown[]) => {
          not: (k: string, op: string, v: unknown) => {
            is: (k: string, v: unknown) => {
              order: (k: string, o: { ascending: boolean }) => {
                limit: (n: number) => Promise<{ data: PortalReportListItem[] | null }>;
              };
            };
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
  const { data } = await (
    admin.from("site_reports" as never) as unknown as ListChain
  )
    .select(
      "id, report_number, title, revision, status, period_start, period_end, issued_at, portal_published_at",
    )
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .in("status", ["issued", "superseded"])
    .not("portal_published_at", "is", null)
    .is("portal_withdrawn_at", null)
    .order("portal_published_at", { ascending: false })
    .limit(200);
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
        ) => { maybeSingle: () => Promise<{ data: (PortalReport & { portal_published_at: string | null; portal_withdrawn_at: string | null }) | null }> };
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
  const { data } = await (
    admin.from("site_reports" as never) as unknown as LoadChain
  )
    .select(
      "id, report_number, title, revision, status, period_start, period_end, issued_at, snapshot, supersedes_id, portal_published_at, portal_withdrawn_at",
    )
    .eq("id", reportId)
    .eq("customer_id", customerId)
    .eq("org_id", orgId)
    .maybeSingle();

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
