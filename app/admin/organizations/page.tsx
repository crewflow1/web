import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { createAdminClient } from "@/lib/supabase/admin";
import { TURNOVER_LABELS } from "@/lib/demo/schema";
import { setOrganizationStatus, setDemoRequestStatus } from "../actions";
import { ConfirmForm } from "../_confirm-form";
import { AdminFilters } from "../_filters";
import {
  AnimatedNumber,
  GlowHeader,
  Panel,
  StatTile,
  Surface,
} from "@/components/ui";

/**
 * CrewFlow CEO approval dashboard.
 *
 * Unified view of two intake stages:
 *   1. demo_requests — landing-page submissions, pre-signup.
 *   2. organizations — completed signups gated by the access flow.
 *
 * Gated by requireHqPage() (the single HQ page gate). Non-allowlisted
 * users get a 404 (the route's existence isn't leaked).
 *
 * Search / status filter / sort all live in the URL via AdminFilters,
 * so a refresh or shared link preserves the view.
 *
 * Metrics tiles compute MRR + projected MRR from the active and trial
 * org counts × the current £500/mo flat plan price. Once we add a
 * billing table the maths swap out without changing the panel layout.
 */

const MONTHLY_PRICE_GBP = 500;

type SP = Promise<{
  q?: string;
  status?: string;
  sort?: string;
  error?: string;
  saved?: string;
}>;

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  created_at: string;
  status: string;
  plan: string;
  trial_ends_at: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  suspended_at: string | null;
  rejection_reason: string | null;
};

type DemoRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string;
  employees: string | null;
  turnover_range: string | null;
  current_systems: string | null;
  preferred_demo_time: string | null;
  source: string | null;
  status: string;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
};

const STATUS_PILL: Record<string, string> = {
  pending_demo: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  demo_booked: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  pending: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  trial: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30",
  active: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  suspended: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  rejected: "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
  cancelled: "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
};

const STATUS_LABEL: Record<string, string> = {
  pending_demo: "Pending demo",
  demo_booked: "Demo booked",
  approved: "Approved",
  pending: "Pending",
  trial: "Trial",
  active: "Active",
  suspended: "Suspended",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

function matchesQuery(haystacks: (string | null | undefined)[], q: string) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((s) => s && s.toLowerCase().includes(needle));
}

