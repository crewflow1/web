import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { Badge, Breadcrumb } from "@/components/ui";
import type { Tone } from "@/components/ui";
import { JobTabs } from "./_job-tabs";

/**
 * Job workspace shell (product UX rebuild — object-centric job).
 *
 * Wraps every job route (`/jobs/[id]` and its sub-pages) in one persistent
 * workspace: a context header (breadcrumb → job identity → status) and the tab
 * bar, so a user opens a job once and operates it from tabs instead of leaving
 * to scattered links. Presentation only — it adds chrome around the existing
 * pages and changes no job logic. The identity line is deliberately NOT an <h1>
 * (each page keeps its own single <h1>), and the header read is a small,
 * org-pinned, RLS-scoped query.
 */

type JobHeader = {
  status: string | null;
  site_address_line1: string | null;
  site_city: string | null;
  site_postcode: string | null;
  customers: { name: string } | { name: string }[] | null;
};

const STATUS: Record<string, { tone: Tone; label: string }> = {
  new: { tone: "blue", label: "New" },
  "in-progress": { tone: "amber", label: "In progress" },
  completed: { tone: "emerald", label: "Completed" },
  blocked: { tone: "red", label: "Blocked" },
};

export default async function JobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const res = await (
    supabase.from("jobs" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: JobHeader | null }>;
          };
        };
      };
    }
  )
    .select("status, site_address_line1, site_city, site_postcode, customers(name)")
    .eq("id", id)
    // ACTIVE-org pin — self-scoping read (matches the job page's pattern).
    .eq("org_id", ctx.org.id)
    .maybeSingle();

  const job = res.data;
  const customerName = job
    ? Array.isArray(job.customers)
      ? job.customers[0]?.name
      : job.customers?.name
    : undefined;

  const title =
    job?.site_address_line1?.trim() || customerName || "Job";
  const subtitleParts = [customerName, job?.site_city, job?.site_postcode].filter(
    (p): p is string => Boolean(p) && p !== title,
  );
  const status = job?.status ? STATUS[job.status] : undefined;

  return (
    <div>
      <div className="mb-4">
        <Breadcrumb
          items={[{ label: "Projects", href: "/jobs" }, { label: title }]}
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-lg font-semibold text-slate-900">{title}</span>
          {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
          {subtitleParts.length ? (
            <span className="text-sm text-slate-500">
              {subtitleParts.join(" · ")}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mb-6">
        <JobTabs jobId={id} />
      </div>

      {children}
    </div>
  );
}
