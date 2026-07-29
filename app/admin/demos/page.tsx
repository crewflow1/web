import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
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
  done?: string;
  failed?: string;
  onboarding_failed?: string;
}>;

export default async function DemosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const admin = createAdminClient();

  const { data: rawDemos, error: demosError } = await admin
    .from("demo_requests")
    .select(
      "id, name, company, email, phone, status, employees, turnover_range, current_systems, preferred_demo_time, notes, source, created_at" as never,
    )
    .order("created_at", { ascending: false });
  if (demosError) {
    throw readFailure("admin demos board: demo_requests", demosError);
  }

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

  // Surface lifecycle outcomes: every status move now also performs the
  // real business operation (email, customer provisioning, etc). Done
  // steps render in an emerald banner, failed steps in a red banner.
  // The activity timeline still has the per-step audit trail.
  const banner = (() => {
    if (sp.error) return { tone: "err" as const, msg: decodeURIComponent(sp.error) };
    // Blocker 2: onboarding is atomic. When provisioning fails the demo is
    // NOT moved — surface a distinct, actionable banner (the generic
    // "moved but N steps failed" message would be misleading because
    // nothing actually moved).
    if (sp.onboarding_failed) {
      const fail = (sp.failed ?? "").trim();
      const detail = fail
        ? ` ${fail.split("|").map((p) => p.trim()).filter(Boolean).slice(0, 2).join(" · ")}`
        : "";
      return {
        tone: "err" as const,
        msg: `Onboarding halted — the customer was NOT activated and no workspace was created. Fix the cause, then click “Move to onboarding” again (it's safe to retry).${detail}`,
      };
    }
    const fail = (sp.failed ?? "").trim();
    if (fail) {
      const lines = fail
        .split("|")
        .map((p) => p.trim())
        .filter(Boolean);
      return {
        tone: "err" as const,
        msg: `Status moved but ${lines.length} step${lines.length === 1 ? "" : "s"} failed — open the demo timeline for details. ${lines.slice(0, 2).join(" · ")}${lines.length > 2 ? "…" : ""}`,
      };
    }
    if (sp.saved) {
      const done = (sp.done ?? "").trim();
      const doneList = done ? done.split(",").filter(Boolean) : [];
      const extra =
        doneList.length > 0
          ? ` (${doneList.map(prettyDoneStep).join(" · ")})`
          : "";
      return {
        tone: "ok" as const,
        msg: `${prettySaved(sp.saved)}${extra}`,
      };
    }
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

const DONE_STEP_LABELS: Record<string, string> = {
  audit_created: "audit logged",
  email_confirmation: "confirmation email sent",
  email_contacted: "contacted email sent",
  email_approved: "approval email sent",
  email_setup_payment: "payment email sent",
  email_payment_received: "receipt email sent",
  email_welcome: "welcome email sent",
  invite_sent: "magic-link sent",
  stripe_checkout_created: "Stripe checkout link created",
  stripe_already_paid: "setup fee already paid (Stripe)",
  payment_marked_paid: "setup fee marked paid",
  auth_user_already_existed: "auth user re-used",
  auth_user_created: "auth user created",
  magic_link_generated: "magic-link generated",
  public_user_created: "user row created",
  org_created: "org created",
  membership_created: "owner membership created",
  demo_linked: "demo linked to org",
  already_provisioned: "already provisioned (idempotent)",
};
function prettyDoneStep(step: string): string {
  return DONE_STEP_LABELS[step] ?? step;
}