function pendingFirstWeight(status: string): number {
  // Lower number sorts earlier. New demos most urgent; closed states last.
  switch (status) {
    case "pending_demo":
      return 0;
    case "demo_booked":
      return 1;
    case "pending":
      return 2;
    case "approved":
      return 3;
    case "trial":
      return 4;
    case "active":
      return 5;
    case "suspended":
      return 6;
    case "cancelled":
      return 7;
    case "rejected":
      return 8;
    default:
      return 9;
  }
}

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const user = await requireHqPage();

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const statusFilter = (sp.status ?? "").trim();
  const sort = (sp.sort ?? "pending_first").trim();

  const admin = createAdminClient();

  const [orgsRes, demosRes] = await Promise.all([
    admin
      .from("organizations")
      .select(
        "id, name, slug, phone, email, created_at, status, plan, trial_ends_at, approved_at, cancelled_at, suspended_at, rejection_reason" as never,
      )
      .order("created_at", { ascending: false }),
    admin
      .from("demo_requests")
      .select(
        "id, name, email, phone, company, employees, turnover_range, current_systems, preferred_demo_time, source, status, approved_at, rejection_reason, created_at" as never,
      )
      .order("created_at", { ascending: false }),
  ]);

  const orgs = ((orgsRes.data ?? []) as unknown as OrgRow[]);
  const demos = ((demosRes.data ?? []) as unknown as DemoRow[]);

  // Resolve owner email/name per-org via a second query — no relational
  // join across schemas via PostgREST without RLS extras, so do it
  // separately.
  const orgIds = orgs.map((o) => o.id);
  type Ownership = { org_id: string; user: { full_name: string | null; email: string } | null };
  let ownerships: Ownership[] = [];
  if (orgIds.length > 0) {
    const { data } = await admin
      .from("memberships")
      .select("org_id, user:users ( full_name, email )")
      .in("org_id", orgIds)
      .eq("role", "owner");
    ownerships = (data ?? []) as unknown as Ownership[];
  }
  const ownerByOrg = new Map(
    ownerships.map((row) => [
      row.org_id,
      {
        full_name: row.user?.full_name ?? null,
        email: row.user?.email ?? "",
      },
    ]),
  );

  // ------- Metrics (computed off the full unfiltered population) ----
  const pendingDemoCount = demos.filter((d) => d.status === "pending_demo").length;
  const demoBookedCount = demos.filter((d) => d.status === "demo_booked").length;
  const pendingOrgCount = orgs.filter((o) => o.status === "pending").length;
  const trialOrgCount = orgs.filter((o) => o.status === "trial").length;
  const activeOrgCount = orgs.filter((o) => o.status === "active").length;
  const suspendedCount = orgs.filter((o) => o.status === "suspended").length;
  const mrr = activeOrgCount * MONTHLY_PRICE_GBP;
  const projectedMrr = mrr + trialOrgCount * MONTHLY_PRICE_GBP;
  const totalPendingForCeo = pendingDemoCount + pendingOrgCount;

  // ------- Apply search/filter/sort -------------------------------
  const filteredDemos = demos
    .filter((d) =>
      matchesQuery([d.company, d.name, d.email, d.current_systems], q),
    )
    .filter((d) => !statusFilter || d.status === statusFilter);
  const filteredOrgs = orgs
    .filter((o) => {
      const owner = ownerByOrg.get(o.id);
      return matchesQuery([o.name, owner?.full_name, owner?.email], q);
    })
    .filter((o) => !statusFilter || o.status === statusFilter);

  const sortDemos = [...filteredDemos];
  const sortOrgs = [...filteredOrgs];
  if (sort === "newest") {
    sortDemos.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    sortOrgs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } else if (sort === "oldest") {
    sortDemos.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    sortOrgs.sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
  } else {
    sortDemos.sort((a, b) => {
      const w = pendingFirstWeight(a.status) - pendingFirstWeight(b.status);
      return w !== 0 ? w : a.created_at < b.created_at ? 1 : -1;
    });
    sortOrgs.sort((a, b) => {
      const w = pendingFirstWeight(a.status) - pendingFirstWeight(b.status);
      return w !== 0 ? w : a.created_at < b.created_at ? 1 : -1;
    });
  }

  const errorMessage = sp.error
    ? sp.error === "invalid_input"
      ? "Invalid input."
      : sp.error === "update_failed"
        ? "Couldn't update. Try again."
        : sp.error === "demo_not_found"
          ? "That demo request no longer exists."
          : decodeURIComponent(sp.error)
    : null;
  const savedMessage = sp.saved
    ? `Marked ${decodeURIComponent(sp.saved).replace(/^demo_/, "demo: ")}.`
    : null;

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Companies"
        subtitle={
          <>
            Approve, trial, suspend. Signed in as <strong>{user.email}</strong>.
          </>
        }
        actions={
          <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300 ring-1 ring-inset ring-amber-400/30">
            {totalPendingForCeo} awaiting your review
          </span>
        }
      />

      <div className="mx-auto max-w-6xl space-y-6 p-5 sm:p-7">
        {errorMessage ? (
          <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {errorMessage}
          </div>
        ) : null}
        {savedMessage ? (
          <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            {savedMessage}
          </div>
        ) : null}

        {/* Metrics tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Pending demos" value={<AnimatedNumber value={pendingDemoCount} />} sub="ready to review" />
          <StatTile label="Demos booked" value={<AnimatedNumber value={demoBookedCount} />} sub="scheduled" />
          <StatTile label="Trial orgs" value={<AnimatedNumber value={trialOrgCount} />} sub="14-day window" />
          <StatTile label="Active orgs" value={<AnimatedNumber value={activeOrgCount} />} sub="paying" />
          <StatTile
            accent="emerald"
            label="MRR"
            value={<AnimatedNumber value={mrr} format="currency" />}
            sub="active × £500"
          />
          <StatTile
            label="Projected MRR"
            value={<AnimatedNumber value={projectedMrr} format="currency" />}
            sub="active + trial"
          />
        </section>
        {suspendedCount > 0 ? (
          <p className="text-xs text-slate-500">
            {suspendedCount} suspended org{suspendedCount === 1 ? "" : "s"} not shown
            in the totals above — filter by status to see them.
          </p>
        ) : null}

        {/* Filters */}
        <AdminFilters defaultQuery={q} defaultStatus={statusFilter} defaultSort={sort} />

        {/* Demo requests */}
        <Panel
          title={`Demo requests (${sortDemos.length})`}
          action={<span className="text-[11px] text-slate-500">Pre-signup intake</span>}
          bodyClassName="-mx-5 -mb-5"
        >
          {sortDemos.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">
              {q || statusFilter
                ? "No demo requests match the current filter."
                : "No demo requests yet."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {sortDemos.map((d) => (
                <DemoRowItem key={d.id} demo={d} />
              ))}
            </ul>
          )}
        </Panel>

        {/* Organisations */}
        <Panel
          title={`Organisations (${sortOrgs.length})`}
          action={<span className="text-[11px] text-slate-500">Signed-up companies</span>}
          bodyClassName="-mx-5 -mb-5"
        >
          {sortOrgs.length === 0 ? (
            <p className="px-5 py-6 text-sm text-slate-500">
              {q || statusFilter
                ? "No organisations match the current filter."
                : "No organisations yet."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {sortOrgs.map((org) => (
                <OrgRowItem
                  key={org.id}
                  org={org}
                  owner={ownerByOrg.get(org.id) ?? null}
                />
              ))}
            </ul>
          )}
        </Panel>

        <p className="text-center text-xs text-slate-500">
          <Link href="/dashboard" className="transition hover:text-slate-300">
            ← Back to CrewFlow
          </Link>
        </p>
      </div>
    </Surface>
  );
}

