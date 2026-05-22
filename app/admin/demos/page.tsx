import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminActivity } from "@/server/services/hq-audit";
import { DemosBoard } from "./_board";
import { DemosFilters } from "./_filters";
import type { DemoRow } from "./_card";
import { toLifecycleStatus } from "@/lib/hq/demo-lifecycle";

/**
 * Demos CRM — HQ-2.
 *
 * Layout = filters toolbar + kanban + side detail panel. The kanban
 * board owns the open/close state for the side panel and the
 * optimistic drag state. The page is a server component that:
 *
 *   1. Reads every demo_request via service-role (the /admin layout
 *      already gates on isSuperAdminEmail).
 *   2. Pulls the per-demo audit timeline ONLY when a `?demo=<id>`
 *      query param tells us which detail panel to render — avoids
 *      issuing N timeline queries on board load.
 *   3. Applies search / status / sort from URL params before handing
 *      data to the client board.
 */

type SP = Promise<{
  q?: string;
  status?: string;
  sort?: string;
  demo?: string;
  error?: string;
  saved?: string;
}>;

export default async function DemosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const admin = createAdminClient();

  const { data: rawDemos } = await admin
    .from("demo_requests")
    .select(
      "id, name, company, email, phone, status, employees, turnover_range, current_systems, preferred_demo_time, notes, source, created_at" as never,
    )
    .order("created_at", { ascending: false });

  const demos = ((rawDemos ?? []) as unknown as DemoRow[]);

  const q = (sp.q ?? "").trim().toLowerCase();
  const statusFilter = (sp.status ?? "").trim();
  const sort = sp.sort ?? "newest";

  const filtered = demos
    .filter((d) => {
      if (!q) return true;
      return (
        d.company.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        d.email.toLowerCase().includes(q) ||
        (d.current_systems ?? "").toLowerCase().includes(q)
      );
    })
    .filter((d) =>
      statusFilter ? toLifecycleStatus(d.status) === statusFilter : true,
    );

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "oldest") return a.created_at < b.created_at ? -1 : 1;
    if (sort === "company") return a.company.localeCompare(b.company);
    return a.created_at < b.created_at ? 1 : -1; // newest default
  });

  const openId = sp.demo ?? null;
  const openDemo = openId
    ? sorted.find((d) => d.id === openId) ??
      demos.find((d) => d.id === openId) ??
      null
    : null;
  const openActivity = openDemo
    ? await listAdminActivity("demo_requests", openDemo.id)
    : [];

  const banner = (() => {
    if (sp.error) return { tone: "err" as const, msg: decodeURIComponent(sp.error) };
    if (sp.saved) return { tone: "ok" as const, msg: prettySaved(sp.saved) };
    return null;
  })();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Demos CRM</h1>
        <p className="mt-1 text-sm text-slate-600">
          Drag a card between columns to move the demo through the pipeline.
          Click <strong>Open</strong> on any card for contact actions, notes,
          and the full audit timeline.
        </p>
      </header>

      <DemosFilters initialCount={filtered.length} />

      {banner ? (
        <div
          role={banner.tone === "err" ? "alert" : "status"}
          className={
            banner.tone === "err"
              ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          }
        >
          {banner.msg}
        </div>
      ) : null}

      <DemosBoard
        demos={sorted}
        openId={openId}
        openDemo={openDemo}
        openActivity={openActivity}
      />
    </div>
  );
}

function prettySaved(saved: string): string {
  const s = decodeURIComponent(saved);
  if (s === "note") return "Note added.";
  if (s === "scheduled") return "Scheduled — demo moved to Booked.";
  return `Moved to ${s.replace(/_/g, " ")}.`;
}