function DemoRowItem({ demo }: { demo: DemoRow }) {
  const turnoverLabel =
    demo.turnover_range &&
    TURNOVER_LABELS[demo.turnover_range as keyof typeof TURNOVER_LABELS]
      ? TURNOVER_LABELS[demo.turnover_range as keyof typeof TURNOVER_LABELS]
      : demo.turnover_range ?? "—";

  return (
    <li className="px-5 py-4 hover:bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-white">
              {demo.company}
            </p>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[demo.status] ?? "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40"}`}
            >
              {STATUS_LABEL[demo.status] ?? demo.status}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {demo.name} · {demo.email}
            {demo.phone ? ` · ${demo.phone}` : ""}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400 sm:grid-cols-3">
            <Field label="Created" value={demo.created_at.slice(0, 10)} />
            <Field label="Staff" value={demo.employees ?? "—"} />
            <Field label="Revenue" value={turnoverLabel} />
            <Field
              label="Source"
              value={demo.source ?? "landing"}
            />
            <Field
              label="Preferred time"
              value={demo.preferred_demo_time ?? "—"}
              full
            />
            <Field
              label="Current systems / problem"
              value={demo.current_systems ?? "—"}
              full
            />
          </dl>
          {demo.rejection_reason ? (
            <p className="mt-2 text-[11px] text-rose-300">
              Rejection note: {demo.rejection_reason}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {demo.status === "pending_demo" || demo.status === "demo_booked" ? (
            <ConfirmForm
              action={setDemoRequestStatus}
              buttonLabel={demo.status === "demo_booked" ? "Approve" : "Approve"}
              buttonVariant="primary"
              title="Approve company?"
              body={`Send ${demo.name} (${demo.company}) the approval email. When they sign in at crewflow.uk/login, their workspace will start a 14-day trial.`}
              confirmLabel="Approve & email"
            >
              <input type="hidden" name="demo_id" value={demo.id} />
              <input type="hidden" name="status" value="approved" />
            </ConfirmForm>
          ) : null}
          {demo.status === "pending_demo" ? (
            <ConfirmForm
              action={setDemoRequestStatus}
              buttonLabel="Mark demo booked"
              title="Mark demo booked?"
              body="Logs this demo as scheduled and emails the prospect a confirmation."
              confirmLabel="Mark booked"
            >
              <input type="hidden" name="demo_id" value={demo.id} />
              <input type="hidden" name="status" value="demo_booked" />
            </ConfirmForm>
          ) : null}
          {demo.status !== "rejected" && demo.status !== "cancelled" ? (
            <ConfirmForm
              action={setDemoRequestStatus}
              buttonLabel="Reject"
              buttonVariant="danger"
              title="Reject company?"
              body="Mark this demo request as rejected. The prospect gets a polite email letting them know."
              confirmLabel="Reject"
            >
              <input type="hidden" name="demo_id" value={demo.id} />
              <input type="hidden" name="status" value="rejected" />
              <label className="block text-xs text-slate-400">
                Optional note (sent to the prospect — keep it brief)
                <input
                  type="text"
                  name="reason"
                  maxLength={2000}
                  className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                />
              </label>
            </ConfirmForm>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function OrgRowItem({
  org,
  owner,
}: {
  org: OrgRow;
  owner: { full_name: string | null; email: string } | null;
}) {
  const trialDaysLeft =
    org.status === "trial" && org.trial_ends_at
      ? Math.max(
          0,
          Math.ceil(
            (new Date(org.trial_ends_at).getTime() - Date.now()) /
              86_400_000,
          ),
        )
      : null;

  return (
    <li className="px-5 py-4 hover:bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-white">{org.name}</p>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[org.status] ?? "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40"}`}
            >
              {STATUS_LABEL[org.status] ?? org.status}
              {org.status === "trial" && trialDaysLeft !== null
                ? ` · ${trialDaysLeft}d`
                : ""}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {owner ? `${owner.full_name ?? "—"} · ${owner.email}` : "no owner row"}
            {org.phone ? ` · ${org.phone}` : ""}
            {" · created "}
            {org.created_at.slice(0, 10)}
            {" · plan "}
            <strong>{org.plan}</strong>
          </p>
          {org.rejection_reason ? (
            <p className="mt-1 text-[11px] text-rose-300">
              Rejection note: {org.rejection_reason}
            </p>
          ) : null}
          {org.suspended_at ? (
            <p className="mt-1 text-[11px] text-amber-300">
              Suspended at {org.suspended_at.slice(0, 16).replace("T", " ")}
            </p>
          ) : null}
          {org.cancelled_at ? (
            <p className="mt-1 text-[11px] text-slate-400">
              Cancelled at {org.cancelled_at.slice(0, 16).replace("T", " ")}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {org.status === "pending" ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Approve"
              buttonVariant="primary"
              title="Approve company?"
              body={`Start a 14-day trial for ${org.name}. The owner will be emailed and gain dashboard access immediately.`}
              confirmLabel="Yes, start 14-day trial"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="trial" />
            </ConfirmForm>
          ) : null}
          {org.status === "trial" || org.status === "suspended" || org.status === "cancelled" ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Activate paid"
              buttonVariant="primary"
              title="Activate paid plan?"
              body="Move this workspace from trial / suspended to active paid. The owner is emailed."
              confirmLabel="Activate"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="active" />
            </ConfirmForm>
          ) : null}
          {org.status === "pending" || org.status === "suspended" || org.status === "cancelled" ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Start trial"
              title="Start 14-day trial?"
              body="Owner gets approval email + 14 days of access."
              confirmLabel="Start trial"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="trial" />
            </ConfirmForm>
          ) : null}
          {(org.status === "trial" || org.status === "active") ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Suspend"
              buttonVariant="warning"
              title="Suspend access?"
              body="The owner is bounced to /access-pending immediately. Emails the owner about the suspension."
              confirmLabel="Suspend now"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="suspended" />
            </ConfirmForm>
          ) : null}
          {org.status === "active" || org.status === "trial" || org.status === "suspended" ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Cancel"
              buttonVariant="danger"
              title="Cancel workspace?"
              body="Marks the workspace cancelled. Access is revoked. Owner is emailed."
              confirmLabel="Cancel workspace"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="cancelled" />
            </ConfirmForm>
          ) : null}
          {org.status === "pending" ? (
            <ConfirmForm
              action={setOrganizationStatus}
              buttonLabel="Reject"
              buttonVariant="danger"
              title="Reject company?"
              body="Marks this workspace as rejected. Owner receives an email."
              confirmLabel="Reject"
            >
              <input type="hidden" name="org_id" value={org.id} />
              <input type="hidden" name="status" value="rejected" />
              <label className="block text-xs text-slate-400">
                Optional note (sent to the owner)
                <input
                  type="text"
                  name="reason"
                  maxLength={2000}
                  className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                />
              </label>
            </ConfirmForm>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  full,
}: {
  label: string;
  value: string;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-3" : ""}>
      <dt className="font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="text-slate-300">{value}</dd>
    </div>
  );
}
